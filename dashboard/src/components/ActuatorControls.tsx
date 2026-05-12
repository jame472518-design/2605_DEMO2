import { useCallback, useEffect, useRef, useState } from "react";
import { sendActuator, type ActuatorRequest } from "../lib/api";
import type { SensorFrame } from "../types";

const BUTTONS: Array<{ key: string; label: string; sub: string; req: ActuatorRequest }> = [
  {
    key: "buzz",
    label: "BUZZER",
    sub: "1.5s",
    req: { device: "buzzer", state: "on", duration_ms: 1500 },
  },
  {
    key: "led-red",
    label: "LED",
    sub: "RED",
    req: { device: "led", state: "red" },
  },
  {
    key: "led-green",
    label: "LED",
    sub: "GREEN",
    req: { device: "led", state: "green" },
  },
  {
    key: "led-off",
    label: "LED",
    sub: "OFF",
    req: { device: "led", state: "off" },
  },
];

export function ActuatorControls({ latest }: { latest?: SensorFrame }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lastOk, setLastOk] = useState<string | null>(null);

  async function fire(key: string, req: ActuatorRequest) {
    setBusy(key);
    setError(null);
    try {
      await sendActuator(req);
      setLastOk(key);
      setTimeout(() => setLastOk((k) => (k === key ? null : k)), 1200);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className="hud-frame relative border border-ink-600 bg-ink-900/80 p-4">
      <span className="hud-corner" />
      <div className="flex items-baseline justify-between mb-3">
        <span className="t-meta text-smoke-400">manual override</span>
        <span className="text-[10px] tracking-widest text-smoke-500/70 font-mono">
          POST /api/actuator
        </span>
      </div>
      <div className="grid grid-cols-2 gap-2">
        {BUTTONS.map(({ key, label, sub, req }) => (
          <button
            key={key}
            type="button"
            disabled={busy !== null}
            onClick={() => fire(key, req)}
            className={`group relative border bg-ink-800 disabled:opacity-50 hover:bg-ink-700 transition-colors px-3 py-3 text-left flex items-center justify-between font-mono ${
              lastOk === key
                ? "border-accent-ok/70 text-accent-ok"
                : "border-ink-600 text-smoke-100"
            }`}
          >
            <span className="absolute top-1 left-1 text-[9px] tracking-widest text-smoke-500/70">
              ▸
            </span>
            <div className="flex flex-col leading-tight ml-3">
              <span className="text-sm tracking-widest font-bold">
                {busy === key ? "…" : label}
              </span>
              <span className="text-[10px] tracking-widest text-smoke-500 group-hover:text-smoke-400">
                {sub}
              </span>
            </div>
            <span
              className={`w-1.5 h-1.5 ${lastOk === key ? "bg-accent-ok" : "bg-ink-500"}`}
              aria-hidden
            />
          </button>
        ))}
      </div>
      <ServoControls latest={latest} onError={setError} />
      {error && (
        <p className="mt-3 text-[10px] tracking-widest font-mono text-accent-danger">
          ERR: {error}
        </p>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Servo (pan/tilt) sliders. Read live angles from the latest sensor frame so
// the slider reflects what the ESP32 actually moved to (not just what the
// user requested). Sends are debounced ~120ms — slider drags don't flood the
// actuator endpoint.
// ---------------------------------------------------------------------------

function ServoControls({
  latest,
  onError,
}: {
  latest?: SensorFrame;
  onError: (err: string | null) => void;
}) {
  const livePan = latest?.pan_angle ?? 90;
  const liveTilt = latest?.tilt_angle ?? 90;

  // Local slider state is what the *user* is dragging right now. While the
  // user is interacting (`isDragging`) we don't snap to the live value or the
  // slider would jitter. After release, we let the live value reassert.
  const [pan, setPan] = useState<number>(livePan);
  const [tilt, setTilt] = useState<number>(liveTilt);
  const [drag, setDrag] = useState<"pan" | "tilt" | null>(null);

  useEffect(() => {
    if (drag !== "pan") setPan(livePan);
  }, [livePan, drag]);
  useEffect(() => {
    if (drag !== "tilt") setTilt(liveTilt);
  }, [liveTilt, drag]);

  const sendTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const queueSend = useCallback(
    (axis: "pan" | "tilt", angle: number) => {
      if (sendTimerRef.current) clearTimeout(sendTimerRef.current);
      sendTimerRef.current = setTimeout(async () => {
        try {
          await sendActuator({ device: "servo", state: axis, angle });
          onError(null);
        } catch (e) {
          onError(e instanceof Error ? e.message : String(e));
        }
      }, 120);
    },
    [onError],
  );

  return (
    <div className="mt-4 pt-3 border-t border-ink-700/60">
      <div className="flex items-baseline justify-between mb-2">
        <span className="t-meta text-smoke-400">camera servo</span>
        <span className="text-[10px] tracking-widest text-smoke-500/70 font-mono">
          live: P {livePan.toFixed(0)}° / T {liveTilt.toFixed(0)}°
        </span>
      </div>
      <SliderRow
        label="PAN"
        value={pan}
        live={livePan}
        onInput={(v) => {
          setPan(v);
          setDrag("pan");
          queueSend("pan", v);
        }}
        onRelease={() => setDrag(null)}
      />
      <div className="h-2" />
      <SliderRow
        label="TILT"
        value={tilt}
        live={liveTilt}
        onInput={(v) => {
          setTilt(v);
          setDrag("tilt");
          queueSend("tilt", v);
        }}
        onRelease={() => setDrag(null)}
      />
    </div>
  );
}

function SliderRow({
  label,
  value,
  live,
  onInput,
  onRelease,
}: {
  label: string;
  value: number;
  live: number;
  onInput: (v: number) => void;
  onRelease: () => void;
}) {
  const drifted = Math.abs(value - live) > 2;
  return (
    <div>
      <div className="flex items-center justify-between mb-1">
        <span className="text-[10px] tracking-widest font-mono text-smoke-400">
          {label}
        </span>
        <span
          className={`text-xs tracking-widest font-mono tnum ${
            drifted ? "text-accent-warn" : "text-smoke-100"
          }`}
        >
          {value.toFixed(0)}°
        </span>
      </div>
      <input
        type="range"
        min={0}
        max={180}
        step={1}
        value={value}
        onInput={(e) => onInput(parseInt(e.currentTarget.value, 10))}
        onMouseUp={onRelease}
        onTouchEnd={onRelease}
        onBlur={onRelease}
        className="w-full h-1.5 appearance-none bg-ink-700 cursor-pointer accent-accent-info"
      />
    </div>
  );
}
