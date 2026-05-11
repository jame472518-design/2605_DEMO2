import type { Alert } from "../types";

const SEV_DOT: Record<Alert["severity"], string> = {
  info: "bg-accent-info",
  warn: "bg-accent-warn",
  critical: "bg-accent-danger",
};

const SEV_INK: Record<Alert["severity"], string> = {
  info: "text-accent-info",
  warn: "text-accent-warn",
  critical: "text-accent-danger",
};

function formatTime(ts: string): string {
  try {
    return new Date(ts).toLocaleTimeString("zh-TW", { hour12: false });
  } catch {
    return ts;
  }
}

type Props = { alerts: Alert[] };

export function JudgePanel({ alerts }: Props) {
  return (
    <section className="hud-frame relative border border-ink-600 bg-ink-900/80 p-4">
      <span className="hud-corner" />
      <div className="flex items-baseline justify-between mb-3">
        <span className="t-meta text-smoke-400">incident log</span>
        <span className="text-[10px] tracking-widest text-smoke-500/70 font-mono tnum">
          {alerts.length} ENTRIES
        </span>
      </div>
      {alerts.length === 0 ? (
        <p className="text-xs text-smoke-500 font-mono tracking-wide py-8 text-center border border-dashed border-ink-600">
          NO INCIDENTS RECORDED
        </p>
      ) : (
        <ul className="space-y-3">
          {alerts.map((a) => (
            <li key={a.id} className="text-sm">
              <div className="flex items-center gap-2 mb-1">
                <span
                  className={`flex-shrink-0 w-2 h-2 ${SEV_DOT[a.severity]} ${a.severity === "critical" ? "animate-pulse-dot" : ""}`}
                  aria-hidden
                />
                <span
                  className={`font-mono text-[11px] tracking-widest uppercase ${SEV_INK[a.severity]}`}
                >
                  {a.rule}
                </span>
                <span className="leader text-smoke-500/30" />
                <span className="font-mono text-[10px] tabular-nums text-smoke-500/80">
                  {formatTime(a.ts)}
                </span>
              </div>
              <div className="pl-4 text-smoke-200 font-han text-[13px] leading-relaxed">
                {a.explanation ?? (
                  <span className="text-smoke-500 font-mono text-[11px] tracking-widest italic">
                    awaiting judge…
                  </span>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
