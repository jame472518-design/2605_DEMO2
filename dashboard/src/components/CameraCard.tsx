import { useEffect, useState } from "react";
import { gatewayToken } from "../lib/gatewayToken";
import type { DeviceInfo } from "../types";

const POLL_INTERVAL_MS = 30_000;

/**
 * Live camera card for the ESP32-S3-CAM. Polls /api/device-info to learn the
 * device's LAN IP, then loads its MJPEG stream directly via <img src=...:81/stream>.
 *
 * Why <img>? Browsers stream multipart/x-mixed-replace MJPEG into <img> as a
 * continuous animation — same pattern the previous ESP32 project used. No
 * <video>, no MediaSource, no proxy through the plugin.
 *
 * The plugin doesn't proxy the stream; the browser hits ESP32 directly.
 * ESP32 firmware sets Access-Control-Allow-Origin: * so cross-origin works.
 */
export function CameraCard() {
  const [info, setInfo] = useState<DeviceInfo | null>(null);
  const [imageError, setImageError] = useState(false);
  const [streamKey, setStreamKey] = useState(0); // bump to force <img> reload

  useEffect(() => {
    let cancelled = false;
    const fetchInfo = async () => {
      try {
        const token = gatewayToken();
        const url = new URL("/api/device-info", window.location.origin);
        if (token) url.searchParams.set("token", token);
        const r = await fetch(url.toString());
        if (!r.ok || cancelled) return;
        const data = (await r.json()) as DeviceInfo;
        setInfo(data);
        // If the IP changed (ESP32 reboot, DHCP renewal), reload the <img>
        if (data.camera_stream_url && data.device_ip !== info?.device_ip) {
          setStreamKey((k) => k + 1);
          setImageError(false);
        }
      } catch {
        /* ignore — keep last good state, retry next tick */
      }
    };
    fetchInfo();
    const t = setInterval(fetchInfo, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const streaming = info?.camera_stream_url && !imageError;

  return (
    <section className="bg-ink-900 border border-ink-700 rounded-lg p-4">
      <div className="flex items-baseline justify-between mb-3">
        <h2 className="text-sm uppercase tracking-wide text-gray-400">即時影像</h2>
        {info?.device_ip ? (
          <span className="font-mono text-xs text-gray-500">
            {info.device_id ?? "esp32"} · {info.device_ip}
            {streaming ? "" : " · 影像離線"}
          </span>
        ) : (
          <span className="text-xs text-gray-500">尚無裝置</span>
        )}
      </div>
      <div className="aspect-video bg-ink-950 rounded overflow-hidden flex items-center justify-center">
        {streaming ? (
          <img
            key={streamKey}
            src={info!.camera_stream_url!}
            alt="ESP32 camera live stream"
            className="w-full h-full object-cover"
            onError={() => setImageError(true)}
          />
        ) : (
          <div className="text-sm text-gray-500 text-center px-6 py-12">
            {info?.device_ip
              ? "影像載入失敗,確認 ESP32 在線且 :81/stream 可達"
              : "等待 ESP32 連線到 plugin(/api/sensor/ingest)…"}
          </div>
        )}
      </div>
    </section>
  );
}
