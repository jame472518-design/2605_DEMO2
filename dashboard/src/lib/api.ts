import { gatewayToken } from "./gatewayToken";

export type ActuatorRequest =
  | { device: "buzzer"; state: "on" | "off"; duration_ms?: number }
  | { device: "led"; state: "on" | "off" | "red" | "green" | "blue"; duration_ms?: number }
  | { device: "servo"; state: "pan" | "tilt"; angle: number };

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

/** POST a still JPEG (data URL or raw base64) to vision-1 for a 1-sentence
 *  Chinese description. Caller renders the result; throws on transport error. */
export async function describeImage(
  imageDataUrl: string,
  sourceLabel: string,
): Promise<{ description: string; took_ms: number }> {
  const token = gatewayToken();
  const url = new URL("/api/vision/describe", window.location.origin);
  if (token) url.searchParams.set("token", token);
  const r = await fetch(url.toString(), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ image_b64: imageDataUrl, source_label: sourceLabel }),
  });
  const data = (await r.json()) as {
    ok?: boolean;
    description?: string;
    took_ms?: number;
    error?: string;
  };
  if (!r.ok || !data.ok || !data.description) {
    throw new Error(data.error ?? `HTTP ${r.status}`);
  }
  return { description: data.description, took_ms: data.took_ms ?? 0 };
}
