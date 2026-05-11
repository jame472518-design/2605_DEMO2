import type { Severity } from "../types";

type Props = {
  /** Slot identifier shown top-right, e.g. "01"…"05" */
  slot: string;
  label: string;
  unit?: string;
  value: string;
  history: number[];
  threshold?: { breached: boolean; severity: Severity };
  /** Optional descriptor printed under the sparkline (e.g. "> 32°C 60s") */
  rule?: string;
};

const SEV_INK: Record<Severity, string> = {
  info: "text-accent-info",
  warn: "text-accent-warn",
  critical: "text-accent-danger",
};

const SEV_BORDER: Record<Severity, string> = {
  info: "border-accent-info/80",
  warn: "border-accent-warn/80",
  critical: "border-accent-danger/80",
};

const SEV_STROKE: Record<Severity, string> = {
  info: "#06b6d4",
  warn: "#facc15",
  critical: "#ef4444",
};

function Sparkline({ data, color }: { data: number[]; color: string }) {
  if (data.length < 2) {
    return (
      <div className="h-10 text-[10px] tracking-widest uppercase text-smoke-500/70 flex items-center font-mono">
        collecting…
      </div>
    );
  }
  const w = 240;
  const h = 40;
  const min = Math.min(...data);
  const max = Math.max(...data);
  const range = max - min || 1;
  const step = w / Math.max(1, data.length - 1);
  const points = data
    .map((v, i) => `${(i * step).toFixed(1)},${(h - ((v - min) / range) * h).toFixed(1)}`)
    .join(" ");
  // Mirror reflection underneath via second polyline at lower opacity
  return (
    <svg
      viewBox={`0 0 ${w} ${h}`}
      className="h-10 w-full"
      preserveAspectRatio="none"
    >
      <defs>
        <linearGradient id={`grad-${color.replace("#", "")}`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.35" />
          <stop offset="100%" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>
      <polyline
        points={`0,${h} ${points} ${w},${h}`}
        fill={`url(#grad-${color.replace("#", "")})`}
        stroke="none"
      />
      <polyline
        points={points}
        fill="none"
        stroke={color}
        strokeWidth="1.25"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function SensorCard({ slot, label, unit, value, history, threshold, rule }: Props) {
  const sev = threshold?.breached ? threshold.severity : null;
  const stroke = sev ? SEV_STROKE[sev] : "#10b981";
  const borderClass = sev ? SEV_BORDER[sev] : "border-ink-600";
  const valueColor = sev ? SEV_INK[sev] : "text-smoke-50";
  const slotColor = sev ? SEV_INK[sev] : "text-smoke-400/70";

  return (
    <div
      className={`hud-frame ${sev === "critical" ? "animate-pulse-danger" : ""} border ${borderClass} bg-ink-900/80 backdrop-blur-[1px] p-4 relative transition-colors`}
    >
      <span className="hud-corner" />
      {/* top row: label + slot */}
      <div className="flex items-baseline justify-between mb-2">
        <span className="t-meta">{label}</span>
        <span className={`text-[10px] tracking-widest font-mono ${slotColor}`}>
          /{slot}
        </span>
      </div>
      {/* big value */}
      <div className="flex items-baseline gap-1.5 leading-none">
        <span className={`text-[2.6rem] font-mono font-bold tnum ${valueColor}`}>
          {value}
        </span>
        {unit && (
          <span className="t-meta text-smoke-500 mb-1.5">{unit}</span>
        )}
      </div>
      {/* sparkline */}
      <div className="mt-3">
        <Sparkline data={history} color={stroke} />
      </div>
      {/* footer rule descriptor */}
      <div className="mt-2 flex items-center justify-between text-[10px] tracking-widest uppercase font-mono">
        <span className="text-smoke-500/70">{rule ?? "—"}</span>
        <span
          className={`inline-block w-1.5 h-1.5 ${sev ? "bg-current" : "bg-smoke-500/40"} ${sev ? SEV_INK[sev] : ""}`}
          aria-hidden
        />
      </div>
    </div>
  );
}
