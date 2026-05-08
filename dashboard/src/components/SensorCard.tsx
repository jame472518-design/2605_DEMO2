import type { Severity } from "../types";

type Props = {
  label: string;
  unit?: string;
  value: string;
  history: number[];
  threshold?: { breached: boolean; severity: Severity };
};

function severityColor(severity: Severity | null): string {
  if (severity === "critical") return "border-accent-danger bg-accent-danger/10";
  if (severity === "warn") return "border-accent-warn bg-accent-warn/10";
  if (severity === "info") return "border-accent-info bg-accent-info/10";
  return "border-ink-700 bg-ink-900";
}

function strokeColor(severity: Severity | null): string {
  if (severity === "critical") return "#ef4444";
  if (severity === "warn") return "#f59e0b";
  if (severity === "info") return "#3b82f6";
  return "#10b981";
}

function Sparkline({ data, color }: { data: number[]; color: string }) {
  if (data.length < 2) {
    return <div className="h-12 text-xs text-gray-500 flex items-center">收集中…</div>;
  }
  const w = 240;
  const h = 48;
  const min = Math.min(...data);
  const max = Math.max(...data);
  const range = max - min || 1;
  const step = w / Math.max(1, data.length - 1);
  const points = data
    .map((v, i) => `${(i * step).toFixed(1)},${(h - ((v - min) / range) * h).toFixed(1)}`)
    .join(" ");
  return (
    <svg viewBox={`0 0 ${w} ${h}`} className="h-12 w-full" preserveAspectRatio="none">
      <polyline points={points} fill="none" stroke={color} strokeWidth="1.5" />
    </svg>
  );
}

export function SensorCard({ label, unit, value, history, threshold }: Props) {
  const sev = threshold?.breached ? threshold.severity : null;
  return (
    <div className={`border rounded-lg p-4 transition-colors ${severityColor(sev)}`}>
      <div className="flex items-baseline justify-between">
        <span className="text-sm text-gray-400 uppercase tracking-wide">{label}</span>
        {unit && <span className="text-xs text-gray-500">{unit}</span>}
      </div>
      <div className="mt-2 text-3xl font-mono font-semibold tabular-nums">{value}</div>
      <div className="mt-3">
        <Sparkline data={history} color={strokeColor(sev)} />
      </div>
    </div>
  );
}
