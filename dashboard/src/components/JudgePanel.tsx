import type { Alert } from "../types";

const SEVERITY_DOT: Record<Alert["severity"], string> = {
  info: "bg-accent-info",
  warn: "bg-accent-warn",
  critical: "bg-accent-danger",
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
    <section className="bg-ink-900 border border-ink-700 rounded-lg p-4">
      <h2 className="text-sm uppercase tracking-wide text-gray-400 mb-3">事件紀錄</h2>
      {alerts.length === 0 ? (
        <p className="text-sm text-gray-500">目前沒有警報。</p>
      ) : (
        <ul className="space-y-2">
          {alerts.map((a) => (
            <li key={a.id} className="text-sm flex items-start gap-2">
              <span
                className={`flex-shrink-0 mt-1.5 w-2 h-2 rounded-full ${SEVERITY_DOT[a.severity]}`}
              />
              <div className="flex-grow">
                <div className="flex items-baseline justify-between gap-2">
                  <span className="font-mono text-xs text-gray-400">{a.rule}</span>
                  <span className="text-xs text-gray-500 tabular-nums">
                    {formatTime(a.ts)}
                  </span>
                </div>
                <div className="mt-0.5 text-gray-200">
                  {a.explanation ?? (
                    <span className="text-gray-500 italic">等待說明…</span>
                  )}
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
