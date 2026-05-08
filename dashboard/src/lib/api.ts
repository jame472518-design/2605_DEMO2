import { gatewayToken } from "./gatewayToken";

export type ActuatorRequest = {
  device: "buzzer" | "led";
  state: string;
  duration_ms?: number;
};

export async function sendActuator(req: ActuatorRequest): Promise<void> {
  const token = gatewayToken();
  const r = await fetch("/api/actuator", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(req),
  });
  if (!r.ok) throw new Error(`actuator ${r.status}: ${await r.text()}`);
}
