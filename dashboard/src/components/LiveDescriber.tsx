import { useEffect, useState } from "react";

/**
 * LiveDescriber - displays vision-1 SCAN results on the right of the camera.
 *
 * Subscribes to window "vision-result" CustomEvents dispatched by CameraCard
 * whenever a SCAN succeeds (from IRIS-01 ESP32 capture or LENS webcam grab).
 * Latest result big at top, history of the last 5 fades below.
 *
 * No auto-loop, no polling, no Ollama calls - purely a display panel.
 * SCAN trigger lives on the camera (left).
 */

type Entry = {
  id: string;
  description: string;
  source: string;
  tookMs: number;
  ts: number;
};

type VisionResultDetail = {
  description: string;
  source: string;
  took_ms: number;
  ts: number;
};

const MAX_HISTORY = 6;

export function LiveDescriber() {
  const [entries, setEntries] = useState<Entry[]>([]);

  useEffect(() => {
    const handler = (ev: Event) => {
      const detail = (ev as CustomEvent<VisionResultDetail>).detail;
      if (!detail || typeof detail.description !== "string") return;
      setEntries((prev) => {
        const next: Entry[] = [
          {
            id: Math.random().toString(36).slice(2, 10),
            description: detail.description,
            source: detail.source ?? "AGENT",
            tookMs: detail.took_ms ?? 0,
            ts: detail.ts ?? Date.now(),
          },
          ...prev,
        ];
        return next.slice(0, MAX_HISTORY);
      });
    };
    window.addEventListener("vision-result", handler);
    return () => window.removeEventListener("vision-result", handler);
  }, []);

  const latest = entries[0];

  return (
    <div className="hud-frame relative border border-ink-600 bg-ink-900/85 backdrop-blur-[1px] p-4 md:p-5 flex flex-col h-full min-h-[280px] text-accent-info">
      <span className="hud-corner" />

      {/* Header */}
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          <span
            className={`w-1.5 h-1.5 ${latest ? "bg-accent-info animate-breathe" : "bg-smoke-500"}`}
          />
          <span className="t-meta">
            <span className="text-accent-info mr-1.5">VISION-1</span>
            {latest ? `· ${entries.length} SCAN${entries.length > 1 ? "S" : ""}` : "· STANDBY"}
          </span>
        </div>
        {latest && (
          <span className="font-mono text-[11px] text-smoke-500 tracking-widest tnum">
            {(latest.tookMs / 1000).toFixed(1)}s
          </span>
        )}
      </div>

      {/* Latest big */}
      <div className="flex-1 flex flex-col min-h-0">
        {latest ? (
          <>
            <div className="font-mono text-[10px] tracking-widest text-accent-info mb-2">
              <span className="mr-2">👁</span>
              {latest.source}
              <span className="text-smoke-500 mx-2">·</span>
              <span className="text-smoke-500 tnum">
                {new Date(latest.ts).toLocaleTimeString("zh-TW", { hour12: false })}
              </span>
            </div>
            <div
              key={latest.id}
              className="font-han text-smoke-50 text-base md:text-lg leading-relaxed animate-stagger-in"
            >
              {latest.description}
            </div>

            {entries.length > 1 && (
              <div className="mt-5 pt-4 border-t border-ink-700">
                <div className="t-meta text-smoke-500 mb-3">HISTORY</div>
                <ul className="space-y-2">
                  {entries.slice(1).map((e, i) => (
                    <li
                      key={e.id}
                      className="font-han text-smoke-300 text-sm leading-relaxed"
                      style={{ opacity: Math.max(0.4, 0.85 - i * 0.12) }}
                    >
                      <span className="t-meta text-smoke-500 mr-2 tnum">
                        {new Date(e.ts).toLocaleTimeString("zh-TW", {
                          hour: "2-digit",
                          minute: "2-digit",
                          second: "2-digit",
                          hour12: false,
                        })}
                      </span>
                      {e.description}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </>
        ) : (
          <div className="flex-1 flex flex-col items-center justify-center text-center px-4">
            <div className="text-5xl opacity-30 mb-3">👁</div>
            <div className="t-meta text-smoke-400 mb-2">NO SCAN YET</div>
            <div className="font-han text-smoke-500 text-sm leading-relaxed max-w-xs">
              點左邊鏡頭右上角的「👁 SCAN」按鈕,vision-1 會描述當下畫面,結果出現在這裡。
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
