import { useEffect, useRef, useState } from "react";
import { describeImage } from "../lib/api";
import { gatewayToken } from "../lib/gatewayToken";

/**
 * LiveDescriber — auto-runs the vision-1 agent against the live camera frame
 * on a fixed interval, displays the latest description big at the top and a
 * scrolling history of older descriptions below.
 *
 * Capture path: /api/esp32/capture (single JPEG, port 80) — separate from the
 * MJPEG stream slot on port 81, so it doesn't interfere with LiveCamera.
 *
 * The single inFlightRef guard prevents stacking calls if the vision agent
 * is slower than the tick interval (likely on Surface; not an issue on the
 * Strix Halo, where 3-5s is typical for qwen2.5vl:3b).
 */

type Entry = {
  id: string;
  text: string;
  ts: number;
  tookMs: number;
};

const INTERVAL_MS = 12_000;
const MAX_HISTORY = 6;

async function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

export function LiveDescriber() {
  const [entries, setEntries] = useState<Entry[]>([]);
  const [thinking, setThinking] = useState(false);
  const [paused, setPaused] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inFlightRef = useRef(false);

  useEffect(() => {
    if (paused) return;

    const tick = async () => {
      if (inFlightRef.current) return;
      inFlightRef.current = true;
      setThinking(true);
      setError(null);
      try {
        const token = gatewayToken();
        const url = new URL("/api/esp32/capture", window.location.origin);
        if (token) url.searchParams.set("token", token);
        const r = await fetch(url.toString());
        if (!r.ok) throw new Error(`camera ${r.status}`);
        const blob = await r.blob();
        const dataUrl = await blobToDataUrl(blob);
        const reply = await describeImage(dataUrl, "LIVE-AUTO");
        setEntries((prev) => {
          const next: Entry[] = [
            {
              id: Math.random().toString(36).slice(2, 10),
              text: reply.description,
              ts: Date.now(),
              tookMs: reply.took_ms,
            },
            ...prev,
          ];
          return next.slice(0, MAX_HISTORY);
        });
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setThinking(false);
        inFlightRef.current = false;
      }
    };

    void tick();
    const id = window.setInterval(() => void tick(), INTERVAL_MS);
    return () => window.clearInterval(id);
  }, [paused]);

  const latest = entries[0];

  return (
    <div className="card hud-frame relative bg-ink-900/85 backdrop-blur-[1px] p-6 md:p-8 flex flex-col min-h-[400px] lg:min-h-[88vh] text-accent-info">
      <span className="hud-corner" />

      {/* Status header */}
      <div className="flex items-center justify-between mb-5">
        <div className="flex items-center gap-2">
          {thinking ? (
            <span className="live-dot" />
          ) : paused ? (
            <span className="w-1.5 h-1.5 bg-smoke-500" />
          ) : (
            <span className="w-1.5 h-1.5 bg-accent-ok animate-breathe" />
          )}
          <span className="t-meta">
            {thinking
              ? "AGENT ANALYZING"
              : paused
                ? "PAUSED"
                : `LIVE · ${INTERVAL_MS / 1000}s INTERVAL`}
          </span>
        </div>
        <button
          type="button"
          onClick={() => setPaused((p) => !p)}
          className="inline-flex items-center gap-1.5 border border-ink-600 hover:border-smoke-500 text-smoke-300 hover:text-smoke-100 px-2.5 py-1 font-mono text-[11px] tracking-widest transition-colors"
        >
          {paused ? "▶ RESUME" : "⏸ PAUSE"}
        </button>
      </div>

      {/* Latest big */}
      <div className="flex-1 flex flex-col min-h-0">
        {latest ? (
          <>
            <div
              key={latest.id}
              className="font-han text-smoke-50 text-xl md:text-2xl leading-relaxed mb-3 animate-stagger-in"
            >
              {latest.text}
            </div>
            <div className="font-mono text-[11px] text-smoke-500 tracking-widest tnum">
              {new Date(latest.ts).toLocaleTimeString("zh-TW", {
                hour12: false,
              })}
              <span className="mx-2">·</span>
              {(latest.tookMs / 1000).toFixed(1)}s
              <span className="mx-2">·</span>
              vision-1
            </div>
          </>
        ) : thinking ? (
          <div className="font-han text-smoke-400 text-base animate-breathe">
            分析第一張影像…
          </div>
        ) : error ? (
          <div className="font-han text-accent-danger text-sm">
            無法擷取畫面:
            <span className="font-mono text-xs ml-2">{error}</span>
          </div>
        ) : (
          <div className="font-han text-smoke-500">等待 IRIS-01 連線…</div>
        )}

        {/* History */}
        {entries.length > 1 && (
          <div className="mt-6 pt-4 border-t border-ink-700">
            <div className="t-meta text-smoke-500 mb-3">HISTORY</div>
            <ul className="space-y-3 overflow-y-auto">
              {entries.slice(1).map((e, i) => (
                <li
                  key={e.id}
                  className="font-han text-smoke-300 text-sm leading-relaxed"
                  style={{ opacity: Math.max(0.35, 0.85 - i * 0.12) }}
                >
                  <span className="t-meta text-smoke-500 mr-2 tnum">
                    {new Date(e.ts).toLocaleTimeString("zh-TW", {
                      hour: "2-digit",
                      minute: "2-digit",
                      second: "2-digit",
                      hour12: false,
                    })}
                  </span>
                  {e.text}
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </div>
  );
}
