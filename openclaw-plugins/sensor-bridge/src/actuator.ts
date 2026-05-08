import type { ActuatorCommand } from "./types.js";

/**
 * Best-effort POST to the Python bridge's /cmd endpoint. Failures are logged but
 * never thrown — bridge unavailability must not break the live ingest loop.
 */
export async function sendActuator(
  bridgeUrl: string,
  cmd: ActuatorCommand,
  log: { warn: (msg: string) => void },
): Promise<void> {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 1500);
    const res = await fetch(`${bridgeUrl.replace(/\/$/, "")}/cmd`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(cmd),
      signal: ctrl.signal,
    });
    clearTimeout(t);
    if (!res.ok) {
      log.warn(`actuator POST returned ${res.status}: ${cmd.device}/${cmd.state}`);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.warn(`actuator POST failed: ${msg} (cmd=${cmd.device}/${cmd.state})`);
  }
}
