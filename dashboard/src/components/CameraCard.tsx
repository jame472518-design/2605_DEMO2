import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { describeImage } from "../lib/api";
import { gatewayToken } from "../lib/gatewayToken";
import type { DeviceInfo } from "../types";

type VisionState =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "ok"; description: string; took_ms: number }
  | { kind: "error"; message: string };

// ---------------------------------------------------------------------------
// "Permission denied" recovery panel — browser-aware instructions
// ---------------------------------------------------------------------------

type BrowserHint =
  | "chrome-android"
  | "firefox-android"
  | "chrome-desktop"
  | "firefox-desktop"
  | "edge-desktop"
  | "safari"
  | "other";

function detectBrowser(): BrowserHint {
  if (typeof navigator === "undefined") return "other";
  const ua = navigator.userAgent;
  const android = /Android/i.test(ua);
  if (/Edg\//.test(ua)) return "edge-desktop";
  if (/Firefox/.test(ua)) return android ? "firefox-android" : "firefox-desktop";
  if (/Chrome|Chromium|CriOS/.test(ua))
    return android ? "chrome-android" : "chrome-desktop";
  if (/Safari/.test(ua)) return "safari";
  return "other";
}

const RECOVERY_STEPS: Record<BrowserHint, string[]> = {
  "chrome-android": [
    "點網址列**左邊**的 🔒 / 🚫 / 危險圖示",
    "點「權限」(Permissions)",
    "找「相機」(Camera) → 改成「允許」(Allow)",
    "回到這個分頁,按下方的 RETRY",
  ],
  "firefox-android": [
    "Firefox Android 一旦拒絕,沒有重設站台權限的 UI",
    "請改用 Chrome 開這個 URL,或長按網址列圖示找站台設定清除",
    "(自簽憑證的 Firefox Android 也不能 bypass,Chrome 才行)",
  ],
  "chrome-desktop": [
    "點網址列左邊的 🔒 / 🚫 圖示",
    "「網站設定」(Site settings) → 「相機」→「允許」",
    "回到分頁按下方 RETRY",
  ],
  "edge-desktop": [
    "點網址列左邊的 🔒 圖示",
    "「此網站的權限」→「相機」→「允許」",
    "回到分頁按下方 RETRY",
  ],
  "firefox-desktop": [
    "點網址列左邊的盾牌 / 鎖頭圖示",
    "找到「相機」這一列 → 「移除暫時封鎖」或改成「允許」",
    "回到分頁按下方 RETRY",
  ],
  safari: [
    "Safari 選單 → 「設定」(⌘,)→「網站」→「相機」",
    "找到這個 host → 改成「允許」",
    "回到分頁按下方 RETRY",
  ],
  other: [
    "在瀏覽器網址列旁找鎖頭/權限圖示,把「相機」改成允許",
    "回到分頁按下方 RETRY",
  ],
};

function DeniedHelp({ onRetry }: { onRetry: () => void }) {
  const [browser] = useState<BrowserHint>(detectBrowser);
  const steps = RECOVERY_STEPS[browser];
  const isAndroid = browser === "chrome-android" || browser === "firefox-android";
  return (
    <div className="text-center px-6 max-w-md py-4">
      <p className="text-[10px] tracking-widest text-accent-warn font-mono mb-2">
        PERMISSION DENIED
      </p>
      <p className="text-xs text-smoke-300 font-han mb-3 leading-relaxed">
        瀏覽器擋掉了相機權限。{isAndroid ? "在手機上恢復步驟:" : "解除步驟:"}
      </p>
      <ol className="text-left text-xs text-smoke-300 font-han space-y-1.5 mb-4 list-decimal list-inside leading-relaxed">
        {steps.map((s, i) => (
          <li
            key={i}
            // markdown-lite: bold inside the string via **x**
            dangerouslySetInnerHTML={{
              __html: s.replace(
                /\*\*(.+?)\*\*/g,
                '<b class="text-smoke-100">$1</b>',
              ),
            }}
          />
        ))}
      </ol>
      <p className="text-[10px] tracking-widest text-smoke-500/70 font-mono mb-3">
        browser: {browser}
      </p>
      <button
        type="button"
        onClick={onRetry}
        className="border border-accent-info text-accent-info hover:bg-accent-info/10 px-4 py-2 font-mono text-xs tracking-widest"
      >
        ▸ RETRY
      </button>
    </div>
  );
}

function VisionOverlay({
  state,
  onDismiss,
}: {
  state: VisionState;
  onDismiss: () => void;
}) {
  // The "ok" (description) case is rendered by the right-side LiveDescriber
  // panel via a window event - skip it here so the result doesn't show twice.
  if (state.kind === "idle" || state.kind === "ok") return null;
  return (
    <div className="absolute bottom-0 left-0 right-0 z-10 bg-ink-950/85 border-t border-accent-info/40 backdrop-blur-sm">
      <div className="flex items-start gap-2 p-2">
        <span className="text-[10px] tracking-widest text-accent-info font-mono mt-0.5 shrink-0">
          👁 VISION-1
        </span>
        <div className="flex-1 min-w-0">
          {state.kind === "loading" ? (
            <p className="text-xs text-smoke-300 font-han animate-pulse-dot">
              agent 分析中… (VLM 約 5-60 秒,首次更久)
            </p>
          ) : (
            <p className="text-xs text-accent-danger font-mono break-all">
              {state.message}
            </p>
          )}
        </div>
        <button
          type="button"
          onClick={onDismiss}
          className="text-smoke-500 hover:text-smoke-100 text-base leading-none font-mono shrink-0"
          title="關閉"
        >
          ×
        </button>
      </div>
    </div>
  );
}

const POLL_INTERVAL_MS = 30_000;
const STORAGE_ENABLED_KEY = "demo2.cameraEnabled.v3";

const SOURCE_ESP32 = "esp32";
// Synthetic IDs for facingMode-based mobile chips. On phones, enumerated
// device IDs are opaque pre-permission and don't reliably distinguish front
// vs rear cameras — facingMode hints are the contract that actually works.
const SOURCE_FACING_USER = "facing:user";
const SOURCE_FACING_ENV  = "facing:environment";

function isMobileViewport(): boolean {
  if (typeof window === "undefined") return false;
  return window.matchMedia?.("(pointer: coarse)").matches ?? false;
}

type SourceMeta =
  | { id: typeof SOURCE_ESP32; type: "esp32"; label: string }
  | { id: string; type: "webcam"; label: string };

type WebcamInfo = { deviceId: string; label: string };

/**
 * Multi-source live feed card. Each source (ESP32 + any number of webcams —
 * built-in, USB, virtual) is an independent toggle. Toggle several at once
 * and they render side-by-side in a responsive grid. Selections persist in
 * localStorage as a JSON array of source IDs.
 */
export function CameraCard() {
  const [enabled, setEnabled] = useState<Set<string>>(() => {
    try {
      const saved = window.localStorage.getItem(STORAGE_ENABLED_KEY);
      if (saved) {
        const parsed = JSON.parse(saved) as string[];
        if (Array.isArray(parsed)) return new Set(parsed);
      }
    } catch {
      /* ignore */
    }
    return new Set([SOURCE_ESP32]);
  });

  const [webcams, setWebcams] = useState<WebcamInfo[]>([]);
  const [discoveryError, setDiscoveryError] = useState<string | null>(null);
  const mobile = isMobileViewport();

  useEffect(() => {
    window.localStorage.setItem(
      STORAGE_ENABLED_KEY,
      JSON.stringify([...enabled]),
    );
  }, [enabled]);

  // Discover webcams via enumerateDevices. Triggered by:
  //   - Mount (initial probe)
  //   - devicechange event (browser auto-fires when USB cam plugged/unplugged)
  //   - Manual ↻ RESCAN button (some browsers don't fire devicechange reliably,
  //     and USB cams plugged in BEFORE Firefox started may not appear until
  //     manual re-enum)
  const rescan = useCallback(async () => {
    if (!navigator.mediaDevices?.enumerateDevices) {
      setDiscoveryError("瀏覽器不支援 enumerateDevices(需 https 或 localhost)");
      return;
    }
    try {
      const list = await navigator.mediaDevices.enumerateDevices();
      const cams = list
        .filter((d) => d.kind === "videoinput")
        .map((d, i) => ({
          deviceId: d.deviceId,
          label: d.label || `LENS-${String(i + 1).padStart(2, "0")}`,
        }));
      setWebcams(cams);
      setDiscoveryError(null);
    } catch (e) {
      setDiscoveryError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    void rescan();
    navigator.mediaDevices?.addEventListener?.("devicechange", rescan);
    return () => {
      navigator.mediaDevices?.removeEventListener?.("devicechange", rescan);
    };
  }, [rescan]);

  const toggle = useCallback((id: string) => {
    setEnabled((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const active: SourceMeta[] = useMemo(() => {
    const out: SourceMeta[] = [];
    if (enabled.has(SOURCE_ESP32)) {
      out.push({ id: SOURCE_ESP32, type: "esp32", label: "IRIS-01" });
    }
    if (mobile) {
      // Mobile: prefer facingMode-based synthetic chips; ignore enumerated
      // devices (their pre-permission deviceIds don't reliably pick the
      // physical camera the user expects).
      if (enabled.has(SOURCE_FACING_USER)) {
        out.push({ id: SOURCE_FACING_USER, type: "webcam", label: "前鏡頭 FRONT" });
      }
      if (enabled.has(SOURCE_FACING_ENV)) {
        out.push({ id: SOURCE_FACING_ENV, type: "webcam", label: "後鏡頭 REAR" });
      }
    } else {
      for (const w of webcams) {
        if (enabled.has(w.deviceId)) {
          out.push({ id: w.deviceId, type: "webcam", label: w.label });
        }
      }
    }
    return out;
  }, [enabled, webcams]);

  const count = active.length;
  const gridClass =
    count <= 1
      ? ""
      : count === 2
        ? "grid grid-cols-1 md:grid-cols-2 gap-3 md:gap-4"
        : count === 3
          ? "grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3 md:gap-4"
          : "grid grid-cols-1 md:grid-cols-2 gap-3 md:gap-4";

  return (
    <section className="hud-frame relative border border-ink-600 bg-ink-900/80 p-4 mb-3 md:mb-4">
      <span className="hud-corner" />

      <div className="flex flex-wrap items-baseline justify-between gap-3 mb-3">
        <div className="flex items-baseline gap-3">
          <span className="t-meta text-smoke-400">live feed</span>
          <span className="text-[10px] tracking-widest text-accent-info">
            ◉ {count} {count === 1 ? "source" : "sources"}
          </span>
        </div>
      </div>

      <SourceToolbar
        webcams={webcams}
        enabled={enabled}
        onToggle={toggle}
        onRescan={rescan}
        discoveryError={discoveryError}
        mobile={mobile}
      />

      {count === 0 ? (
        <div className="aspect-video bg-ink-950 border border-ink-700 mt-3 flex flex-col items-center justify-center relative">
          <span className="t-meta text-smoke-400 mb-1">STANDBY</span>
          <span className="t-meta text-smoke-500">no feed selected</span>
          <div className="telemetry-strip absolute bottom-0 left-0 right-0" />
        </div>
      ) : (
        <div className={`mt-3 ${gridClass}`}>
          {active.map((s) =>
            s.type === "esp32" ? (
              <Esp32View key="esp32" showLabel={count > 1} />
            ) : (
              <WebcamFeed
                key={s.id}
                deviceId={s.id}
                label={s.label}
                showLabel={count > 1}
              />
            ),
          )}
        </div>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Toolbar of source chips
// ---------------------------------------------------------------------------

function SourceToolbar({
  webcams,
  enabled,
  onToggle,
  onRescan,
  discoveryError,
  mobile,
}: {
  webcams: WebcamInfo[];
  enabled: Set<string>;
  onToggle: (id: string) => void;
  onRescan: () => void;
  discoveryError: string | null;
  mobile: boolean;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Chip
        active={enabled.has(SOURCE_ESP32)}
        onClick={() => onToggle(SOURCE_ESP32)}
        title="IRIS-01 · ESP32-S3-CAM 邊緣鏡頭 (WiFi)"
      >
        IRIS-01
      </Chip>
      {mobile ? (
        <>
          <Chip
            active={enabled.has(SOURCE_FACING_USER)}
            onClick={() => onToggle(SOURCE_FACING_USER)}
            title="手機前鏡頭 (facingMode user)"
          >
            FRONT
          </Chip>
          <Chip
            active={enabled.has(SOURCE_FACING_ENV)}
            onClick={() => onToggle(SOURCE_FACING_ENV)}
            title="手機後鏡頭 (facingMode environment)"
          >
            REAR
          </Chip>
        </>
      ) : (
        <>
          {webcams.map((w) => (
            <Chip
              key={w.deviceId}
              active={enabled.has(w.deviceId)}
              onClick={() => onToggle(w.deviceId)}
              title={w.label}
            >
              {truncate(w.label, 22)}
            </Chip>
          ))}
          <button
            type="button"
            onClick={onRescan}
            title="重新掃描相機(USB webcam 剛插上時用)"
            className="inline-flex items-center gap-1.5 border border-ink-600 text-smoke-400 hover:text-smoke-100 hover:border-ink-500 px-2.5 py-1.5 font-mono text-[11px] tracking-widest transition-colors"
          >
            ↻ RESCAN
          </button>
          {webcams.length === 0 && !discoveryError && (
            <span className="t-meta text-smoke-500">
              (尚未掃到 webcam — 啟動後或按 ↻ RESCAN)
            </span>
          )}
          {discoveryError && (
            <span className="text-[10px] tracking-widest font-mono text-accent-warn">
              {discoveryError}
            </span>
          )}
        </>
      )}
    </div>
  );
}

function Chip({
  active,
  onClick,
  title,
  children,
}: {
  active: boolean;
  onClick: () => void;
  title?: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      className={`group inline-flex items-center gap-2 border px-2.5 py-1.5 font-mono text-[11px] tracking-widest transition-colors uppercase ${
        active
          ? "border-accent-info text-accent-info bg-accent-info/10"
          : "border-ink-600 text-smoke-400 hover:text-smoke-100 hover:border-ink-500"
      }`}
    >
      <span
        className={`w-1.5 h-1.5 ${active ? "bg-accent-info" : "bg-smoke-600"}`}
        aria-hidden
      />
      {children}
    </button>
  );
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

// ---------------------------------------------------------------------------
// Shared HUD overlay
// ---------------------------------------------------------------------------

function formatRecTimer(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n: number) => n.toString().padStart(2, "0");
  return `T+${pad(h)}:${pad(m)}:${pad(s)}`;
}

/**
 * Self-contained REC timer. Owns its own `recStartTs` ref + 1s `setInterval`
 * so it doesn't push re-renders up to the parent feed component (Esp32View /
 * WebcamFeed) every second — only this leaf re-renders, the MJPEG <img> and
 * the <video> stay untouched.
 */
function RecBadge() {
  const startRef = useRef<number>(Date.now());
  const [elapsedMs, setElapsedMs] = useState(0);
  useEffect(() => {
    const id = setInterval(() => {
      setElapsedMs(Date.now() - startRef.current);
    }, 1000);
    return () => clearInterval(id);
  }, []);
  return (
    <span className="flex items-center gap-1.5 text-[10px] tracking-widest text-accent-danger font-mono">
      <span className="w-1.5 h-1.5 bg-accent-danger rounded-full animate-rec-blink" />
      REC
      <span className="tnum">{formatRecTimer(elapsedMs)}</span>
    </span>
  );
}

/**
 * Fake-but-believable bitrate / fps readout. Numbers jitter ±~7% every 1.2s
 * for tactical motion. Lives in its own component for the same reason as
 * RecBadge — keep the re-render scope tight so the MJPEG <img> never blinks.
 */
function BitrateIndicator() {
  const [bitrate, setBitrate] = useState(480);
  const [fps, setFps] = useState(24);
  useEffect(() => {
    const id = setInterval(() => {
      // ±34 around 480 (~7%), ±1 around 24
      setBitrate(480 + Math.round((Math.random() * 2 - 1) * 34));
      setFps(24 + Math.round(Math.random() * 2 - 1));
    }, 1200);
    return () => clearInterval(id);
  }, []);
  return (
    <span className="text-smoke-400 font-mono text-[10px] tracking-widest tnum px-1.5 py-0.5 bg-ink-950/60">
      ~ {bitrate} kbps · {fps} fps
    </span>
  );
}

type HudTone = "photon" | "info";

function HudOverlay({
  label,
  meta,
  rec,
  tone = "info",
  showBitrate,
}: {
  label: string;
  meta?: string;
  rec?: boolean;
  tone?: HudTone;
  showBitrate?: boolean;
}) {
  // Tailwind classes pinned per tone so corner brackets (currentColor on SVG)
  // and the label chip match the source family — photon = IRIS-01 (edge eye),
  // info = LENS/webcam (local glass).
  const toneClasses =
    tone === "photon"
      ? {
          svg: "text-accent-photon",
          labelBg: "bg-accent-photon/15",
          labelText: "text-accent-photon",
        }
      : {
          svg: "text-accent-info",
          labelBg: "bg-accent-info/15",
          labelText: "text-accent-info",
        };

  return (
    <>
      <svg
        className={`absolute inset-0 w-full h-full pointer-events-none ${toneClasses.svg}`}
        preserveAspectRatio="none"
        viewBox="0 0 100 100"
      >
        {/* Corner brackets — longer (10 units) and a touch thicker (0.6).
            stroke=currentColor so the host element's text-* class colors them. */}
        <path d="M 0 10 L 0 0 L 10 0" stroke="currentColor" strokeWidth="0.6" fill="none" />
        <path d="M 90 0 L 100 0 L 100 10" stroke="currentColor" strokeWidth="0.6" fill="none" />
        <path d="M 0 90 L 0 100 L 10 100" stroke="currentColor" strokeWidth="0.6" fill="none" />
        <path d="M 90 100 L 100 100 L 100 90" stroke="currentColor" strokeWidth="0.6" fill="none" />
        {/* Center reticule: dashed ring + 4 cardinal tick marks, no fill dot. */}
        <g opacity="0.6">
          <circle
            cx="50"
            cy="50"
            r="6"
            stroke="currentColor"
            strokeWidth="0.6"
            strokeDasharray="2 3"
            fill="none"
          />
          {/* N / S / W / E ticks, ~6 units long, sitting just inside the ring */}
          <line x1="50" y1="44.5" x2="50" y2="46.5" stroke="currentColor" strokeWidth="0.4" />
          <line x1="50" y1="53.5" x2="50" y2="55.5" stroke="currentColor" strokeWidth="0.4" />
          <line x1="44.5" y1="50" x2="46.5" y2="50" stroke="currentColor" strokeWidth="0.4" />
          <line x1="53.5" y1="50" x2="55.5" y2="50" stroke="currentColor" strokeWidth="0.4" />
        </g>
      </svg>
      <div className="scanline-overlay" />
      <div className="camera-vignette" />
      <div className="absolute top-2 left-2 flex items-center gap-2 z-10">
        {rec && <RecBadge />}
        <span
          className={`text-[10px] tracking-widest font-mono px-1.5 py-0.5 ${toneClasses.labelBg} ${toneClasses.labelText}`}
        >
          {label}
        </span>
      </div>
      {(meta || showBitrate) && (
        <div className="absolute bottom-2 right-2 z-10 flex items-center gap-1.5">
          {meta && (
            <span className="text-[9px] tracking-widest text-smoke-100/60 font-mono px-1.5 py-0.5 bg-ink-950/60">
              {meta}
            </span>
          )}
          {showBitrate && <BitrateIndicator />}
        </div>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// ESP32 sub-view
// ---------------------------------------------------------------------------

function Esp32View({ showLabel }: { showLabel: boolean }) {
  const [info, setInfo] = useState<DeviceInfo | null>(null);
  const [imageError, setImageError] = useState(false);
  const [streamKey, setStreamKey] = useState(0);
  const [paused, setPaused] = useState(false);
  const [vision, setVision] = useState<VisionState>({ kind: "idle" });
  const lastIpRef = useRef<string | null>(null);
  const imgRef = useRef<HTMLImageElement | null>(null);

  const fetchInfo = useCallback(async () => {
    try {
      const token = gatewayToken();
      const url = new URL("/api/device-info", window.location.origin);
      if (token) url.searchParams.set("token", token);
      const r = await fetch(url.toString());
      if (!r.ok) return;
      const data = (await r.json()) as DeviceInfo;
      setInfo(data);
      if (data.camera_stream_url && data.device_ip !== lastIpRef.current) {
        lastIpRef.current = data.device_ip;
        setStreamKey((k) => k + 1);
        setImageError(false);
      }
    } catch {
      /* keep last good state */
    }
  }, []);

  // Manual reconnect: force <img> remount + clear error + re-poll device-info.
  // Same Firefox-multipart quirk as pause() — bumping streamKey alone doesn't
  // abort the old connection (the old <img> element is removed but its in-
  // flight stream lingers), so we explicitly blank the live src first.
  const reconnect = useCallback(() => {
    if (imgRef.current) {
      imgRef.current.src = "about:blank";
    }
    setImageError(false);
    setVision({ kind: "idle" });
    setStreamKey((k) => k + 1);
    setPaused(false);
    void fetchInfo();
  }, [fetchInfo]);

  // Pause: release the MJPEG stream so a phone (or any other client) can take
  // the single-client ESP32 :81/stream slot. Firefox keeps multipart/x-mixed-
  // replace connections alive even after the <img> unmounts (waiting for the
  // "next part" to render), so we explicitly blank the src first to force
  // an HTTP abort. THEN unmount via state change.
  const pause = useCallback(() => {
    if (imgRef.current) {
      imgRef.current.src = "about:blank";
    }
    setPaused(true);
    setVision({ kind: "idle" });
  }, []);
  const resume = useCallback(() => {
    setPaused(false);
    setImageError(false);
    setStreamKey((k) => k + 1);
  }, []);

  useEffect(() => {
    void fetchInfo();
    const t = setInterval(fetchInfo, POLL_INTERVAL_MS);
    return () => clearInterval(t);
  }, [fetchInfo]);

  // Auto-retry on stream error — ESP32 releases its single MJPEG slot only
  // on the next write attempt after the previous client disconnects, which
  // is a 2-5s window. Without this, a phone scanning the QR right after the
  // Surface kiosk closes its stream would see "no signal" and have to
  // manually press RECONNECT. Capped at 5 retries to avoid hammering a
  // genuinely-dead device.
  const autoRetryCount = useRef(0);
  useEffect(() => {
    if (!imageError || paused) {
      autoRetryCount.current = 0;
      return;
    }
    if (autoRetryCount.current >= 5) return;
    const t = setTimeout(() => {
      autoRetryCount.current += 1;
      setImageError(false);
      setStreamKey((k) => k + 1);
    }, 2500);
    return () => clearTimeout(t);
  }, [imageError, paused]);

  // Snapshot via plugin proxy /api/esp32/capture (same-origin) — phones
  // loading the dashboard over HTTPS would otherwise get mixed-content
  // blocked when fetching ESP32's HTTP /capture directly.
  const describeScene = useCallback(async () => {
    if (!info?.device_ip) return;
    setVision({ kind: "loading" });
    try {
      const token = gatewayToken();
      const url = new URL("/api/esp32/capture", window.location.origin);
      if (token) url.searchParams.set("token", token);
      const r = await fetch(url.toString());
      if (!r.ok) throw new Error(`/api/esp32/capture HTTP ${r.status}`);
      const blob = await r.blob();
      const dataUrl = await new Promise<string>((resolve, reject) => {
        const fr = new FileReader();
        fr.onload = () => resolve(fr.result as string);
        fr.onerror = () => reject(new Error("FileReader failed"));
        fr.readAsDataURL(blob);
      });
      const reply = await describeImage(dataUrl, "IRIS-01");
      setVision({ kind: "ok", description: reply.description, took_ms: reply.took_ms });
      // Forward to the right-side panel via a window event so the result
      // shows there instead of overlaying the camera feed.
      window.dispatchEvent(
        new CustomEvent("vision-result", {
          detail: {
            description: reply.description,
            took_ms: reply.took_ms,
            source: "IRIS-01",
            ts: Date.now(),
          },
        }),
      );
    } catch (e) {
      setVision({
        kind: "error",
        message: e instanceof Error ? e.message : String(e),
      });
    }
  }, [info?.device_ip]);

  // MJPEG src — goes through plugin proxy (same-origin) for the same
  // mixed-content reason. Pulls token from window.location each time the
  // streamKey bumps so a token rotation gets picked up on reconnect.
  const streamSrc = (() => {
    if (!info?.camera_stream_url) return null;
    const token = gatewayToken();
    const u = new URL("/api/esp32/stream", window.location.origin);
    if (token) u.searchParams.set("token", token);
    // streamKey forces <img> remount on RECONNECT/RESUME via different URL.
    u.searchParams.set("_k", String(streamKey));
    return u.toString();
  })();

  const streaming = info?.camera_stream_url && !imageError && !paused;
  const hudLabel = showLabel
    ? `IRIS-01 / ${info?.device_ip ?? "—"}`
    : `IRIS-01 / ${info?.device_ip ?? "OFFLINE"}`;

  return (
    <div className="relative">
      <div className="aspect-video bg-ink-950 overflow-hidden relative border border-ink-700">
        {streaming && streamSrc ? (
          <>
            <img
              key={streamKey}
              ref={imgRef}
              src={streamSrc}
              alt="IRIS-01 邊緣鏡頭即時影像"
              className="w-full h-full object-cover"
              onError={() => setImageError(true)}
            />
            <HudOverlay
              label={hudLabel}
              meta="MJPEG / 640×480"
              rec
              tone="photon"
              showBitrate={Boolean(streaming)}
            />
            <div className="absolute top-2 right-2 z-20 flex items-center gap-1.5">
              <button
                type="button"
                onClick={describeScene}
                disabled={vision.kind === "loading"}
                title="拍一張交給 vision-1 agent 寫一句中文描述"
                className="border border-accent-info/70 bg-ink-950/70 text-accent-info hover:bg-accent-info/20 disabled:opacity-50 disabled:cursor-wait px-2 py-1 text-[10px] tracking-widest font-mono"
              >
                {vision.kind === "loading" ? "⋯ SCANNING" : "👁 SCAN"}
              </button>
              <button
                type="button"
                onClick={pause}
                title="釋出 MJPEG 連線(讓手機可以接管畫面)"
                className="border border-accent-warn/70 bg-ink-950/70 text-accent-warn hover:bg-accent-warn/20 px-2 py-1 text-[10px] tracking-widest font-mono"
              >
                ⏸ PAUSE
              </button>
              <button
                type="button"
                onClick={reconnect}
                title="重新拉一次 MJPEG 連線(畫面卡住時用)"
                className="border border-smoke-500/60 bg-ink-950/70 text-smoke-300 hover:bg-ink-800 px-2 py-1 text-[10px] tracking-widest font-mono"
              >
                ↻
              </button>
            </div>
            <VisionOverlay
              state={vision}
              onDismiss={() => setVision({ kind: "idle" })}
            />
          </>
        ) : paused ? (
          <>
            <HudOverlay label={hudLabel} tone="photon" />
            <div className="absolute inset-0 flex items-center justify-center">
              <div className="text-center px-6 max-w-md">
                <p className="t-meta text-accent-warn mb-1">stream paused</p>
                <p className="text-xs text-smoke-400 font-han mb-3 leading-relaxed">
                  已釋出 IRIS-01 連線。手機(或任何其他裝置)
                  現在可以掃 QR 接管畫面。要拿回來按下面 ▶ RESUME。
                </p>
                <button
                  type="button"
                  onClick={resume}
                  className="border border-accent-info text-accent-info hover:bg-accent-info/10 px-4 py-2 font-mono text-sm tracking-widest"
                >
                  ▶ RESUME
                </button>
              </div>
            </div>
          </>
        ) : (
          <>
            <HudOverlay label={hudLabel} tone="photon" />
            <div className="absolute inset-0 flex items-center justify-center">
              <div className="text-center px-6 max-w-md">
                <p className="t-meta text-smoke-500 mb-1">no signal</p>
                <p className="text-xs text-smoke-400 font-mono tracking-wide mb-3">
                  {info?.device_ip
                    ? "影像載入失敗,可能是上一條 MJPEG 連線還沒釋放"
                    : "等待 IRIS-01 連線"}
                </p>
                <button
                  type="button"
                  onClick={reconnect}
                  className="border border-accent-info text-accent-info hover:bg-accent-info/10 px-3 py-1.5 font-mono text-xs tracking-widest"
                >
                  ↻ RECONNECT
                </button>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// One webcam feed (independent — multiple instances coexist)
// ---------------------------------------------------------------------------

type FeedState =
  | "checking"
  | "prompt"
  | "active"
  | "paused"
  | "denied"
  | "nodevice"
  | "insecure"
  | "error";

function WebcamFeed({
  deviceId,
  label,
  showLabel,
}: {
  deviceId: string;
  label: string;
  showLabel: boolean;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const [state, setState] = useState<FeedState>("checking");
  const [errorMsg, setErrorMsg] = useState<string>("");
  const [activeLabel, setActiveLabel] = useState<string>(label);
  const [vision, setVision] = useState<VisionState>({ kind: "idle" });

  // Capture current frame → POST to vision-1 agent → show 1-sentence
  // Chinese description as an overlay strip. Doesn't pause the stream.
  const describeScene = useCallback(async () => {
    const v = videoRef.current;
    if (!v || !streamRef.current || v.videoWidth === 0) return;
    setVision({ kind: "loading" });
    const maxW = 640;
    const scale = Math.min(1, maxW / v.videoWidth);
    const w = Math.round(v.videoWidth * scale);
    const h = Math.round(v.videoHeight * scale);
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      setVision({ kind: "error", message: "canvas 2D 不支援" });
      return;
    }
    ctx.drawImage(v, 0, 0, w, h);
    const dataUrl = canvas.toDataURL("image/jpeg", 0.7);
    try {
      const reply = await describeImage(dataUrl, activeLabel);
      setVision({
        kind: "ok",
        description: reply.description,
        took_ms: reply.took_ms,
      });
      // Forward to the right-side panel via a window event so the result
      // shows there instead of overlaying the camera feed.
      window.dispatchEvent(
        new CustomEvent("vision-result", {
          detail: {
            description: reply.description,
            took_ms: reply.took_ms,
            source: activeLabel,
            ts: Date.now(),
          },
        }),
      );
    } catch (e) {
      setVision({
        kind: "error",
        message: e instanceof Error ? e.message : String(e),
      });
    }
  }, [activeLabel]);

  // Pause = release MediaStream tracks. Camera LED turns off; resume calls
  // getUserMedia again (no permission re-prompt since browser remembers grant).
  const pause = useCallback(() => {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    }
    if (videoRef.current) videoRef.current.srcObject = null;
    setState("paused");
  }, []);

  // Re-bind stream → video element after state transitions back to "active"
  // (the <video> element is unmounted while paused/error so the srcObject set
  // inside start() lands on a null ref; this effect catches the re-mount).
  useEffect(() => {
    if (state === "active" && videoRef.current && streamRef.current) {
      if (videoRef.current.srcObject !== streamRef.current) {
        videoRef.current.srcObject = streamRef.current;
        void videoRef.current.play().catch(() => {});
      }
    }
  }, [state]);

  const start = useCallback(async () => {
    setState("checking");
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    }
    if (!navigator.mediaDevices?.getUserMedia) {
      setState("insecure");
      return;
    }

    // Try the strict deviceId match first, then fall back to "any camera"
    // on OverconstrainedError. Snapdragon Surface + Chromium return that
    // error when an unlabeled device-id from a permission-less
    // enumerateDevices is fed back as { exact }. The retry without the
    // constraint succeeds (browser grants permission + picks default cam),
    // and the devicechange event later lets us re-discover with real labels.
    const tryConstraints = async (
      c: MediaStreamConstraints,
    ): Promise<MediaStream> => {
      try {
        return await navigator.mediaDevices.getUserMedia(c);
      } catch (e) {
        const name = e instanceof Error ? e.name : "";
        if (name === "OverconstrainedError" && c.video !== true) {
          return await navigator.mediaDevices.getUserMedia({
            video: true,
            audio: false,
          });
        }
        throw e;
      }
    };

    // Synthetic IDs from mobile FRONT/REAR chips → facingMode constraint.
    // Real enumerated deviceIds → strict deviceId match.
    const facingMatch = deviceId.match(/^facing:(user|environment)$/);
    const videoConstraint: MediaTrackConstraints = facingMatch
      ? { facingMode: { ideal: facingMatch[1] as "user" | "environment" } }
      : { deviceId: { exact: deviceId } };

    try {
      const stream = await tryConstraints({
        video: videoConstraint,
        audio: false,
      });
      streamRef.current = stream;
      if (videoRef.current) videoRef.current.srcObject = stream;
      const track = stream.getVideoTracks()[0];
      if (track && track.label) setActiveLabel(track.label);
      setState("active");
    } catch (e) {
      // Categorize on BOTH error.name (more reliable) AND error.message
      const err = e instanceof Error ? e : new Error(String(e));
      const name = err.name || "Error";
      const msg = err.message || "";
      const full = `${name}: ${msg || "(no message)"}`;

      if (name === "NotAllowedError" || msg.match(/Permission denied/i)) {
        setState("denied");
      } else if (
        name === "NotFoundError" ||
        name === "OverconstrainedError" ||
        msg.match(/Requested device not found/i)
      ) {
        setState("nodevice");
        setErrorMsg(full);
      } else if (msg.match(/secure context|getUserMedia is not/i)) {
        setState("insecure");
      } else if (
        name === "NotReadableError" ||
        name === "TrackStartError" ||
        name === "AbortError"
      ) {
        setState("error");
        setErrorMsg(`${full}\n相機被其他程式占用或硬體無回應。試:關掉 Windows Camera app,重整。`);
      } else {
        setState("error");
        setErrorMsg(full);
      }
    }
  }, [deviceId]);

  useEffect(() => {
    let cancelled = false;

    const probe = async () => {
      if (!navigator.mediaDevices?.getUserMedia) {
        setState("insecure");
        return;
      }
      try {
        const status = await navigator.permissions.query({
          name: "camera" as PermissionName,
        });
        if (cancelled) return;
        if (status.state === "granted") {
          await start();
        } else {
          setState("prompt");
        }
        status.onchange = () => {
          if (status.state === "granted") start();
        };
      } catch {
        setState("prompt");
      }
    };

    probe();
    return () => {
      cancelled = true;
      if (streamRef.current) {
        streamRef.current.getTracks().forEach((t) => t.stop());
        streamRef.current = null;
      }
    };
  }, [start]);

  const hudLabel = `WEBCAM / ${truncate(showLabel ? label : activeLabel, 22)}`;

  return (
    <div className="relative">
      <div className="aspect-video bg-ink-950 overflow-hidden relative border border-ink-700">
        {state === "active" ? (
          <>
            <video
              ref={videoRef}
              autoPlay
              playsInline
              muted
              className="w-full h-full object-cover"
            />
            <HudOverlay label={hudLabel} meta="getUserMedia" rec tone="info" />
            <div className="absolute top-2 right-2 z-20 flex items-center gap-1.5">
              <button
                type="button"
                onClick={describeScene}
                disabled={vision.kind === "loading"}
                title="拍一張交給 vision-1 agent 寫一句中文描述"
                className="border border-accent-info/70 bg-ink-950/70 text-accent-info hover:bg-accent-info/20 disabled:opacity-50 disabled:cursor-wait px-2 py-1 text-[10px] tracking-widest font-mono"
              >
                {vision.kind === "loading" ? "⋯ SCANNING" : "👁 SCAN"}
              </button>
              <button
                type="button"
                onClick={pause}
                className="border border-accent-warn/70 bg-ink-950/70 text-accent-warn hover:bg-accent-warn/20 px-2 py-1 text-[10px] tracking-widest font-mono"
              >
                ⏸ PAUSE
              </button>
            </div>
            <VisionOverlay
              state={vision}
              onDismiss={() => setVision({ kind: "idle" })}
            />
          </>
        ) : state === "paused" ? (
          <>
            <HudOverlay label={hudLabel} tone="info" />
            <div className="absolute inset-0 flex items-center justify-center">
              <button
                type="button"
                onClick={start}
                className="border border-accent-info text-accent-info hover:bg-accent-info/10 px-5 py-2.5 font-mono text-sm tracking-widest"
              >
                ▶ RESUME
              </button>
            </div>
          </>
        ) : (
          <>
            <HudOverlay label={hudLabel} tone="info" />
            <div className="absolute inset-0 flex items-center justify-center">
              {state === "checking" ? (
                <span className="t-meta text-smoke-500 animate-pulse-dot">
                  initializing…
                </span>
              ) : state === "prompt" ? (
                <div className="text-center px-6">
                  <button
                    type="button"
                    onClick={start}
                    className="border border-accent-info text-accent-info hover:bg-accent-info/10 px-5 py-2.5 font-mono text-sm tracking-widest transition-colors"
                  >
                    ▸ ACTIVATE
                  </button>
                  <p className="mt-3 t-meta text-smoke-500">
                    瀏覽器跳對話框時選「允許」
                  </p>
                </div>
              ) : state === "denied" ? (
                <DeniedHelp onRetry={start} />
              ) : state === "nodevice" ? (
                <div className="text-center px-6 max-w-md">
                  <p className="text-xs text-smoke-400 font-mono tracking-wide mb-2">
                    此 device 不可用 / 不存在
                  </p>
                  {errorMsg && (
                    <p className="text-[10px] text-smoke-500/70 font-mono break-all">
                      {errorMsg}
                    </p>
                  )}
                </div>
              ) : state === "insecure" ? (
                <div className="text-center px-6">
                  <p className="t-meta text-smoke-500 mb-1">insecure context</p>
                  <p className="text-xs text-smoke-400 font-mono tracking-wide">
                    需 https 或 http://localhost
                  </p>
                </div>
              ) : (
                <div className="text-center px-6 max-w-md">
                  <p className="t-meta text-accent-danger mb-2">error</p>
                  <p className="text-[11px] text-smoke-200 font-mono break-all whitespace-pre-wrap mb-3">
                    {errorMsg || "(no error message — likely abort)"}
                  </p>
                  <button
                    type="button"
                    onClick={start}
                    className="border border-ink-600 text-smoke-200 hover:bg-ink-700 px-3 py-1.5 font-mono text-xs tracking-widest"
                  >
                    ▸ RETRY
                  </button>
                </div>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
