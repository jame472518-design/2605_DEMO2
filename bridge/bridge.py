"""
demo2 Python bridge: Arduino serial <-> OpenClaw sensor-bridge plugin.

- Reader thread parses CSV "seq,temp,humidity,pir,lux,distance" from serial
  (or a mock generator), POSTs each frame as JSON to the plugin, and INSERTs
  into a local SQLite log.
- HTTP listener on 127.0.0.1:8765 accepts actuator commands from the plugin
  (POST /cmd) and writes them back to the serial line.

Usage:
    python bridge.py --port COM3
    python bridge.py --mock
    python bridge.py --mock --force-heat
"""

from __future__ import annotations

import argparse
import http.server
import json
import os
import re
import sqlite3
import sys
import threading
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Iterator

import requests

REPO_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_CONFIG = REPO_ROOT / "bridge" / "config.yaml"


# -- Config & token loading ------------------------------------------------

def load_config(path: Path) -> dict:
    """Tiny YAML-subset parser (key: value, top-level only). Avoids PyYAML dep."""
    cfg: dict[str, Any] = {}
    if not path.exists():
        return cfg
    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.split("#", 1)[0].rstrip()
        if not line or ":" not in line:
            continue
        key, _, val = line.partition(":")
        key = key.strip()
        val = val.strip().strip('"').strip("'")
        if val.isdigit():
            cfg[key] = int(val)
        else:
            cfg[key] = val
    return cfg


def read_env_token(env_path: Path) -> str:
    if not env_path.exists():
        raise SystemExit(
            f"ERROR: {env_path} not found. Run scripts/bootstrap-profile.ps1 first."
        )
    for line in env_path.read_text(encoding="utf-8-sig").splitlines():
        m = re.match(r"^\s*OPENCLAW_GATEWAY_TOKEN\s*=\s*(.+)\s*$", line)
        if m:
            return m.group(1).strip().strip('"').strip("'")
    raise SystemExit(f"ERROR: OPENCLAW_GATEWAY_TOKEN not found in {env_path}")


# -- SQLite logging --------------------------------------------------------

SCHEMA = """
CREATE TABLE IF NOT EXISTS sensor_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts TEXT NOT NULL,
    seq INTEGER NOT NULL,
    temp_c REAL,
    humidity REAL,
    pir INTEGER,
    lux_raw INTEGER,
    distance_cm REAL,
    inserted_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_sensor_log_ts ON sensor_log(ts);
"""


def open_db(db_path: Path) -> sqlite3.Connection:
    db_path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(db_path), isolation_level=None, check_same_thread=False)
    conn.executescript(SCHEMA)
    return conn


def insert_frame(conn: sqlite3.Connection, frame: dict) -> None:
    conn.execute(
        "INSERT INTO sensor_log (ts, seq, temp_c, humidity, pir, lux_raw, distance_cm) "
        "VALUES (?, ?, ?, ?, ?, ?, ?)",
        (
            frame["ts"],
            frame["seq"],
            frame["temp_c"],
            frame["humidity"],
            frame["pir"],
            frame["lux_raw"],
            frame["distance_cm"],
        ),
    )


# -- Serial sources --------------------------------------------------------

class SerialSource:
    """Iterator yielding raw CSV lines from a real Arduino over serial."""

    def __init__(self, port: str, baud: int) -> None:
        import serial  # type: ignore[import-not-found]

        self.port = port
        self.ser = serial.Serial(port, baud, timeout=2)
        # Allow Arduino auto-reset on connect to settle
        time.sleep(2)
        print(f"[bridge] opened serial {port}@{baud}", file=sys.stderr)

    def __iter__(self) -> Iterator[str]:
        return self

    def __next__(self) -> str:
        while True:
            raw = self.ser.readline()
            if not raw:
                continue
            line = raw.decode("utf-8", errors="replace").strip()
            if line:
                return line

    def write(self, line: str) -> None:
        self.ser.write((line + "\n").encode("utf-8"))


# -- CSV parsing -----------------------------------------------------------

def parse_csv(line: str, seq_fallback: int) -> dict | None:
    """Parse one CSV line into a SensorFrame dict. Returns None on bad shape."""
    parts = [p.strip() for p in line.split(",")]
    if len(parts) != 6:
        return None
    try:
        seq = int(parts[0])
        temp = float(parts[1])
        hum = float(parts[2])
        pir = int(parts[3])
        lux = int(parts[4])
        dist = float(parts[5])
    except ValueError:
        return None
    if pir not in (0, 1):
        pir = 1 if pir != 0 else 0
    return {
        "ts": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "seq": seq if seq >= 0 else seq_fallback,
        "temp_c": temp,
        "humidity": hum,
        "pir": pir,
        "lux_raw": lux,
        "distance_cm": dist,
    }


# -- Actuator HTTP server --------------------------------------------------

class CmdHandler(http.server.BaseHTTPRequestHandler):
    on_cmd: Callable[[dict], None]

    def do_POST(self) -> None:  # noqa: N802 (BaseHTTPRequestHandler convention)
        if self.path != "/cmd":
            self.send_response(404)
            self.end_headers()
            return
        length = int(self.headers.get("Content-Length", "0"))
        try:
            body = json.loads(self.rfile.read(length))
        except json.JSONDecodeError:
            self.send_response(400)
            self.end_headers()
            return
        try:
            type(self).on_cmd(body)
        except Exception as e:  # noqa: BLE001 — log-and-continue
            print(f"[bridge] cmd handler error: {e}", file=sys.stderr)
            self.send_response(500)
            self.end_headers()
            return
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(b'{"ok":true}')

    def log_message(self, format: str, *args: Any) -> None:  # quieter
        return


def start_cmd_server(host: str, port: int, on_cmd: Callable[[dict], None]) -> None:
    CmdHandler.on_cmd = staticmethod(on_cmd)  # type: ignore[assignment]
    server = http.server.ThreadingHTTPServer((host, port), CmdHandler)
    t = threading.Thread(target=server.serve_forever, daemon=True, name="cmd-server")
    t.start()
    print(f"[bridge] /cmd listening on http://{host}:{port}/cmd", file=sys.stderr)


# -- Main loop -------------------------------------------------------------

def run(args: argparse.Namespace) -> int:
    cfg = load_config(REPO_ROOT / "bridge" / "config.yaml")
    plugin_url = args.plugin_url or cfg.get("plugin_url", "http://127.0.0.1:18789")
    serial_port = args.port or cfg.get("serial_port", "COM3")
    baud = cfg.get("serial_baud", 9600)
    sqlite_path = REPO_ROOT / cfg.get("sqlite_path", "./bridge/sensor-history.db").lstrip("./")
    cmd_host = cfg.get("cmd_host", "127.0.0.1")
    cmd_port = int(cfg.get("cmd_port", 8765))
    env_path = REPO_ROOT / cfg.get("env_path", "./.env.local").lstrip("./")
    token = read_env_token(env_path)

    db = open_db(sqlite_path)
    print(f"[bridge] SQLite log -> {sqlite_path}", file=sys.stderr)

    if args.mock:
        from mock_serial import MockSerial

        source = MockSerial(force_heat=args.force_heat)
        print("[bridge] using MOCK serial source", file=sys.stderr)
    else:
        source = SerialSource(serial_port, baud)

    # Actuator command handler — writes back to serial (or just logs in mock).
    def on_cmd(cmd: dict) -> None:
        device = cmd.get("device", "?")
        state = cmd.get("state", "?")
        duration = cmd.get("duration_ms")
        if device == "buzzer":
            line = f"BUZZER {str(state).upper()}" + (f" {int(duration)}" if duration else "")
        elif device == "led":
            line = f"LED {str(state).upper()}"
        else:
            print(f"[bridge] unknown actuator device: {device}", file=sys.stderr)
            return
        if hasattr(source, "write"):
            source.write(line)
            print(f"[bridge] -> serial: {line}", file=sys.stderr)
        else:
            print(f"[bridge] (mock) ignoring serial write: {line}", file=sys.stderr)

    start_cmd_server(cmd_host, cmd_port, on_cmd)

    ingest_url = plugin_url.rstrip("/") + "/api/sensor/ingest"
    headers = {"Authorization": f"Bearer {token}"}
    sess = requests.Session()
    seq_fallback = 0
    skipped = 0

    print(f"[bridge] streaming -> {ingest_url}", file=sys.stderr)
    for line in source:
        seq_fallback += 1
        frame = parse_csv(line, seq_fallback)
        if frame is None:
            skipped += 1
            if skipped <= 5 or skipped % 50 == 0:
                print(f"[bridge] skipped malformed line ({skipped} total): {line!r}", file=sys.stderr)
            continue
        try:
            insert_frame(db, frame)
        except Exception as e:  # noqa: BLE001
            print(f"[bridge] sqlite write failed: {e}", file=sys.stderr)
        try:
            r = sess.post(ingest_url, json=frame, headers=headers, timeout=2)
            if r.status_code != 200:
                print(f"[bridge] POST {r.status_code}: {r.text[:200]}", file=sys.stderr)
        except requests.RequestException as e:
            print(f"[bridge] POST failed: {e}", file=sys.stderr)
    return 0


def main() -> int:
    p = argparse.ArgumentParser(description="demo2 sensor bridge")
    p.add_argument("--port", help="serial port (e.g. COM3); overrides config.yaml")
    p.add_argument("--plugin-url", help="plugin base URL; overrides config.yaml")
    p.add_argument("--mock", action="store_true", help="use mock serial generator")
    p.add_argument(
        "--force-heat",
        action="store_true",
        help="(mock only) hold temp_c=32 for 70s starting 5s after launch",
    )
    args = p.parse_args()
    if args.force_heat and not args.mock:
        print("[bridge] --force-heat requires --mock", file=sys.stderr)
        return 2
    try:
        return run(args)
    except KeyboardInterrupt:
        print("\n[bridge] stopping", file=sys.stderr)
        return 0


if __name__ == "__main__":
    sys.exit(main())
