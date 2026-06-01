import { useCallback, useEffect, useState } from "react";
import { ActuatorControls } from "./components/ActuatorControls";
import { AlertBanner } from "./components/AlertBanner";
import { AlertPushBanner } from "./components/AlertPushBanner";
import { CameraCard } from "./components/CameraCard";
import { JudgePanel } from "./components/JudgePanel";
import { LiveDescriber } from "./components/LiveDescriber";
import { MockController } from "./components/MockController";
import { QrPanel } from "./components/QrPanel";
import { SensorCard } from "./components/SensorCard";
import { VlmChat } from "./components/VlmChat";
import { gatewayToken } from "./lib/gatewayToken";
import { useSse } from "./lib/sse";
import type { Alert, AlertUpdate, SensorFrame } from "./types";

type BoothInfo = {
  judge_model?: string;
  vision_model?: string;
  vlm_model?: string;
  ollama_url?: string;
};

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

function useUtcClock(): { hms: string; epochMs: string } {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    // Tick every 100ms so the epoch-ms suffix actually flickers — it's the
    // tactical "live system" cue. CPU cost is negligible (one Date() + one
    // setState per 100ms).
    const t = setInterval(() => setNow(new Date()), 100);
    return () => clearInterval(t);
  }, []);
  return {
    hms: now.toLocaleTimeString("zh-TW", { hour12: false }),
    epochMs: String(now.getTime() % 1000).padStart(3, "0"),
  };
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
  const { hms, epochMs } = useUtcClock();
  const liveSensors = frames.length > 0;

  // Fetch booth info once on mount so the header status pills show whatever
  // models the plugin is ACTUALLY using (from OPENCLAW_DEMO2_*_MODEL env,
  // which is fed by demo.config.ps1). Without this they're decorative strings.
  const [boothInfo, setBoothInfo] = useState<BoothInfo | null>(null);
  useEffect(() => {
    const token = gatewayToken();
    const url = new URL("/api/booth/info", window.location.origin);
    if (token) url.searchParams.set("token", token);
    fetch(url.toString())
      .then((r) => (r.ok ? r.json() : null))
      .then((data: BoothInfo | null) => {
        if (data) setBoothInfo(data);
      })
      .catch(() => {
        /* booth info is decorative — silent fail */
      });
  }, []);

  return (
    <div className="min-h-screen px-4 py-4 md:px-7 md:py-6 max-w-[1480px] mx-auto">
      {/* === LIVE TELEMETRY STRIP =========================================== */}
      {/* 1px dashed cyan bar at viewport top — always alive. The tactical
          "this system is breathing" cue you spot from across a booth. */}
      <div className="telemetry-strip fixed top-0 inset-x-0 z-[5] pointer-events-none" />

      {/* === HEADER ====================================================== */}
      <header
        className="mb-4 md:mb-5 border border-ink-600 bg-ink-900/70 backdrop-blur-[1px] hud-frame relative animate-stagger-in"
        style={{ animationDelay: "0ms" }}
      >
        <span className="hud-corner" />
        <div className="flex flex-wrap items-stretch">
          {/* Brand mark */}
          <div className="flex items-center gap-3 px-4 py-3 border-r border-ink-600 min-w-0">
            <span className="text-accent-strix font-bold text-xl leading-none animate-breathe">
              ◢◣
            </span>
            <div className="leading-tight">
              <div className="font-mono text-[15px] md:text-base font-bold tracking-hud text-smoke-50">
                SENSOR STATION
              </div>
              <div className="t-meta text-smoke-500">
                <span className="text-accent-photon/80">SYS:OK</span>
                <span className="mx-1.5 text-smoke-600">·</span>
                <span>NET:LAN</span>
                <span className="mx-1.5 text-smoke-600">·</span>
                <span className={liveSensors ? "text-accent-ok" : "text-smoke-500"}>
                  MODE:{liveSensors ? "LIVE" : "STBY"}
                </span>
                <span className="mx-1.5 text-smoke-600">·</span>
                <span>STRIX HALO</span>
              </div>
            </div>
          </div>

          {/* Status pills */}
          <div className="flex-1 flex flex-wrap items-center gap-x-5 gap-y-1 px-4 py-3 min-w-0">
            <StatusPill ok={true} label="gateway" value="18790" />
            <StatusPill
              ok={liveSensors}
              label="ingest"
              value={liveSensors ? "live" : "idle"}
              live={liveSensors}
            />
            <StatusPill ok={true} label="judge" value={boothInfo?.judge_model ?? "..."} />
            <StatusPill ok={true} label="vision" value={boothInfo?.vision_model ?? "..."} />
            <StatusPill ok={true} label="vlm" value={boothInfo?.vlm_model ?? "..."} />
            <StatusPill
              ok={true}
              label="seq"
              value={latest ? String(latest.seq).padStart(5, "0") : "—"}
            />
            <a
              href="#/vlm"
              title="開啟 VLM agent 對話視窗"
              className="ml-auto inline-flex items-center gap-2 border border-accent-photon/70 text-accent-photon hover:bg-accent-photon/10 px-2.5 py-1.5 font-mono text-[11px] tracking-hud transition-colors shadow-[0_0_12px_rgba(0,217,255,0.18)]"
            >
              <span className="w-1.5 h-1.5 bg-accent-photon animate-breathe" aria-hidden />
              [VLM]
            </a>
          </div>

          {/* Clock */}
          <div className="px-4 py-3 border-l border-ink-600 flex flex-col items-end justify-center">
            <span className="t-meta text-smoke-500">utc+8</span>
            <span className="font-mono text-base md:text-lg font-bold tracking-widest text-smoke-100 tnum">
              {hms || "—"}
              <span className="ml-1 text-[10px] text-accent-photon/60 tnum align-baseline">
                .{epochMs}
              </span>
            </span>
          </div>
        </div>
      </header>

      {/* === ALERT BANNER ================================================ */}
      <AlertBanner alert={latestAlert} />

      {/* === LIVE FEED + AUTO DESCRIBER (split) =========================== */}
      {/* Left: existing CameraCard (IRIS-01 stream + manual SCAN button). */}
      {/* Right: LiveDescriber - runs vision-1 against /api/esp32/capture   */}
      {/* every 12s and shows scrolling Chinese descriptions.               */}
      <div
        className="grid grid-cols-1 lg:grid-cols-2 gap-3 md:gap-4 mb-4 md:mb-5 animate-stagger-in items-stretch"
        style={{ animationDelay: "80ms" }}
      >
        <CameraCard />
        <LiveDescriber />
      </div>

      {/* === SENSOR CARDS ================================================ */}
      <main className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5 gap-3 md:gap-4 mb-4 md:mb-5">
        <SensorCard
          index={0}
          slot="01"
          label="TEMP °C"
          unit="°C"
          value={latest ? latest.temp_c.toFixed(1) : "—"}
          history={frames.map((f) => f.temp_c)}
          rule="HEAT_SUSTAINED  > 32  60s"
          threshold={
            latest
              ? {
                  breached: latest.temp_c > 32,
                  severity: "warn",
                  value: 32,
                  op: ">",
                }
              : undefined
          }
        />
        <SensorCard
          index={1}
          slot="02"
          label="HUMID %"
          unit="%RH"
          value={latest ? latest.humidity.toFixed(0) : "—"}
          history={frames.map((f) => f.humidity)}
          rule="—"
        />
        <SensorCard
          index={2}
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
          index={3}
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
            latest && latest.audio_rms !== undefined
              ? {
                  breached: latest.audio_rms > 50000,
                  severity: "info",
                  value: 50000,
                  op: ">",
                }
              : undefined
          }
        />
        <SensorCard
          index={4}
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
            latest && latest.distance_cm !== undefined
              ? {
                  breached: latest.distance_cm < 15,
                  severity: "info",
                  value: 15,
                  op: "<",
                }
              : undefined
          }
        />
      </main>

      {/* === LOG + CONTROL =============================================== */}
      <div
        className="grid grid-cols-1 lg:grid-cols-2 gap-3 md:gap-4 mb-6 animate-stagger-in"
        style={{ animationDelay: "560ms" }}
      >
        <JudgePanel alerts={alerts.slice(-5).reverse()} />
        <ActuatorControls latest={latest} />
      </div>

      {/* === FOOTER ====================================================== */}
      <footer className="border-t border-ink-700 pt-3 mt-2 flex flex-wrap items-center justify-between gap-2 t-meta">
        <span>
          SSE · rule engine · judge-1 / qwen2:1.5b · vision-1 / qwen2.5vl:3b
        </span>
        <span className="text-smoke-500/60">
          demo2 · build W6 · {new Date().toISOString().slice(0, 10)}
        </span>
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
  live,
}: {
  ok: boolean;
  label: string;
  value: string;
  ping?: boolean;
  /** Set true when the pill is fed live, flowing data — switches the dot to
   *  the high-saturation photon cyan and breathes it. Reserve for the one
   *  or two pills that actually reflect a real-time stream. */
  live?: boolean;
}) {
  return (
    <div className="flex items-center gap-2 min-w-0">
      <span
        className={
          live
            ? "live-dot"
            : `w-1.5 h-1.5 ${ok ? "bg-accent-ok" : "bg-smoke-600"} ${ping ? "animate-pulse-dot" : ""}`
        }
        aria-hidden
      />
      <span className="t-meta">{label}</span>
      <span
        className={`font-mono text-xs tracking-widest truncate tnum ${
          live ? "text-accent-photon" : "text-smoke-200"
        }`}
      >
        {value}
      </span>
    </div>
  );
}
