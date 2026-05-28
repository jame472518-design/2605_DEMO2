import { useEffect, useState } from "react";
import QRCode from "qrcode";
import { gatewayToken } from "../lib/gatewayToken";

type BoothInfo = {
  ok: boolean;
  lan_ips: string[];
  port: number;
  https_port?: number | null;
};

/**
 * Floating QR widget pinned to the bottom-right corner. Booth visitors on the
 * same WiFi can scan with their phone to see the dashboard on their own
 * screen. URL is derived from /api/booth/info (LAN IP) + current page token.
 *
 * Renders nothing until plugin reports at least one private-network IP — so
 * if you're running on a non-LAN host (laptop in airplane mode, plugin
 * binding only to loopback, etc.) the widget self-hides instead of showing a
 * useless 127.0.0.1 QR.
 */
export function QrPanel() {
  const [lanUrl, setLanUrl] = useState<string | null>(null);
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      const token = gatewayToken();
      const probe = new URL("/api/booth/info", window.location.origin);
      if (token) probe.searchParams.set("token", token);
      try {
        const r = await fetch(probe.toString());
        if (!r.ok || cancelled) return;
        const data = (await r.json()) as BoothInfo;
        if (!data.ok || data.lan_ips.length === 0) return;
        const ip = data.lan_ips[0]!;
        // Prefer HTTPS if the proxy is up — phones need a secure context for
        // getUserMedia on a LAN IP. Fall back to plain HTTP if proxy isn't
        // running (phones still see the dashboard + ESP32 stream, just no
        // webcam SCAN from their own camera).
        const full = data.https_port
          ? `https://${ip}:${data.https_port}/?token=${token ?? ""}`
          : `http://${ip}:${data.port}/?token=${token ?? ""}`;
        if (cancelled) return;
        setLanUrl(full);
        const dataUrl = await QRCode.toDataURL(full, {
          margin: 1,
          width: 320,
          errorCorrectionLevel: "M",
          color: { dark: "#0a0a0a", light: "#ffffff" },
        });
        if (!cancelled) setQrDataUrl(dataUrl);
      } catch {
        /* silently disabled */
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, []);

  if (!lanUrl || !qrDataUrl) return null;

  return (
    <>
      <button
        type="button"
        onClick={() => setExpanded(true)}
        title="點擊放大"
        className="fixed bottom-4 right-4 z-30 border border-ink-600 bg-ink-900/90 backdrop-blur-sm p-2 hover:border-accent-info hover:shadow-[0_0_18px_rgba(0,217,255,0.35)] transition-colors group"
      >
        <img
          src={qrDataUrl}
          alt="LAN dashboard QR"
          className="w-20 h-20 block"
        />
        <div className="mt-1 text-[8px] tracking-widest font-mono text-smoke-400 group-hover:text-smoke-100 text-center">
          📱 SCAN
        </div>
      </button>

      {expanded && (
        <div
          className="fixed inset-0 z-50 bg-ink-950/90 backdrop-blur-sm flex items-center justify-center p-6"
          onClick={() => setExpanded(false)}
        >
          <div
            className="hud-frame relative border border-accent-info bg-ink-900 p-6 max-w-md"
            onClick={(e) => e.stopPropagation()}
          >
            <span className="hud-corner" />
            <div className="t-meta text-accent-info mb-2 text-center">
              scan to view on your phone
            </div>
            <p className="text-[10px] tracking-widest font-mono text-smoke-500 text-center mb-4">
              (need to be on the same WiFi as this PC)
            </p>
            <div className="hud-frame relative mx-auto w-72 h-72 mb-4 text-accent-photon">
              <span className="hud-corner" />
              <img
                src={qrDataUrl}
                alt="LAN dashboard QR — large"
                className="w-full h-full bg-white p-2 block"
              />
              <div className="scanline-overlay" />
            </div>
            <p className="text-xs font-mono text-smoke-300 break-all text-center leading-relaxed">
              {lanUrl}
            </p>
            <button
              type="button"
              onClick={() => setExpanded(false)}
              className="mt-4 w-full border border-ink-600 hover:border-ink-500 text-smoke-300 font-mono text-xs tracking-widest py-2"
            >
              CLOSE  (or click outside)
            </button>
          </div>
        </div>
      )}
    </>
  );
}
