import { useEffect, useRef, useState } from "react";
import { gatewayToken } from "./gatewayToken";

/**
 * Subscribe to a server-sent-events endpoint, parsing each `data: ...` payload
 * as JSON via the supplied `parse`. The hook auto-reconnects on close (browser
 * EventSource handles that natively).
 *
 * Usage:
 *   const lastFrame = useSse<SensorFrame>("/api/sensor/stream", JSON.parse);
 */
export function useSse<T>(
  path: string,
  parse: (raw: string) => T,
  onMessage?: (value: T) => void,
): T | null {
  const [latest, setLatest] = useState<T | null>(null);
  const onMessageRef = useRef(onMessage);
  onMessageRef.current = onMessage;

  useEffect(() => {
    const token = gatewayToken();
    const url = new URL(path, window.location.origin);
    if (token) url.searchParams.set("token", token);
    const es = new EventSource(url.toString());
    es.onmessage = (ev) => {
      try {
        const parsed = parse(ev.data);
        setLatest(parsed);
        onMessageRef.current?.(parsed);
      } catch {
        /* ignore malformed frames */
      }
    };
    return () => es.close();
  }, [path, parse]);

  return latest;
}
