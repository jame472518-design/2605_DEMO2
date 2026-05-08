import { useState, useEffect } from "react";
import type { Alert } from "../types";

const SEVERITY_STYLE: Record<Alert["severity"], string> = {
  info: "bg-accent-info/20 border-accent-info text-accent-info",
  warn: "bg-accent-warn/20 border-accent-warn text-accent-warn",
  critical: "bg-accent-danger/20 border-accent-danger text-accent-danger",
};

const SEVERITY_LABEL: Record<Alert["severity"], string> = {
  info: "提示",
  warn: "警告",
  critical: "危險",
};

type Props = { alert: Alert | null };

export function AlertBanner({ alert }: Props) {
  const [dismissedId, setDismissedId] = useState<string | null>(null);

  useEffect(() => {
    if (alert) setDismissedId(null);
  }, [alert?.id]);

  if (!alert || dismissedId === alert.id) return null;

  return (
    <div
      className={`border-l-4 p-3 mb-4 rounded flex items-start gap-3 ${SEVERITY_STYLE[alert.severity]}`}
      role="alert"
    >
      <div className="flex-shrink-0 font-bold uppercase text-xs tracking-widest mt-0.5">
        {SEVERITY_LABEL[alert.severity]}
      </div>
      <div className="flex-grow text-sm">
        <div className="font-mono text-xs opacity-80">{alert.rule}</div>
        <div className="mt-0.5">
          {alert.explanation ? (
            <span>{alert.explanation}</span>
          ) : (
            <span className="opacity-90">
              {Object.entries(alert.trigger)
                .map(([k, v]) => `${k}=${typeof v === "number" ? v.toFixed(1) : String(v)}`)
                .join(" · ")}
            </span>
          )}
        </div>
        {alert.suggested_action && (
          <div className="mt-1 italic opacity-80">建議:{alert.suggested_action}</div>
        )}
      </div>
      <button
        type="button"
        onClick={() => setDismissedId(alert.id)}
        className="flex-shrink-0 opacity-60 hover:opacity-100 text-lg leading-none"
        aria-label="關閉警報"
      >
        ×
      </button>
    </div>
  );
}
