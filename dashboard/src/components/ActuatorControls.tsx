import { useCallback, useEffect, useRef, useState } from "react";
import { sendActuator, type ActuatorRequest } from "../lib/api";
import type { SensorFrame } from "../types";

const BUTTONS: Array<{ key: string; label: string; sub: string; req: ActuatorRequest }> = [
  {
    key: "buzz",
    label: "BUZZER",
    sub: "1.5s",
    req: { device: "buzzer", state: "on", duration_ms: 1500 },
  },
  {
    key: "led-red",
    label: "LED",
    sub: "RED",
    req: { device: "led", state: "red" },
  },
  {
    key: "led-green",
    label: "LED",
    sub: "GREEN",
    req: { device: "led", state: "green" },
  },
  {
    key: "led-off",
    label: "LED",
    sub: "OFF",
    req: { device: "led", state: "off" },
  },
];

export function ActuatorControls({ latest }: { latest?: SensorFrame }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lastOk, setLastOk] = useState<string | null>(null);
  // Track the most recent buzzer/LED fire so the footer breadcrumb can echo
  // it. We don't have persistent device state from the firmware, so this is
  // best-effort: latest user intent for buzzer (always falls back to STANDBY
  // after the 1.5s pulse window), and last LED command for LED.
  const [buzzerState, setBuzzerState] = useState<string>("STANDBY");
  const [ledState, setLedState] = useState<string>("OFF");

  async function fire(key: string, req: ActuatorRequest) {
    setBusy(key);
    setError(null);
    try {
      await sendActuator(req);
      setLastOk(key);
      setTimeout(() => setLastOk((k) => (k === key ? null : k)), 1200);
      if (req.device === "buzzer") {
        setBuzzerState("ACTIVE");
        const hold = (req.duration_ms ?? 1500) as number;
        setTimeout(() => setBuzzerState("STANDBY"), hold);
      } else if (req.device === "led") {
        setLedState(String(req.state).toUpperCase());
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  const livePan = latest?.pan_angle;
  const liveTilt = latest?.tilt_angle;

  return (
    <section className="hud-frame relative border border-ink-600 bg-ink-900/80 p-4">
      <span className="hud-corner" />
      <div className="flex items-baseline justify-between mb-3">
        <span className="t-meta text-smoke-400">manual override</span>
        <span className="text-[10px] tracking-widest text-smoke-500/70 font-mono">
          POST /api/actuator
        </span>
      </div>
      <div className="grid grid-cols-2 gap-2">
        {BUTTONS.map(({ key, label, sub, req }) => {
          const isOk = lastOk === key;
          return (
            <button
              key={key}
              type="button"
              disabled={busy !== null}
              onClick={() => fire(key, req)}
              className={`group relative border bg-ink-800 disabled:opacity-50 hover:bg-ink-700 transition-[colors,box-shadow] duration-300 px-3 py-3 text-left flex items-center justify-between font-mono ${
                isOk
                  ? "border-accent-ok/70 text-accent-ok shadow-[0_0_18px_rgba(16,185,129,0.45)]"
                  : "border-ink-600 text-smoke-100 shadow-none"
              }`}
            >
              <span className="absolute top-1 left-1 text-[9px] tracking-widest text-smoke-500/70">
                ▸
              </span>
              <div className="flex flex-col leading-tight ml-3">
                <span className="text-sm tracking-widest font-bold">
                  {busy === key ? "…" : label}
                </span>
                <span className="text-[10px] tracking-widest text-smoke-500 group-hover:text-smoke-400">
                  {sub}
                </span>
              </div>
              <span
                className={`w-1.5 h-1.5 ${isOk ? "bg-accent-ok" : "bg-ink-500"}`}
                aria-hidden
              />
            </button>
          );
        })}
      </div>
      <ServoControls latest={latest} onError={setError} />
      {error && (
        <p className="mt-3 text-[10px] tracking-widest font-mono text-accent-danger">
          ERR: {error}
        </p>
      )}
      {/* Footer status breadcrumb — thin row echoing the *most recent* actuator
          state we can derive client-side. PAN/TILT pull from the live sensor
          frame (firmware-confirmed), buzzer/LED reflect the last command. */}
      <div className="mt-3 pt-2 border-t border-ink-700/60 flex flex-wrap items-center gap-x-3 gap-y-1 t-meta text-smoke-500">
        <span>
          BUZZER:
          <span
            className={`ml-1 ${buzzerState === "ACTIVE" ? "text-accent-warn" : "text-smoke-300"}`}
          >
            {buzzerState}
          </span>
        </span>
        <span className="text-smoke-600">·</span>
        <span>
          LED:
          <span
            className={`ml-1 ${ledState !== "OFF" ? "text-accent-ok" : "text-smoke-300"}`}
          >
            {ledState}
          </span>
        </span>
        <span className="text-smoke-600">·</span>
        <span>
          PAN:
          <span className="ml-1 text-smoke-300 tnum">
            {typeof livePan === "number" ? `${livePan.toFixed(0).padStart(3, "0")}°` : "—"}
          </span>
        </span>
        <span className="text-smoke-600">·</span>
        <span>
          TILT:
          <span className="ml-1 text-smoke-300 tnum">
            {typeof liveTilt === "number" ? `${liveTilt.toFixed(0).padStart(3, "0")}°` : "—"}
          </span>
        </span>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Servo (pan/tilt) sliders. Read live angles from the latest sensor frame so
// the slider reflects what the ESP32 actually moved to (not just what the
// user requested). Sends are debounced ~120ms — slider drags don't flood the
// actuator endpoint.
// ---------------------------------------------------------------------------

function ServoControls({
  latest,
  onError,
}: {
  latest?: SensorFrame;
  onError: (err: string | null) => void;
}) {
  const livePan = latest?.pan_angle ?? 90;
  const liveTilt = latest?.tilt_angle ?? 90;

  // Local slider state is what the *user* is dragging right now. While the
  // user is interacting (`isDragging`) we don't snap to the live value or the
  // slider would jitter. After release, we let the live value reassert.
  const [pan, setPan] = useState<number>(livePan);
  const [tilt, setTilt] = useState<number>(liveTilt);
  const [drag, setDrag] = useState<"pan" | "tilt" | null>(null);

  useEffect(() => {
    if (drag !== "pan") setPan(livePan);
  }, [livePan, drag]);
  useEffect(() => {
    if (drag !== "tilt") setTilt(liveTilt);
  }, [liveTilt, drag]);

  const sendTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const queueSend = useCallback(
    (axis: "pan" | "tilt", angle: number) => {
      if (sendTimerRef.current) clearTimeout(sendTimerRef.current);
      sendTimerRef.current = setTimeout(async () => {
        try {
          await sendActuator({ device: "servo", state: axis, angle });
          onError(null);
        } catch (e) {
          onError(e instanceof Error ? e.message : String(e));
        }
      }, 120);
    },
    [onError],
  );

  return (
    <div className="mt-4 pt-3 border-t border-ink-700/60">
      <div className="flex items-baseline justify-between mb-2">
        <span className="t-meta text-smoke-400">camera servo</span>
        <span className="text-[10px] tracking-widest text-smoke-500/70 font-mono">
          live: P {livePan.toFixed(0)}° / T {liveTilt.toFixed(0)}°
        </span>
      </div>
      <SliderRow
        label="PAN"
        value={pan}
        live={livePan}
        onInput={(v) => {
          setPan(v);
          setDrag("pan");
          queueSend("pan", v);
        }}
        onRelease={() => setDrag(null)}
      />
      <div className="h-2" />
      <SliderRow
        label="TILT"
        value={tilt}
        live={liveTilt}
        onInput={(v) => {
          setTilt(v);
          setDrag("tilt");
          queueSend("tilt", v);
        }}
        onRelease={() => setDrag(null)}
      />
    </div>
  );
}

function SliderRow({
  label,
  value,
  live,
  onInput,
  onRelease,
}: {
  label: string;
  value: number;
  live: number;
  onInput: (v: number) => void;
  onRelease: () => void;
}) {
  const drifted = Math.abs(value - live) > 2;
  return (
    <div>
      <div className="flex items-center justify-between mb-1">
        <span className="text-[10px] tracking-widest font-mono text-smoke-400">
          {label}
        </span>
        <span
          className={`text-xs tracking-widest font-mono tnum ${
            drifted ? "text-accent-warn" : "text-smoke-100"
          }`}
        >
          {value.toFixed(0)}°
        </span>
      </div>
      <div className="flex items-center gap-2">
        <input
          type="range"
          min={0}
          max={180}
          step={1}
          value={value}
          onInput={(e) => onInput(parseInt(e.currentTarget.value, 10))}
          onMouseUp={onRelease}
          onTouchEnd={onRelease}
          onBlur={onRelease}
          className="flex-1 h-1.5 appearance-none bg-ink-700 cursor-pointer accent-accent-info"
        />
        <ServoArc live={live} target={value} drifted={drifted} />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// ServoArc — 36×36 SVG gauge showing the current (and drifted target) angle.
// Angle range 0..180 maps linearly to a -120°..+120° sweep around the gauge
// center, so the bottom 120° of the circle remains the gauge "opening". 0°
// servo  ⇒ -120° arc end (lower-left).  90° servo ⇒ 0° arc end (top).  180°
// servo ⇒ +120° arc end (lower-right).
// ---------------------------------------------------------------------------

function ServoArc({
  live,
  target,
  drifted,
}: {
  live: number;
  target: number;
  drifted: boolean;
}) {
  const SIZE = 36;
  const CENTER = SIZE / 2;
  const RADIUS = 14;
  // -120° → +120°, expressed in SVG coords where 0° is at 12-o'clock (we
  // rotate by -90° from standard math convention).
  const SWEEP_MIN = -120;
  const SWEEP_MAX = 120;

  function angleToSweep(servoAngle: number): number {
    const clamped = Math.max(0, Math.min(180, servoAngle));
    return SWEEP_MIN + (clamped / 180) * (SWEEP_MAX - SWEEP_MIN);
  }

  function polar(sweepDeg: number, r = RADIUS): { x: number; y: number } {
    // -90° aligns sweep=0 with 12-o'clock.
    const rad = ((sweepDeg - 90) * Math.PI) / 180;
    return {
      x: CENTER + r * Math.cos(rad),
      y: CENTER + r * Math.sin(rad),
    };
  }

  function arcPath(fromSweep: number, toSweep: number): string {
    const start = polar(fromSweep);
    const end = polar(toSweep);
    const largeArc = Math.abs(toSweep - fromSweep) > 180 ? 1 : 0;
    const sweepFlag = toSweep > fromSweep ? 1 : 0;
    return `M ${start.x.toFixed(2)} ${start.y.toFixed(2)} A ${RADIUS} ${RADIUS} 0 ${largeArc} ${sweepFlag} ${end.x.toFixed(2)} ${end.y.toFixed(2)}`;
  }

  const liveSweep = angleToSweep(live);
  const targetSweep = angleToSweep(target);
  const tip = polar(liveSweep);

  const bgPath = arcPath(SWEEP_MIN, SWEEP_MAX);
  const livePath = arcPath(SWEEP_MIN, liveSweep);
  const targetPath = arcPath(SWEEP_MIN, targetSweep);

  return (
    <div className="relative flex-shrink-0" style={{ width: SIZE, height: SIZE }}>
      <svg
        width={SIZE}
        height={SIZE}
        viewBox={`0 0 ${SIZE} ${SIZE}`}
        aria-hidden
      >
        {/* background 240° arc */}
        <path
          d={bgPath}
          fill="none"
          className="stroke-ink-700"
          strokeWidth={3}
          strokeLinecap="round"
        />
        {/* drifted target outline — only when slider != live */}
        {drifted && (
          <path
            d={targetPath}
            fill="none"
            className="stroke-accent-ember/60"
            strokeWidth={1.5}
            strokeDasharray="2 2"
            strokeLinecap="round"
          />
        )}
        {/* live active arc */}
        <path
          d={livePath}
          fill="none"
          className="stroke-accent-photon"
          strokeWidth={3}
          strokeLinecap="round"
          style={{ filter: "drop-shadow(0 0 3px rgba(0,217,255,0.55))" }}
        />
        {/* tip dot */}
        <circle
          cx={tip.x}
          cy={tip.y}
          r={1.8}
          className="fill-accent-photon"
          style={{ filter: "drop-shadow(0 0 3px rgba(0,217,255,0.8))" }}
        />
      </svg>
      <span className="absolute inset-0 flex items-center justify-center tnum text-[10px] font-mono text-smoke-200 pointer-events-none">
        {live.toFixed(0)}
      </span>
    </div>
  );
}
