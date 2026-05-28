import { useState } from "react";
import type { Alert } from "../types";

const SEV_INK: Record<Alert["severity"], string> = {
  info: "text-accent-info",
  warn: "text-accent-warn",
  critical: "text-accent-danger",
};

// Mirror the AlertBanner severity glyph set so the AGENT LOG reads as a
// continuation of the same visual language (◯ info / ⚠ warn / ⛔ critical).
const SEV_GLYPH: Record<Alert["severity"], string> = {
  info: "◯",
  warn: "⚠",
  critical: "⛔",
};

function formatTime(ts: string): string {
  try {
    return new Date(ts).toLocaleTimeString("zh-TW", { hour12: false });
  } catch {
    return ts;
  }
}

/**
 * Build a HUD-flavored incident code like `#INC-260527-04A`. Same scheme as
 * AlertBanner so the same incident reads identically in the banner and log.
 */
function incidentCode(alert: Alert): string {
  const tail = alert.id.slice(-3).toUpperCase();
  let datePart = "------";
  try {
    const d = new Date(alert.ts);
    const yy = String(d.getFullYear()).slice(-2);
    const mm = String(d.getMonth() + 1).padStart(2, "0");
    const dd = String(d.getDate()).padStart(2, "0");
    datePart = `${yy}${mm}${dd}`;
  } catch {
    /* keep dashes */
  }
  return `#INC-${datePart}-${tail}`;
}

/** Truncate a Chinese explanation to ~24 chars for the collapsed row. */
function truncate(s: string, n = 24): string {
  return s.length > n ? s.slice(0, n) + "…" : s;
}

type Props = { alerts: Alert[] };

export function JudgePanel({ alerts }: Props) {
  // Expanded-row state is keyed by alert.id. A Set keeps the toggling cheap
  // and lets multiple rows be open at once without per-row useState.
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  function toggle(id: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  return (
    <section className="hud-frame relative border border-ink-600 bg-ink-900/80 p-4">
      <span className="hud-corner" />
      <div className="flex items-baseline justify-between mb-3">
        <div className="flex items-baseline gap-2">
          <span className="live-dot self-center" aria-hidden />
          <span className="t-meta text-smoke-200 tracking-hud">AGENT LOG</span>
          <span className="text-[10px] tracking-widest font-mono text-smoke-500/80">
            judge-1 · vision-1
          </span>
        </div>
        <span className="text-[10px] tracking-widest text-smoke-500/70 font-mono tnum">
          {alerts.length} ENTRIES
        </span>
      </div>
      {alerts.length === 0 ? (
        <p className="text-xs text-smoke-500 font-mono tracking-wide py-8 text-center border border-dashed border-ink-600">
          NO INCIDENTS RECORDED
        </p>
      ) : (
        <ul className="space-y-1.5">
          {alerts.map((a, index) => {
            const isOpen = expanded.has(a.id);
            const judgeThinking =
              a.explanation == null && a.suggested_action == null;
            // scene_description being `undefined` means the field hasn't been
            // attached yet — i.e. vision-1 is still working. `null` means the
            // rule didn't have auto_vision (or vision returned nothing) and we
            // shouldn't show a "thinking" placeholder.
            const visionThinking = a.scene_description === undefined;

            return (
              <li
                key={a.id}
                className="animate-stagger-in"
                style={{ animationDelay: `${index * 60}ms` }}
              >
                <button
                  type="button"
                  onClick={() => toggle(a.id)}
                  aria-expanded={isOpen}
                  className="w-full text-left flex items-center gap-2 px-1.5 py-1 hover:bg-ink-800/40 transition-colors"
                >
                  <span
                    className={`flex-shrink-0 text-[13px] leading-none ${SEV_INK[a.severity]} ${a.severity === "critical" ? "animate-pulse-dot" : ""}`}
                    aria-hidden
                  >
                    {SEV_GLYPH[a.severity]}
                  </span>
                  <span
                    className={`font-mono text-[11px] tracking-widest uppercase ${SEV_INK[a.severity]}`}
                  >
                    {a.rule}
                  </span>
                  <span className="font-mono text-[10px] tnum text-accent-info/80">
                    {incidentCode(a)}
                  </span>
                  <span className="font-mono text-[10px] tnum text-smoke-500/80">
                    · {formatTime(a.ts)}
                  </span>
                  <span className="text-smoke-500/40 mx-1">·</span>
                  <span className="flex-1 min-w-0 truncate font-han text-[12px] text-smoke-300">
                    {judgeThinking ? (
                      <span className="italic font-mono text-[11px] tracking-widest text-smoke-500">
                        agent thinking
                        <span className="animate-pulse-dot ml-0.5">⋯</span>
                      </span>
                    ) : (
                      truncate(a.explanation ?? "")
                    )}
                  </span>
                  <span
                    className={`flex-shrink-0 text-smoke-500/70 text-[11px] transition-transform duration-200 ${isOpen ? "rotate-180" : ""}`}
                    aria-hidden
                  >
                    ▾
                  </span>
                </button>

                {isOpen && (
                  <div className="pl-7 pr-2 pt-1.5 pb-2 border-l border-ink-700/60 ml-2 space-y-1.5">
                    <div className="text-smoke-200 font-han text-[13px] leading-relaxed">
                      {a.explanation ?? (
                        <span className="text-smoke-500 font-mono text-[11px] tracking-widest italic">
                          agent thinking
                          <span className="animate-pulse-dot ml-0.5">⋯</span>
                        </span>
                      )}
                    </div>
                    {a.suggested_action && (
                      <div className="text-smoke-400 font-han text-xs leading-relaxed">
                        <span
                          className="font-mono text-accent-info/80 mr-1.5"
                          aria-hidden
                        >
                          ▸
                        </span>
                        {a.suggested_action}
                      </div>
                    )}
                    {a.scene_description ? (
                      <div className="text-smoke-400 font-han text-xs leading-relaxed">
                        <span className="text-[10px] tracking-widest font-mono text-accent-info/80 mr-1.5">
                          👁
                        </span>
                        {a.scene_description}
                      </div>
                    ) : visionThinking ? (
                      <div className="text-smoke-500 font-mono text-[11px] tracking-widest italic">
                        <span className="mr-1.5" aria-hidden>
                          👁
                        </span>
                        vision thinking
                        <span className="animate-pulse-dot ml-0.5">⋯</span>
                      </div>
                    ) : null}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
