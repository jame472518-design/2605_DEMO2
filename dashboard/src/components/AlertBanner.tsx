import { useState, useEffect } from "react";
import type { Alert } from "../types";

const SEVERITY_STYLE: Record<Alert["severity"], string> = {
  info: "border-accent-info/80 text-accent-info",
  warn: "border-accent-warn/80 text-accent-warn",
  critical: "border-accent-danger/80 text-accent-danger animate-pulse-danger",
};

const SEVERITY_TAG: Record<Alert["severity"], string> = {
  info: "INFO",
  warn: "WARN",
  critical: "CRIT",
};

const SEVERITY_LABEL: Record<Alert["severity"], string> = {
  info: "提示",
  warn: "警告",
  critical: "危險",
};

const SEVERITY_GLYPH: Record<Alert["severity"], string> = {
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
 * Build a HUD-flavored incident code like `#INC-260527-04A`.
 * Date portion derives from the alert timestamp (yymmdd); the trailing 3 hex
 * chars are just the tail of `alert.id` upper-cased — purely visual, no parse.
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

type Props = { alert: Alert | null };

export function AlertBanner({ alert }: Props) {
  const [dismissedId, setDismissedId] = useState<string | null>(null);

  useEffect(() => {
    if (alert) setDismissedId(null);
  }, [alert?.id]);

  if (!alert || dismissedId === alert.id) return null;

  const isCritical = alert.severity === "critical";

  return (
    <div
      className={`hud-frame relative border bg-ink-900/90 backdrop-blur-[1px] mb-4 md:mb-5 animate-slide-down ${SEVERITY_STYLE[alert.severity]} ${isCritical ? "ribbon-edge" : ""}`}
      role="alert"
    >
      <span className="hud-corner" />
      <div className="flex items-stretch">
        {/* left severity tag block */}
        <div className="flex-shrink-0 flex flex-col items-center justify-center px-4 py-3 border-r border-current/40 min-w-[64px]">
          <span className="text-2xl leading-none mb-1" aria-hidden="true">
            {SEVERITY_GLYPH[alert.severity]}
          </span>
          <span className="text-[10px] tracking-hud font-mono font-bold">
            {SEVERITY_TAG[alert.severity]}
          </span>
          <span className="text-[10px] tracking-widest text-current/70 mt-0.5">
            {SEVERITY_LABEL[alert.severity]}
          </span>
        </div>

        {/* body */}
        <div className="flex-1 px-4 py-3 min-w-0">
          <div className="flex items-baseline gap-3 mb-1.5 flex-wrap">
            <span className="t-meta font-mono text-accent-info tnum">
              {incidentCode(alert)}
            </span>
            <span className="text-[10px] tracking-widest uppercase font-mono text-current/80">
              rule
            </span>
            <span className="font-mono text-sm text-current font-bold tracking-wide">
              {alert.rule}
            </span>
            <span className="ml-auto text-[10px] tracking-widest font-mono text-current/60 tnum">
              {formatTime(alert.ts)}
            </span>
          </div>
          <div className="text-smoke-100 font-han text-sm md:text-[15px] leading-relaxed">
            {alert.explanation ? (
              <span>{alert.explanation}</span>
            ) : (
              <span className="text-smoke-400 font-mono text-xs tracking-wide">
                {Object.entries(alert.trigger ?? {})
                  .map(
                    ([k, v]) =>
                      `${k}=${typeof v === "number" ? v.toFixed(1) : String(v)}`,
                  )
                  .join("  ·  ")}
              </span>
            )}
          </div>
          {alert.suggested_action && (
            <div className="mt-1.5 text-smoke-400 font-han text-xs md:text-sm">
              <span
                className="font-mono text-current/80 mr-2"
                aria-hidden="true"
              >
                ▸
              </span>
              {alert.suggested_action}
            </div>
          )}
          {alert.scene_description && (
            <div className="mt-2 pt-2 border-t border-current/20 text-smoke-300 font-han text-xs md:text-sm">
              <span className="text-[10px] tracking-widest font-mono text-accent-info mr-2">
                👁 SCENE
              </span>
              {alert.scene_description}
              {typeof alert.scene_took_ms === "number" && (
                <span className="ml-2 text-[10px] tracking-widest font-mono text-smoke-500/70">
                  ({(alert.scene_took_ms / 1000).toFixed(1)}s)
                </span>
              )}
            </div>
          )}
        </div>

        {/* dismiss */}
        <button
          type="button"
          onClick={() => setDismissedId(alert.id)}
          className="flex-shrink-0 w-10 flex items-center justify-center text-current/60 hover:text-current/100 hover:bg-current/5 border-l border-current/40 transition-colors"
          aria-label="關閉警報"
        >
          ✕
        </button>
      </div>
      {isCritical && (
        <div
          className="absolute inset-x-0 bottom-0 h-px border-energize text-accent-danger"
          aria-hidden="true"
        />
      )}
    </div>
  );
}
