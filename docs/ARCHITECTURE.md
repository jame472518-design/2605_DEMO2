# ARCHITECTURE.md — demo2

## 三層

```
┌─────────────────────────────────────────────────────────────┐
│  Hardware                                                    │
│  Arduino @1Hz: DHT22 + PIR + LDR + HC-SR04 → CSV → Serial    │
│  Arduino actuators: Buzzer (D11), RGB LED (D5/6/7)           │
└────────────────────────┬─────────────────────────────────────┘
                         │ USB Serial (9600 baud)
                         │ ↑ ↓ (CSV out, command in)
┌────────────────────────▼─────────────────────────────────────┐
│  Bridge (Python)                                             │
│  - reader thread: serial → parse CSV → POST plugin + INSERT  │
│    SQLite                                                    │
│  - HTTP :8765/cmd: receive actuator JSON → write serial      │
└────────────────────────┬─────────────────────────────────────┘
                         │ HTTP POST /api/sensor/ingest
                         │   ← HTTP POST :8765/cmd
┌────────────────────────▼─────────────────────────────────────┐
│  OpenClaw plugin: sensor-bridge (Node TS)                    │
│  - POST /api/sensor/ingest: validate → SSE broadcast → rules │
│  - GET  /api/sensor/stream (SSE, replayLast=1)               │
│  - GET  /api/alert/stream  (SSE, replayLast=5)               │
│  - POST /api/actuator      (manual override → bridge)        │
│  - GET  /static/*          (dashboard SPA bundle)            │
│  - rules.ts:               (120-frame ring + edge dedup)     │
│  - judge.ts (W2):          (qwen2:1.5b on threshold breach)  │
└────────────────────────┬─────────────────────────────────────┘
                         │ HTTP via OpenClaw gateway :18789
┌────────────────────────▼─────────────────────────────────────┐
│  Dashboard SPA (React + Tailwind + Vite, base="/static/")    │
│  - 5 SensorCards (sparkline, threshold tint)                 │
│  - AlertBanner (severity color, replays last enriched alert) │
│  - JudgePanel  (recent 5 alerts)                             │
│  - ActuatorControls (manual buzzer/LED)                      │
│  - LAN-bound, RWD: phone & desktop same URL                  │
└──────────────────────────────────────────────────────────────┘
```

## Wire schemas

### `POST /api/sensor/ingest` request body
```json
{
  "ts": "2026-05-08T10:23:45.123Z",
  "seq": 1837,
  "temp_c": 24.6,
  "humidity": 58.2,
  "pir": 0,
  "lux_raw": 412,
  "distance_cm": 87.3
}
```

### `GET /api/sensor/stream` SSE messages
Same shape as ingest body; one frame per sample.

### `GET /api/alert/stream` SSE messages
```json
{
  "id": "alert_1715163825_heat_sustained",
  "ts": "2026-05-08T10:23:45.123Z",
  "rule": "heat_sustained",
  "severity": "warn",
  "trigger": { "temp_c": 31.4, "threshold": 30, "window_s": 60 },
  "explanation": null,
  "suggested_action": null,
  "actuator_fired": "buzzer"
}
```
Plugin emits the same `id` twice when judge agent enriches (W2): first with
`explanation: null`, then again with explanation populated. Dashboard de-dups
by id and replaces.

### `POST /api/actuator` (and bridge `:8765/cmd`)
```json
{ "device": "buzzer", "state": "on", "duration_ms": 1500 }
```

## Rules (W1 hardcoded)

Defined in `openclaw-plugins/sensor-bridge/src/rules.ts`:

- `heat_sustained` — `temp_c > 30` for 60s. severity=warn. actuator: buzzer 1.5s.
- `night_intrusion` — `pir == 1 AND lux_raw < 50`. severity=critical. actuator: led red.
- `object_too_close` — `distance_cm < 15` for 3s. severity=info. no actuator.

Rule edge dedup: each rule has an `active` flag. Fires on inactive→active transition; suppresses re-fires while still active; goes inactive when condition false.

W2 will move these to `rules.yaml` for hot-reload.

## Why no LLM in the live loop

DEMO1 used llama3.2:latest in chat → ~7GB resident, KV cache dominated 15.6GB
RAM on Snapdragon X. demo2 is a hardware-showcase + low-RAM proof: rules in
plugin TS run instantly, judge agent (qwen2:1.5b ~1.5GB) is per-event spawn,
not pooled.

Only on threshold breach does sensor-bridge invoke `subagent.run({ sessionKey:
"agent:judge-1:..." })`. The agent's job is single-shot: given anomaly JSON,
return `{explanation, suggested_action}` in Traditional Chinese. Plugin
re-broadcasts the alert with explanation populated. If Ollama is slow or
unavailable, the alert v1 (rule-only) still rendered immediately so the demo
never blocks on LLM.

## Profile isolation

All openclaw invocations use `--profile strixdemo2`. State lives at
`~/.openclaw-strixdemo2/` so this demo doesn't pollute the user's personal
profile.

The single `sensor-bridge` plugin is the entire backend. No `local-web-channel`,
no `observer`, no `document-extract` — those are demo1 concerns.
