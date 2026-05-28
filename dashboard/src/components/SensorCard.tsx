import { useEffect, useId, useRef } from "react";
import type { Severity } from "../types";

type ThresholdProp = {
  breached: boolean;
  severity: Severity;
  /** Optional numeric threshold for opting into the 4-state machine.
   *  When supplied together with `op`, the card derives WATCH / ARMED state
   *  from the live value's proximity to this number. Without it, the card
   *  degrades to the legacy 2-state mode (NOMINAL vs TRIP via `breached`). */
  value?: number;
  /** Comparison operator the rule uses against `value`. "<" means values
   *  approaching/below trip (e.g. distance < 15); ">" means values approaching/
   *  above trip (e.g. temp > 32). */
  op?: "<" | ">";
};

type Props = {
  /** Slot identifier shown top-right, e.g. "01"…"05" */
  slot: string;
  label: string;
  unit?: string;
  value: string;
  history: number[];
  threshold?: ThresholdProp;
  /** Optional descriptor printed under the sparkline (e.g. "> 32°C 60s") */
  rule?: string;
  /** Card position in the row — drives stagger-reveal entry delay. */
  index?: number;
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

// 4-state machine -- NOMINAL/WATCH/ARMED/TRIP
type CardState = "NOMINAL" | "WATCH" | "ARMED" | "TRIP";

/** Derive the 4-state machine from the latest reading + threshold prop.
 *  Falls back to 2-state (NOMINAL vs TRIP) when `value`/`op` aren't supplied. */
function deriveState(
  latest: number | null,
  threshold: ThresholdProp | undefined,
): CardState {
  if (!threshold) return "NOMINAL";
  if (threshold.breached) return "TRIP";
  // Without numeric threshold context, we can only express the binary form.
  if (threshold.value === undefined || threshold.op === undefined) {
    return "NOMINAL";
  }
  if (latest === null || !Number.isFinite(latest)) return "NOMINAL";
  const t = threshold.value;
  // Normalised distance to trip line. For ">": (t - v) / |t|, positive means
  // we're below trip and still safe. For "<": (v - t) / |t|, positive means
  // we're above trip and still safe. Either way, smaller = closer to tripping.
  const denom = Math.abs(t) < 1e-6 ? 1 : Math.abs(t);
  const margin =
    threshold.op === ">" ? (t - latest) / denom : (latest - t) / denom;
  if (margin <= 0) return "TRIP"; // Should already be flagged via breached, but safe.
  if (margin <= 0.03) return "ARMED";
  if (margin <= 0.1) return "WATCH";
  return "NOMINAL";
}

// State -> footer label colour + dot colour
const STATE_COLOR: Record<Exclude<CardState, "NOMINAL">, string> = {
  WATCH: "text-accent-info",
  ARMED: "text-accent-ember",
  TRIP: "text-accent-danger",
};

function Sparkline({
  data,
  color,
  gradId,
}: {
  data: number[];
  color: string;
  gradId: string;
}) {
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
  const coords = data.map(
    (v, i) =>
      [
        Number((i * step).toFixed(1)),
        Number((h - ((v - min) / range) * h).toFixed(1)),
      ] as const,
  );
  const points = coords.map(([x, y]) => `${x},${y}`).join(" ");
  // Closed path for the gradient fill: trace the polyline, then close down to
  // the baseline (y = h) on the right edge and back along the bottom.
  const first = coords[0]!;
  const last = coords[coords.length - 1]!;
  const areaPath = `M ${first[0]},${h} L ${coords
    .map(([x, y]) => `${x},${y}`)
    .join(" L ")} L ${last[0]},${h} Z`;
  return (
    <svg
      viewBox={`0 0 ${w} ${h}`}
      className="h-10 w-full"
      preserveAspectRatio="none"
    >
      <defs>
        {/* Gradient id is scoped per card instance to avoid SVG-defs collisions
            when multiple sensor cards mount with the same severity colour. */}
        <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.35" />
          <stop offset="100%" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={areaPath} fill={`url(#${gradId})`} stroke="none" />
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

// ---------------------------------------------------------------------------
// Δ rate-of-change indicator
// ---------------------------------------------------------------------------
// Decide formatting precision from the rendered string the caller already
// computed -- if the displayed value has a decimal point, show one decimal,
// else show an integer. Keeps the Δ visually consistent with the big number.
function formatDelta(d: number, displayValue: string): string {
  const isFloat = displayValue.includes(".");
  const abs = Math.abs(d);
  const formatted = isFloat ? abs.toFixed(1) : String(Math.round(abs));
  const sign = d > 0 ? "+" : "-";
  return `${sign}${formatted}`;
}

function DeltaIndicator({
  history,
  displayValue,
}: {
  history: number[];
  displayValue: string;
}) {
  // Need at least 11 samples (current + 10 ago) to render a Δ at all.
  if (history.length < 11) return null;
  const current = history[history.length - 1];
  const past = history[history.length - 11];
  if (
    current === undefined ||
    past === undefined ||
    !Number.isFinite(current) ||
    !Number.isFinite(past)
  ) {
    return null;
  }
  // If the upstream value couldn't be rendered as a number (e.g. MOTION shows
  // "ACTIVE" / "IDLE"), skip the Δ -- the arithmetic would be meaningless.
  if (displayValue === "—") return null;

  const delta = current - past;
  // Drift-noise zone: ≤ ±0.05 is treated as flat.
  if (Math.abs(delta) <= 0.05) {
    return (
      <span className="font-mono text-[10px] tracking-widest tnum text-smoke-500/70">
        → —— / 10s
      </span>
    );
  }
  const dir = delta > 0 ? "▲" : "▼";
  // Data-direction colour (NOT severity): up = warn, down = info.
  const color = delta > 0 ? "text-accent-warn" : "text-accent-info";
  return (
    <span className={`font-mono text-[10px] tracking-widest tnum ${color}`}>
      {dir} {formatDelta(delta, displayValue)} / 10s
    </span>
  );
}

// ---------------------------------------------------------------------------
// Digit ticker — wraps each char in a .digit-cell. The inner <span> remounts
// whenever the displayed value changes so the keyframe replays.
// ---------------------------------------------------------------------------
function DigitTicker({ value }: { value: string }) {
  // Monotonic counter that bumps on every value change. Cheap to track and
  // gives us a stable key suffix so React tears down only the inner span.
  const tickRef = useRef(0);
  const prevRef = useRef(value);
  if (prevRef.current !== value) {
    tickRef.current += 1;
    prevRef.current = value;
  }
  // Cleanup-only effect; nothing to do but it keeps the hook order stable
  // across re-renders in case we ever extend behaviour.
  useEffect(() => {
    return;
  }, [value]);

  // Don't ticker the placeholder — it's not data, it's an absence.
  if (value === "—") {
    return <span>—</span>;
  }
  const token = tickRef.current;
  return (
    <>
      {value.split("").map((ch, i) => (
        <span key={`${i}-${ch}-${token}`} className="digit-cell">
          <span>{ch}</span>
        </span>
      ))}
    </>
  );
}

export function SensorCard({
  slot,
  label,
  unit,
  value,
  history,
  threshold,
  rule,
  index,
}: Props) {
  // useId gives us a stable, render-stable id we can suffix into the gradient
  // <defs> entry. Avoids collisions when multiple cards share severity.
  const reactId = useId();
  const gradId = `spark-grad-${slot}-${reactId.replace(/[^a-zA-Z0-9_-]/g, "")}`;

  const latestNumeric =
    history.length > 0 ? (history[history.length - 1] ?? null) : null;
  const state = deriveState(latestNumeric, threshold);

  // Severity drives chrome colours; in degraded mode (no value/op) the caller
  // still tells us the severity via `threshold.severity` when breached.
  const sev: Severity | null =
    state === "TRIP" || threshold?.breached ? (threshold?.severity ?? null) : null;
  const stroke = sev ? SEV_STROKE[sev] : "#10b981";
  const borderClass = sev ? SEV_BORDER[sev] : "border-ink-600";
  const valueColor = sev ? SEV_INK[sev] : "text-smoke-50";
  const slotColor = sev ? SEV_INK[sev] : "text-smoke-400/70";

  // Breathing/pulse class -- TRIP keeps the existing danger pulse, ARMED gets
  // the ember breathe, WATCH gets the info breathe. NOMINAL stays still.
  // We hand-pick a single animation class so they never stack and double-blink.
  let atmosphere = "";
  if (state === "TRIP") atmosphere = "animate-pulse-danger";
  else if (state === "ARMED") atmosphere = "breathe-warn";
  else if (state === "WATCH") atmosphere = "breathe-info";

  // Compose state label for the footer. NOMINAL renders no extra label so the
  // baseline card stays quiet -- the dot at the far right is the only signal.
  const stateLabel = state === "NOMINAL" ? null : state;
  const stateColor =
    state === "NOMINAL" ? "text-smoke-500/40" : STATE_COLOR[state];

  return (
    <section
      className={`hud-frame ${atmosphere} border ${borderClass} bg-ink-900/80 backdrop-blur-[1px] p-4 relative transition-colors animate-stagger-in`}
      style={{ animationDelay: `${(index ?? 0) * 80 + 240}ms` }}
    >
      <span className="hud-corner" />
      {/* top row: label + Δ + slot */}
      <div className="flex items-baseline justify-between gap-2 mb-2">
        <span className="t-meta">{label}</span>
        <div className="flex items-baseline gap-2 min-w-0">
          <DeltaIndicator history={history} displayValue={value} />
          <span className={`text-[10px] tracking-widest font-mono ${slotColor}`}>
            /{slot}
          </span>
        </div>
      </div>
      {/* big value -- each char wrapped in .digit-cell for the roll-in. */}
      <div className="flex items-baseline gap-1.5 leading-none">
        <span
          className={`text-[2.6rem] font-mono font-bold tnum ${valueColor}`}
        >
          <DigitTicker value={value} />
        </span>
        {unit && (
          <span className="t-meta text-smoke-500 mb-1.5">{unit}</span>
        )}
      </div>
      {/* sparkline -- now with gradient fill under the line. */}
      <div className="mt-3">
        <Sparkline data={history} color={stroke} gradId={gradId} />
      </div>
      {/* footer rule descriptor + 4-state label */}
      <div className="mt-2 flex items-center justify-between text-[10px] tracking-widest uppercase font-mono gap-2">
        <span className="text-smoke-500/70 truncate">{rule ?? "—"}</span>
        <span className="flex items-center gap-1.5 flex-shrink-0">
          {stateLabel && (
            <span className={`font-bold ${stateColor}`}>{stateLabel}</span>
          )}
          <span
            className={`inline-block w-1.5 h-1.5 ${
              state === "NOMINAL" ? "bg-smoke-500/40" : "bg-current"
            } ${state === "NOMINAL" ? "" : stateColor}`}
            aria-hidden
          />
        </span>
      </div>
    </section>
  );
}
