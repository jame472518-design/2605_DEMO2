import { useEffect, useRef, useState } from "react";
import { getMockMode, setMockMode, type MockMode, type MockStatus } from "../lib/api";

/**
 * Floating HUD widget that lets a booth operator toggle the plugin's
 * synthetic-frame generator between AUTO / MOCK / OFF without leaving the
 * dashboard. Sits above QrPanel in the bottom-right.
 *
 * - AUTO  : plugin emits mock frames only when no real ESP32 is alive
 *           (is_emitting flips on its own)
 * - MOCK  : force-on (override real ESP32 if present)
 * - OFF   : no synthetic frames
 *
 * Polls every 3s so the operator sees `(emitting)` light up when AUTO
 * auto-takes-over due to a real-sensor silence.
 */

const POLL_MS = 3000;

type Row = {
  mode: MockMode;
  label: string;
  /** tailwind text class for the SELECTED state label */
  selectedClass: string;
};

const ROWS: Row[] = [
  { mode: "auto", label: "AUTO", selectedClass: "text-accent-ok" },
  { mode: "force", label: "MOCK", selectedClass: "text-accent-warn" },
  { mode: "off", label: "OFF", selectedClass: "text-smoke-500" },
];

export function MockController() {
  const [status, setStatus] = useState<MockStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [hidden, setHidden] = useState(false);
  const pollRef = useRef<number | null>(null);

  // Initial load + polling. Poll runs unconditionally every 3s; if a poll
  // fails repeatedly we still keep trying — backend may come back.
  useEffect(() => {
    let cancelled = false;
    let failCount = 0;

    async function poll() {
      try {
        const s = await getMockMode();
        if (cancelled) return;
        setStatus(s);
        failCount = 0;
      } catch (err) {
        failCount += 1;
        // Hide widget after first load failure — endpoint probably isn't
        // wired yet (backend agent hasn't landed). Don't spam console.
        if (failCount === 1) {
          // eslint-disable-next-line no-console
          console.warn("[MockController] /api/dev/mock not available:", err);
        }
        if (failCount >= 3 && !cancelled) {
          setHidden(true);
        }
      }
    }

    void poll();
    pollRef.current = window.setInterval(poll, POLL_MS);
    return () => {
      cancelled = true;
      if (pollRef.current !== null) {
        window.clearInterval(pollRef.current);
        pollRef.current = null;
      }
    };
  }, []);

  async function onSelect(mode: MockMode) {
    if (busy || !status || status.mode === mode) return;
    const prev = status;
    // Optimistic: paint the new selection immediately. is_emitting we don't
    // know yet — for `force` it'll be true; for `off` false; for `auto` it
    // depends on liveness. Leave the previous is_emitting until POST returns;
    // if POST fails we revert anyway.
    setBusy(true);
    setStatus({ ...prev, mode });
    try {
      const r = await setMockMode(mode);
      // Backend echoes the mode it actually applied; trust it.
      setStatus((curr) => (curr ? { ...curr, mode: r.mode } : curr));
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("[MockController] setMockMode failed, reverting:", err);
      setStatus(prev);
    } finally {
      setBusy(false);
    }
  }

  if (hidden) return null;

  // Reserve the same footprint while we wait for the first GET, so we don't
  // flicker between "default guess" and "server truth".
  const isLoading = status === null;

  return (
    <div
      className="hud-frame fixed bottom-32 right-4 z-30 border border-ink-600 bg-ink-900/90 backdrop-blur-sm w-[160px] select-none"
      role="group"
      aria-label="Ingest mock mode controller"
    >
      <span className="hud-corner" />

      <div className="px-3 pt-2 pb-1.5 border-b border-ink-700">
        <span className="t-meta tracking-hud text-smoke-500">INGEST</span>
      </div>

      {isLoading ? (
        <div className="px-3 py-3 font-mono text-[11px] tracking-widest text-smoke-500/60">
          ...
        </div>
      ) : (
        <div className="py-1">
          {ROWS.map((row) => {
            const selected = status.mode === row.mode;
            const labelClass = selected ? row.selectedClass : "text-smoke-400";
            const dot = selected ? "⦿" : "○"; // ⦿ vs ○
            const showEmitting =
              selected && row.mode === "auto" && status.is_emitting;
            return (
              <button
                key={row.mode}
                type="button"
                onClick={() => onSelect(row.mode)}
                disabled={busy}
                aria-pressed={selected}
                className={`relative w-full flex items-center gap-2 px-3 py-1.5 font-mono text-xs tracking-widest border-l-2 ${
                  selected ? "border-l-current " + labelClass : "border-l-transparent text-smoke-400"
                } hover:bg-ink-800/60 hover:text-smoke-100 hover:border-l-2 hover:border-l-accent-photon transition-colors disabled:opacity-60 disabled:cursor-not-allowed`}
              >
                <span
                  className={`inline-block w-3 text-center leading-none ${
                    selected ? labelClass : "text-smoke-500"
                  }`}
                  aria-hidden
                >
                  {dot}
                </span>
                <span className={selected ? labelClass : ""}>{row.label}</span>
                {showEmitting && (
                  <span className="ml-auto inline-flex items-center gap-1.5">
                    <span className="live-dot" />
                    <span className="t-meta text-accent-photon">LIVE</span>
                  </span>
                )}
                {selected && <div className="absolute inset-x-0 bottom-0 h-px border-energize" />}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
