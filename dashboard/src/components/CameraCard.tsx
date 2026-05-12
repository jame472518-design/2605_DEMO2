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
  if (state.kind === "idle") return null;
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
          ) : state.kind === "ok" ? (
            <>
              <p className="text-sm text-smoke-100 font-han leading-relaxed">
                {state.description}
              </p>
              <p className="text-[10px] tracking-widest text-smoke-500 font-mono mt-0.5">
                {(state.took_ms / 1000).toFixed(1)}s · qwen2.5vl
              </p>
            </>
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
          label: d.label || `相機 ${i + 1}`,
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
      out.push({ id: SOURCE_ESP32, type: "esp32", label: "ESP32" });
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
        <div className="aspect-video bg-ink-950 border border-ink-700 mt-3 flex items-center justify-center">
          <span className="t-meta text-smoke-500">no feed selected</span>
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
        title="ESP32-S3-CAM via WiFi"
      >
        ESP32
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

function HudOverlay({
  label,
  meta,
  rec,
}: {
  label: string;
  meta?: string;
  rec?: boolean;
}) {
  return (
    <>
      <svg
        className="absolute inset-0 w-full h-full pointer-events-none"
        preserveAspectRatio="none"
        viewBox="0 0 100 100"
      >
        <path d="M 0 6 L 0 0 L 6 0" stroke="#06b6d4" strokeWidth="0.4" fill="none" />
        <path d="M 94 0 L 100 0 L 100 6" stroke="#06b6d4" strokeWidth="0.4" fill="none" />
        <path d="M 0 94 L 0 100 L 6 100" stroke="#06b6d4" strokeWidth="0.4" fill="none" />
        <path d="M 94 100 L 100 100 L 100 94" stroke="#06b6d4" strokeWidth="0.4" fill="none" />
        <g opacity="0.4">
          <line x1="50" y1="44" x2="50" y2="49" stroke="#06b6d4" strokeWidth="0.3" />
          <line x1="50" y1="51" x2="50" y2="56" stroke="#06b6d4" strokeWidth="0.3" />
          <line x1="44" y1="50" x2="49" y2="50" stroke="#06b6d4" strokeWidth="0.3" />
          <line x1="51" y1="50" x2="56" y2="50" stroke="#06b6d4" strokeWidth="0.3" />
          <circle cx="50" cy="50" r="0.6" fill="#06b6d4" />
        </g>
      </svg>
      <div className="scanline-overlay" />
      <div className="camera-vignette" />
      <div className="absolute top-2 left-2 flex items-center gap-2 z-10">
        {rec && (
          <span className="flex items-center gap-1.5 text-[10px] tracking-widest text-accent-danger font-mono">
            <span className="w-1.5 h-1.5 bg-accent-danger rounded-full animate-rec-blink" />
            REC
          </span>
        )}
        <span className="text-[10px] tracking-widest text-smoke-100/70 font-mono px-1.5 py-0.5 bg-ink-950/60">
          {label}
        </span>
      </div>
      {meta && (
        <div className="absolute bottom-2 right-2 text-[9px] tracking-widest text-smoke-100/60 font-mono px-1.5 py-0.5 bg-ink-950/60 z-10">
          {meta}
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
  const [vision, setVision] = useState<VisionState>({ kind: "idle" });
  const lastIpRef = useRef<string | null>(null);

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
  // ESP32's :81/stream allows only one client; the previous tab may still hold
  // the connection — this drops it on our side and the ESP32's keep-alive
  // timeout reclaims it server-side within a few seconds.
  const reconnect = useCallback(() => {
    setImageError(false);
    setVision({ kind: "idle" });
    setStreamKey((k) => k + 1);
    void fetchInfo();
  }, [fetchInfo]);

  useEffect(() => {
    void fetchInfo();
    const t = setInterval(fetchInfo, POLL_INTERVAL_MS);
    return () => clearInterval(t);
  }, [fetchInfo]);

  // Snapshot via ESP32's /capture endpoint (port 80, not :81 — :81 is MJPEG
  // multipart and not blob-friendly for a single grab). Convert to data URL,
  // hand to vision-1. ESP32 firmware sets Access-Control-Allow-Origin: * so
  // cross-origin from 127.0.0.1:18790 → 10.x.x.x:80 works without proxy.
  const describeScene = useCallback(async () => {
    const ip = info?.device_ip;
    if (!ip) return;
    setVision({ kind: "loading" });
    try {
      const r = await fetch(`http://${ip}/capture`);
      if (!r.ok) throw new Error(`/capture HTTP ${r.status}`);
      const blob = await r.blob();
      const dataUrl = await new Promise<string>((resolve, reject) => {
        const fr = new FileReader();
        fr.onload = () => resolve(fr.result as string);
        fr.onerror = () => reject(new Error("FileReader failed"));
        fr.readAsDataURL(blob);
      });
      const reply = await describeImage(dataUrl, "ESP32-S3-CAM");
      setVision({ kind: "ok", description: reply.description, took_ms: reply.took_ms });
    } catch (e) {
      setVision({
        kind: "error",
        message: e instanceof Error ? e.message : String(e),
      });
    }
  }, [info?.device_ip]);

  const streaming = info?.camera_stream_url && !imageError;
  const hudLabel = showLabel
    ? `ESP32 / ${info?.device_ip ?? "—"}`
    : `IRIS-01 / ${info?.device_ip ?? "OFFLINE"}`;

  return (
    <div className="relative">
      <div className="aspect-video bg-ink-950 overflow-hidden relative border border-ink-700">
        {streaming ? (
          <>
            <img
              key={streamKey}
              src={info!.camera_stream_url!}
              alt="ESP32 camera live stream"
              className="w-full h-full object-cover"
              onError={() => setImageError(true)}
            />
            <HudOverlay label={hudLabel} meta="MJPEG / 640×480" rec />
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
        ) : (
          <>
            <HudOverlay label={hudLabel} />
            <div className="absolute inset-0 flex items-center justify-center">
              <div className="text-center px-6 max-w-md">
                <p className="t-meta text-smoke-500 mb-1">no signal</p>
                <p className="text-xs text-smoke-400 font-mono tracking-wide mb-3">
                  {info?.device_ip
                    ? "影像載入失敗,可能是上一條 MJPEG 連線還沒釋放"
                    : "等待 ESP32 連線到 plugin"}
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
            <HudOverlay label={hudLabel} meta="getUserMedia" rec />
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
            <HudOverlay label={hudLabel} />
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
            <HudOverlay label={hudLabel} />
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
