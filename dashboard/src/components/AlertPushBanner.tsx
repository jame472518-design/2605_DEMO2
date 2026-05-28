import { useEffect, useRef, useState } from "react";
import type { Alert } from "../types";

/**
 * AlertPushBanner — iOS-push-style top banner that slides down on touch
 * devices when a new alert id is observed. Vibration + audio chime add
 * sensory weight so the booth visitor can't miss a fired rule.
 *
 * Dedup strategy: the component owns a ref of the last shown alert id, so
 * partial AlertUpdate merges (judge/vision enrichments) don't re-fire the
 * popup. The id changes only when a fresh v1 alert arrives.
 *
 * Browser autoplay caveat: AudioContext requires a user gesture on most
 * mobile browsers; the FIRST chime after a cold-load may be silent.
 * Vibration has weaker restrictions but Safari iOS will silently no-op.
 * Both fail closed — never throw.
 */

const DURATION_MS = 6000;

const SEVERITY_BORDER: Record<Alert["severity"], string> = {
  info: "border-accent-info",
  warn: "border-accent-warn",
  critical: "border-accent-danger animate-pulse-danger",
};
const SEVERITY_TEXT: Record<Alert["severity"], string> = {
  info: "text-accent-info",
  warn: "text-accent-warn",
  critical: "text-accent-danger",
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
const SEVERITY_ICON: Record<Alert["severity"], string> = {
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

function playChime(severity: Alert["severity"]) {
  try {
    const AC =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext })
        .webkitAudioContext;
    if (!AC) return;
    const ctx = new AC();
    if (ctx.state === "suspended") void ctx.resume();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "sine";
    osc.frequency.value =
      severity === "critical" ? 1200 : severity === "warn" ? 880 : 660;
    const t0 = ctx.currentTime;
    gain.gain.setValueAtTime(0.001, t0);
    gain.gain.exponentialRampToValueAtTime(0.3, t0 + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.001, t0 + 0.45);
    osc.connect(gain).connect(ctx.destination);
    osc.start(t0);
    osc.stop(t0 + 0.5);
    setTimeout(() => void ctx.close(), 600);
  } catch {
    /* autoplay policy / unsupported browser — fail silent */
  }
}

function vibrate(severity: Alert["severity"]) {
  if (!("vibrate" in navigator)) return;
  try {
    const pattern: number[] =
      severity === "critical"
        ? [220, 80, 220, 80, 420]
        : severity === "warn"
          ? [180, 100, 180]
          : [120];
    navigator.vibrate(pattern);
  } catch {
    /* noop */
  }
}

type Props = { alert: Alert | null };

export function AlertPushBanner({ alert }: Props) {
  const [isTouch, setIsTouch] = useState(false);
  const [showing, setShowing] = useState(false);
  const [progress, setProgress] = useState(100);
  const shownIdRef = useRef<string | null>(null);
  const dismissTimerRef = useRef<number | null>(null);

  // Detect touch device via pointer: coarse media query. Re-evaluate on
  // change (rare, but covers Surface convertible flipping into tablet mode).
  useEffect(() => {
    const mq = window.matchMedia("(pointer: coarse)");
    setIsTouch(mq.matches);
    const onChange = (e: MediaQueryListEvent) => setIsTouch(e.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

  // Trigger popup on new alert id only — partial updates (judge/vision
  // enrichments share the same id) won't re-fire vibration/chime, but the
  // currently-visible banner re-renders with the new fields populated.
  useEffect(() => {
    if (!isTouch || !alert) return;
    if (shownIdRef.current === alert.id) return;
    shownIdRef.current = alert.id;
    setShowing(true);
    setProgress(100);
    vibrate(alert.severity);
    playChime(alert.severity);
    if (dismissTimerRef.current !== null) {
      window.clearTimeout(dismissTimerRef.current);
    }
    dismissTimerRef.current = window.setTimeout(() => {
      setShowing(false);
    }, DURATION_MS);
  }, [alert?.id, alert?.severity, isTouch]);

  // Countdown bar — restart on every new alert id (covers the case where a
  // second alert arrives while the first is still showing).
  useEffect(() => {
    if (!showing) return;
    const start = Date.now();
    const id = window.setInterval(() => {
      const elapsed = Date.now() - start;
      const pct = Math.max(0, 100 - (elapsed / DURATION_MS) * 100);
      setProgress(pct);
      if (pct <= 0) window.clearInterval(id);
    }, 100);
    return () => window.clearInterval(id);
  }, [showing, alert?.id]);

  // Cleanup pending timer on unmount.
  useEffect(() => {
    return () => {
      if (dismissTimerRef.current !== null) {
        window.clearTimeout(dismissTimerRef.current);
      }
    };
  }, []);

  if (!isTouch || !alert || !showing) return null;

  return (
    <div
      className="fixed inset-x-0 top-0 z-[60] px-3 pt-3 animate-slide-down pointer-events-none"
      role="alert"
      aria-live="assertive"
    >
      <div
        onClick={() => setShowing(false)}
        className={`hud-frame relative border-2 bg-ink-900/95 backdrop-blur cursor-pointer pointer-events-auto shadow-[0_8px_32px_rgba(0,0,0,0.6)] ${SEVERITY_BORDER[alert.severity]} ${SEVERITY_TEXT[alert.severity]}`}
      >
        <span className="hud-corner" />
        {/* entry tick flash — infinite tick strip naturally re-anchors on remount */}
        <div
          className="telemetry-strip absolute top-0 inset-x-0"
          aria-hidden="true"
        />
        <div className="flex items-stretch">
          {/* Icon + severity */}
          <div className="flex-shrink-0 flex flex-col items-center justify-center px-3 py-3 border-r border-current/40 min-w-[64px]">
            <span className="text-2xl leading-none mb-1" aria-hidden="true">
              {SEVERITY_ICON[alert.severity]}
            </span>
            <span className="text-[10px] tracking-hud font-mono font-bold">
              {SEVERITY_TAG[alert.severity]}
            </span>
            <span className="text-[9px] tracking-widest text-current/70 font-han mt-0.5">
              {SEVERITY_LABEL[alert.severity]}
            </span>
          </div>

          {/* Body */}
          <div className="flex-1 px-3 py-2.5 min-w-0">
            <div className="flex items-baseline gap-2 mb-1">
              <span className="font-mono text-[13px] text-current font-bold tracking-wide truncate">
                {alert.rule}
              </span>
              <span className="ml-auto text-[10px] tracking-widest font-mono text-current/60 tnum">
                {formatTime(alert.ts)}
              </span>
            </div>
            <div className="text-smoke-50 font-han text-base leading-snug">
              {alert.explanation ? (
                <span>{alert.explanation}</span>
              ) : (
                <span className="text-smoke-300 font-mono text-xs tracking-wide">
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
              <div className="mt-1.5 text-smoke-300 font-han text-sm">
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
              <div className="mt-1.5 pt-1.5 border-t border-current/20 text-smoke-300 font-han text-sm">
                <span className="text-[10px] tracking-widest font-mono text-accent-info mr-2">
                  👁 SCENE
                </span>
                {alert.scene_description}
              </div>
            )}
          </div>

          {/* Dismiss */}
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              setShowing(false);
            }}
            className="flex-shrink-0 w-10 flex items-center justify-center text-current/60 hover:text-current/100 border-l border-current/40"
            aria-label="關閉通知"
          >
            ✕
          </button>
        </div>
        {/* Critical sweep above the countdown — visually anchors a live event */}
        {alert.severity === "critical" && (
          <div className="h-px border-energize" aria-hidden="true" />
        )}
        {/* Countdown bar — gradient fades from severity color into transparent */}
        <div className="h-1 bg-current/15">
          <div
            className="h-full"
            style={{
              width: `${progress}%`,
              background: "linear-gradient(to right, currentColor, transparent)",
            }}
          />
        </div>
      </div>
    </div>
  );
}
