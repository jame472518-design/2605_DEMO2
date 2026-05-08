import { useState } from "react";
import { sendActuator, type ActuatorRequest } from "../lib/api";

const BUTTONS: Array<{ label: string; req: ActuatorRequest }> = [
  { label: "蜂鳴器 1.5s", req: { device: "buzzer", state: "on", duration_ms: 1500 } },
  { label: "LED 紅", req: { device: "led", state: "red" } },
  { label: "LED 綠", req: { device: "led", state: "green" } },
  { label: "LED 關", req: { device: "led", state: "off" } },
];

export function ActuatorControls() {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function fire(label: string, req: ActuatorRequest) {
    setBusy(label);
    setError(null);
    try {
      await sendActuator(req);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className="bg-ink-900 border border-ink-700 rounded-lg p-4">
      <h2 className="text-sm uppercase tracking-wide text-gray-400 mb-3">手動控制</h2>
      <div className="flex flex-wrap gap-2">
        {BUTTONS.map(({ label, req }) => (
          <button
            key={label}
            type="button"
            disabled={busy !== null}
            onClick={() => fire(label, req)}
            className="px-3 py-1.5 text-sm bg-ink-800 hover:bg-ink-700 disabled:opacity-50 border border-ink-700 rounded font-mono"
          >
            {busy === label ? "…" : label}
          </button>
        ))}
      </div>
      {error && <p className="mt-2 text-xs text-accent-danger">{error}</p>}
    </section>
  );
}
