import { gatewayToken } from "./gatewayToken";

// ---------------------------------------------------------------------------
// Mock ingest controller — backend can synthesise sensor frames when no
// ESP32 is on the LAN. Three modes:
//   - auto:  plugin emits mock frames only when no real ESP32 has reported
//            recently (is_emitting flips true/false based on liveness)
//   - force: plugin always emits mock frames, overriding real data
//   - off:   no mock frames; cards stay empty if no ESP32 is alive
// ---------------------------------------------------------------------------

export type MockMode = "auto" | "force" | "off";

export type MockStatus = {
  mode: MockMode;
  is_emitting: boolean;
};

export async function getMockMode(): Promise<MockStatus> {
  const token = gatewayToken();
  const url = new URL("/api/dev/mock", window.location.origin);
  if (token) url.searchParams.set("token", token);
  const r = await fetch(url.toString(), {
    headers: token ? { Authorization: `Bearer ${token}` } : undefined,
  });
  if (!r.ok) throw new Error(`getMockMode ${r.status}: ${await r.text()}`);
  return (await r.json()) as MockStatus;
}

export async function setMockMode(mode: MockMode): Promise<{ ok: true; mode: MockMode }> {
  const token = gatewayToken();
  const url = new URL("/api/dev/mock", window.location.origin);
  if (token) url.searchParams.set("token", token);
  const r = await fetch(url.toString(), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ mode }),
  });
  if (!r.ok) throw new Error(`setMockMode ${r.status}: ${await r.text()}`);
  return (await r.json()) as { ok: true; mode: MockMode };
}

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

// ---------------------------------------------------------------------------
// VLM multi-turn chat — streaming NDJSON from /api/vlm/chat. Each line is an
// Ollama chat chunk; the consumer awaits the async generator and accumulates
// `message.content` into the current assistant turn.
// ---------------------------------------------------------------------------

export type VlmTurn = {
  role: "user" | "assistant";
  content: string;
  images?: string[];
};

export type OllamaChatChunk = {
  model?: string;
  message?: { role?: string; content: string };
  done: boolean;
  total_duration?: number;
  eval_count?: number;
  error?: string;
};

export type VlmChatRequest = {
  model?: string;
  prompt: string;
  image_b64?: string;
  history?: VlmTurn[];
};

export async function* streamVlmChat(
  req: VlmChatRequest,
  signal: AbortSignal,
): AsyncGenerator<OllamaChatChunk, void, void> {
  const token = gatewayToken();
  const url = new URL("/api/vlm/chat", window.location.origin);
  if (token) url.searchParams.set("token", token);
  const r = await fetch(url.toString(), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(req),
    signal,
  });
  if (!r.ok) {
    // Try to surface server-side error JSON if it sent one
    let bodyText = "";
    try {
      bodyText = await r.text();
    } catch {
      /* ignore */
    }
    throw new Error(`/api/vlm/chat HTTP ${r.status}${bodyText ? ": " + bodyText.slice(0, 240) : ""}`);
  }
  if (!r.body) {
    throw new Error("/api/vlm/chat: response has no body");
  }
  const reader = r.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let nl = buf.indexOf("\n");
      while (nl >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (line) {
          try {
            yield JSON.parse(line) as OllamaChatChunk;
          } catch {
            // Forward an error chunk so the caller can decide; corrupt lines
            // are rare but shouldn't kill the whole stream.
            yield { done: false, error: `parse error: ${line.slice(0, 120)}` };
          }
        }
        nl = buf.indexOf("\n");
      }
    }
    // flush remainder
    const tail = (buf + decoder.decode()).trim();
    if (tail) {
      try {
        yield JSON.parse(tail) as OllamaChatChunk;
      } catch {
        yield { done: false, error: `parse error: ${tail.slice(0, 120)}` };
      }
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      /* ignore */
    }
  }
}
