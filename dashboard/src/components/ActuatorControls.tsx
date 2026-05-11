import { useState } from "react";
import { sendActuator, type ActuatorRequest } from "../lib/api";

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

export function ActuatorControls() {
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
      {error && (
        <p className="mt-3 text-[10px] tracking-widest font-mono text-accent-danger">
          ERR: {error}
        </p>
      )}
    </section>
  );
}
