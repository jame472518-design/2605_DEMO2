import { useCallback, useState } from "react";
import { ActuatorControls } from "./components/ActuatorControls";
import { AlertBanner } from "./components/AlertBanner";
import { JudgePanel } from "./components/JudgePanel";
import { SensorCard } from "./components/SensorCard";
import { useSse } from "./lib/sse";
import type { Alert, SensorFrame } from "./types";

const FRAME_BUFFER = 60;
const ALERT_BUFFER = 20;

function parseJson<T>(raw: string): T {
  return JSON.parse(raw) as T;
}

export default function App() {
  const [frames, setFrames] = useState<SensorFrame[]>([]);
  const [alerts, setAlerts] = useState<Alert[]>([]);

  const onFrame = useCallback((f: SensorFrame) => {
    setFrames((prev) => {
      const next = prev.length >= FRAME_BUFFER ? prev.slice(1) : prev.slice();
      next.push(f);
      return next;
    });
  }, []);

  const onAlert = useCallback((a: Alert) => {
    setAlerts((prev) => {
      const idx = prev.findIndex((x) => x.id === a.id);
      if (idx >= 0) {
        // v2 enrichment for an existing alert — replace.
        const next = prev.slice();
        next[idx] = a;
        return next;
      }
      const next = prev.length >= ALERT_BUFFER ? prev.slice(1) : prev.slice();
      next.push(a);
      return next;
    });
  }, []);

  useSse<SensorFrame>("/api/sensor/stream", parseJson, onFrame);
  useSse<Alert>("/api/alert/stream", parseJson, onAlert);

  const latest = frames[frames.length - 1];
  const latestAlert = alerts[alerts.length - 1] ?? null;

  return (
    <div className="min-h-screen px-4 py-4 md:px-6 md:py-6 max-w-7xl mx-auto">
      <header className="mb-4 flex items-baseline justify-between">
        <h1 className="text-xl md:text-2xl font-semibold">demo2 · Sensor Station</h1>
        <span className="font-mono text-xs text-gray-500 tabular-nums">
          {latest ? `seq ${latest.seq}` : "等待資料…"}
        </span>
      </header>

      <AlertBanner alert={latestAlert} />

      <main className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5 gap-3 md:gap-4">
        <SensorCard
          label="溫度"
          unit="°C"
          value={latest ? latest.temp_c.toFixed(1) : "—"}
          history={frames.map((f) => f.temp_c)}
          threshold={
            latest && latest.temp_c > 30
              ? { breached: true, severity: "warn" }
              : undefined
          }
        />
        <SensorCard
          label="濕度"
          unit="%"
          value={latest ? latest.humidity.toFixed(0) : "—"}
          history={frames.map((f) => f.humidity)}
        />
        <SensorCard
          label="動作偵測"
          value={latest ? (latest.pir === 1 ? "活動中" : "靜止") : "—"}
          history={frames.map((f) => f.pir)}
          threshold={
            latest && latest.pir === 1 && latest.lux_raw < 50
              ? { breached: true, severity: "critical" }
              : undefined
          }
        />
        <SensorCard
          label="光感"
          unit="lx"
          value={latest ? String(latest.lux_raw) : "—"}
          history={frames.map((f) => f.lux_raw)}
        />
        <SensorCard
          label="距離"
          unit="cm"
          value={latest ? latest.distance_cm.toFixed(0) : "—"}
          history={frames.map((f) => f.distance_cm)}
          threshold={
            latest && latest.distance_cm < 15
              ? { breached: true, severity: "info" }
              : undefined
          }
        />
      </main>

      <div className="mt-4 md:mt-6 grid grid-cols-1 lg:grid-cols-2 gap-3 md:gap-4">
        <JudgePanel alerts={alerts.slice(-5).reverse()} />
        <ActuatorControls />
      </div>

      <footer className="mt-6 text-xs text-gray-600 text-center">
        SSE · 規則引擎 · Strix Halo demo2
      </footer>
    </div>
  );
}
