import { useEffect, useState } from "react";
import { gatewayToken } from "../lib/gatewayToken";
import type { DeviceInfo } from "../types";

/**
 * LiveCamera — minimal full-bleed live view for the simplified analysis
 * dashboard. Shows the IRIS-01 ESP32 MJPEG stream when fresh, otherwise a
 * neutral "no camera" placeholder.
 *
 * No buttons, no labels, no chrome — the surrounding LiveDescriber panel
 * supplies all narrative. This component is just a window.
 */

const POLL_INTERVAL_MS = 5_000;

export function LiveCamera() {
  const [info, setInfo] = useState<DeviceInfo | null>(null);
  const [streamKey, setStreamKey] = useState(0);

  useEffect(() => {
    let alive = true;
    const fetchInfo = async () => {
      try {
        const token = gatewayToken();
        const url = new URL("/api/device-info", window.location.origin);
        if (token) url.searchParams.set("token", token);
        const r = await fetch(url.toString());
        if (!alive) return;
        if (r.ok) {
          const data = (await r.json()) as DeviceInfo;
          setInfo((prev) => {
            if (prev?.device_ip !== data.device_ip) {
              // Force <img> remount on IP change so MJPEG reconnects.
              setStreamKey((k) => k + 1);
            }
            return data;
          });
        }
      } catch {
        /* silent — keep showing last known */
      }
    };
    void fetchInfo();
    const id = setInterval(fetchInfo, POLL_INTERVAL_MS);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);

  const hasDevice = info?.camera_stream_url != null;

  if (!hasDevice) {
    return (
      <div className="card relative flex items-center justify-center bg-ink-950 min-h-[400px] lg:min-h-[88vh]">
        <span className="hud-corner" />
        <div className="text-center px-6">
          <div className="text-7xl mb-4 opacity-30">▢</div>
          <div className="t-meta text-smoke-400 mb-2">NO CAMERA</div>
          <div className="font-han text-smoke-300 text-base">
            等待 IRIS-01 連線
          </div>
          <div className="font-mono text-[11px] text-smoke-500 mt-3 tracking-widest">
            poll every {POLL_INTERVAL_MS / 1000}s
          </div>
        </div>
      </div>
    );
  }

  const token = gatewayToken();
  const u = new URL("/api/esp32/stream", window.location.origin);
  if (token) u.searchParams.set("token", token);
  u.searchParams.set("_k", String(streamKey));

  return (
    <div className="card hud-frame relative overflow-hidden bg-ink-950 min-h-[400px] lg:min-h-[88vh] flex items-center justify-center text-accent-photon">
      <span className="hud-corner" />
      <img
        key={streamKey}
        src={u.toString()}
        alt="IRIS-01 live"
        className="w-full h-full object-contain"
      />
      <div className="absolute top-3 left-3 bg-ink-950/70 text-accent-photon font-mono text-[10px] tracking-widest px-2 py-1 z-10">
        IRIS-01 · {info!.device_ip}
      </div>
      <div className="absolute top-3 right-3 inline-flex items-center gap-1.5 bg-ink-950/70 px-2 py-1 text-[10px] tracking-widest font-mono text-accent-danger z-10">
        <span className="w-1.5 h-1.5 bg-accent-danger animate-rec-blink" />
        LIVE
      </div>
    </div>
  );
}
