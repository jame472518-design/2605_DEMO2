import { useCallback, useEffect, useState } from "react";
import { ActuatorControls } from "./components/ActuatorControls";
import { AlertBanner } from "./components/AlertBanner";
import { AlertPushBanner } from "./components/AlertPushBanner";
import { CameraCard } from "./components/CameraCard";
import { JudgePanel } from "./components/JudgePanel";
import { MockController } from "./components/MockController";
import { QrPanel } from "./components/QrPanel";
import { SensorCard } from "./components/SensorCard";
import { VlmChat } from "./components/VlmChat";
import { useSse } from "./lib/sse";
import type { Alert, AlertUpdate, SensorFrame } from "./types";

// View routing via location hash. No router lib — the app has two views
// (dashboard, vlm chat) and hashchange keeps the URL shareable without
// touching server routing.
type View = "dashboard" | "vlm";

function viewFromHash(): View {
  return window.location.hash.startsWith("#/vlm") ? "vlm" : "dashboard";
}

const FRAME_BUFFER = 60;
const ALERT_BUFFER = 20;

function parseJson<T>(raw: string): T {
  return JSON.parse(raw) as T;
}

function useUtcClock(): string {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(t);
  }, []);
  return now.toLocaleTimeString("zh-TW", { hour12: false });
}

export default function App() {
  const [view, setView] = useState<View>(viewFromHash);

  useEffect(() => {
    const onHashChange = () => setView(viewFromHash());
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

  if (view === "vlm") {
    return <VlmChat />;
  }

  return <Dashboard />;
}

function Dashboard() {
  const [frames, setFrames] = useState<SensorFrame[]>([]);
  const [alerts, setAlerts] = useState<Alert[]>([]);

  const onFrame = useCallback((f: SensorFrame) => {
    setFrames((prev) => {
      const next = prev.length >= FRAME_BUFFER ? prev.slice(1) : prev.slice();
      next.push(f);
      return next;
    });
  }, []);

  const onAlert = useCallback((a: Alert | AlertUpdate) => {
    setAlerts((prev) => {
      const idx = prev.findIndex((x) => x.id === a.id);
      if (idx >= 0) {
        // Merge: judge enrichment delivers only {id, explanation,
        // suggested_action}; auto-vision delivers only {id, scene_description,
        // scene_took_ms}. They race; merging keeps both wins.
        const next = prev.slice();
        next[idx] = { ...prev[idx]!, ...a };
        return next;
      }
      // First sighting of this id: only accept if it's a full v1 alert.
      // If it's a partial enrichment (we missed v1 — replay buffer rolled
      // off or plugin restarted between v1 and v2/v3), drop it. Otherwise
      // AlertBanner will Object.entries(undefined trigger) → crash.
      if (
        typeof (a as Alert).rule !== "string" ||
        typeof (a as Alert).severity !== "string" ||
        !(a as Alert).trigger ||
        typeof (a as Alert).trigger !== "object"
      ) {
        return prev;
      }
      const next = prev.length >= ALERT_BUFFER ? prev.slice(1) : prev.slice();
      next.push(a as Alert);
      return next;
    });
  }, []);

  useSse<SensorFrame>("/api/sensor/stream", parseJson, onFrame);
  useSse<Alert | AlertUpdate>("/api/alert/stream", parseJson, onAlert);

  const latest = frames[frames.length - 1];
  const latestAlert = alerts[alerts.length - 1] ?? null;
  const clock = useUtcClock();
  const liveSensors = frames.length > 0;

  return (
    <div className="min-h-screen px-4 py-4 md:px-7 md:py-6 max-w-[1480px] mx-auto">
      {/* === HEADER ====================================================== */}
      <header className="mb-4 md:mb-5 border border-ink-600 bg-ink-900/70 backdrop-blur-[1px] hud-frame relative">
        <span className="hud-corner" />
        <div className="flex flex-wrap items-stretch">
          {/* Brand mark */}
          <div className="flex items-center gap-3 px-4 py-3 border-r border-ink-600 min-w-0">
            <span className="text-accent-strix font-bold text-xl leading-none">◢◣</span>
            <div className="leading-tight">
              <div className="font-mono text-[15px] md:text-base font-bold tracking-hud text-smoke-50">
                SENSOR STATION
              </div>
              <div className="t-meta text-smoke-500">demo · 02 · STRIX HALO</div>
            </div>
          </div>

          {/* Status pills */}
          <div className="flex-1 flex flex-wrap items-center gap-x-5 gap-y-1 px-4 py-3 min-w-0">
            <StatusPill
              ok={true}
              label="gateway"
              value="18790"
            />
            <StatusPill
              ok={liveSensors}
              label="ingest"
              value={liveSensors ? "live" : "idle"}
              ping
            />
            <StatusPill
              ok={true}
              label="judge"
              value="qwen2:1.5b"
            />
            <StatusPill
              ok={true}
              label="seq"
              value={latest ? String(latest.seq).padStart(5, "0") : "—"}
            />
            <a
              href="#/vlm"
              title="開啟 VLM agent 對話視窗"
              className="ml-auto inline-flex items-center gap-2 border border-accent-info/70 text-accent-info hover:bg-accent-info/10 px-2.5 py-1.5 font-mono text-[11px] tracking-hud transition-colors"
            >
              <span className="w-1.5 h-1.5 bg-accent-info" aria-hidden />
              [VLM]
            </a>
          </div>

          {/* Clock */}
          <div className="px-4 py-3 border-l border-ink-600 flex flex-col items-end justify-center">
            <span className="t-meta text-smoke-500">utc{clock ? "+8" : ""}</span>
            <span className="font-mono text-base md:text-lg font-bold tracking-widest text-smoke-100 tnum">
              {clock || "—"}
            </span>
          </div>
        </div>
      </header>

      {/* === ALERT BANNER ================================================ */}
      <AlertBanner alert={latestAlert} />

      {/* === LIVE FEED =================================================== */}
      <CameraCard />

      {/* === SENSOR CARDS ================================================ */}
      <main className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5 gap-3 md:gap-4 mb-4 md:mb-5">
        <SensorCard
          slot="01"
          label="TEMP °C"
          unit="°C"
          value={latest ? latest.temp_c.toFixed(1) : "—"}
          history={frames.map((f) => f.temp_c)}
          rule="HEAT_SUSTAINED  > 32  60s"
          threshold={
            latest && latest.temp_c > 32
              ? { breached: true, severity: "warn" }
              : undefined
          }
        />
        <SensorCard
          slot="02"
          label="HUMID %"
          unit="%RH"
          value={latest ? latest.humidity.toFixed(0) : "—"}
          history={frames.map((f) => f.humidity)}
          rule="—"
        />
        <SensorCard
          slot="03"
          label="MOTION"
          value={
            !latest || latest.pir === undefined
              ? "—"
              : latest.pir === 1
                ? "ACTIVE"
                : "IDLE"
          }
          history={frames.map((f) => f.pir ?? 0)}
          rule="MOTION_DETECTED  +  vision"
          threshold={
            latest && latest.pir === 1
              ? { breached: true, severity: "info" }
              : undefined
          }
        />
        <SensorCard
          slot="04"
          label="AUDIO RMS"
          unit="rms"
          value={
            latest?.audio_rms !== undefined
              ? Math.round(latest.audio_rms).toLocaleString()
              : "—"
          }
          history={frames.map((f) => f.audio_rms ?? 0)}
          rule="NOISE_EVENT  >50k  1s  +  vision"
          threshold={
            latest &&
            latest.audio_rms !== undefined &&
            latest.audio_rms > 50000
              ? { breached: true, severity: "info" }
              : undefined
          }
        />
        <SensorCard
          slot="05"
          label="DIST cm"
          unit="cm"
          value={
            latest?.distance_cm !== undefined
              ? latest.distance_cm.toFixed(0)
              : "—"
          }
          history={frames.map((f) => f.distance_cm ?? 0)}
          rule="OBJECT_TOO_CLOSE  < 15  3s"
          threshold={
            latest &&
            latest.distance_cm !== undefined &&
            latest.distance_cm < 15
              ? { breached: true, severity: "info" }
              : undefined
          }
        />
      </main>

      {/* === LOG + CONTROL =============================================== */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3 md:gap-4 mb-6">
        <JudgePanel alerts={alerts.slice(-5).reverse()} />
        <ActuatorControls latest={latest} />
      </div>

      {/* === FOOTER ====================================================== */}
      <footer className="border-t border-ink-700 pt-3 mt-2 flex flex-wrap items-center justify-between gap-2 t-meta">
        <span>SSE · rule engine · judge-1 / qwen2:1.5b</span>
        <span className="text-smoke-500/60">demo2 · w3-esp32-prep · {new Date().toISOString().slice(0, 10)}</span>
      </footer>

      {/* === FLOATING QR (booth) ========================================== */}
      <QrPanel />

      {/* === FLOATING INGEST MOCK CONTROLLER ============================== */}
      {/* Stacked above QrPanel; dashboard-only (App.tsx gates by hash). */}
      <MockController />

      {/* === MOBILE PUSH-STYLE ALERT BANNER =============================== */}
      {/* Self-gates on (pointer: coarse) — desktop kiosk relies on the
          big AlertBanner above; only touch devices see this popup. */}
      <AlertPushBanner alert={latestAlert} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Header helper component
// ---------------------------------------------------------------------------

function StatusPill({
  ok,
  label,
  value,
  ping,
}: {
  ok: boolean;
  label: string;
  value: string;
  ping?: boolean;
}) {
  return (
    <div className="flex items-center gap-2 min-w-0">
      <span
        className={`w-1.5 h-1.5 ${ok ? "bg-accent-ok" : "bg-smoke-600"} ${ping ? "animate-pulse-dot" : ""}`}
        aria-hidden
      />
      <span className="t-meta">{label}</span>
      <span className="font-mono text-xs text-smoke-200 tracking-widest truncate">
        {value}
      </span>
    </div>
  );
}
