import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { gatewayToken } from "../lib/gatewayToken";
import type { DeviceInfo } from "../types";

const POLL_INTERVAL_MS = 30_000;
const STORAGE_ENABLED_KEY = "demo2.cameraEnabled.v2";

const SOURCE_ESP32 = "esp32";

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
    for (const w of webcams) {
      if (enabled.has(w.deviceId)) {
        out.push({ id: w.deviceId, type: "webcam", label: w.label });
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
}: {
  webcams: WebcamInfo[];
  enabled: Set<string>;
  onToggle: (id: string) => void;
  onRescan: () => void;
  discoveryError: string | null;
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
  const lastIpRef = useRef<string | null>(null);

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
        if (data.camera_stream_url && data.device_ip !== lastIpRef.current) {
          lastIpRef.current = data.device_ip;
          setStreamKey((k) => k + 1);
          setImageError(false);
        }
      } catch {
        /* keep last good state */
      }
    };
    fetchInfo();
    const t = setInterval(fetchInfo, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, []);

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
          </>
        ) : (
          <>
            <HudOverlay label={hudLabel} />
            <div className="absolute inset-0 flex items-center justify-center">
              <div className="text-center px-6 max-w-md">
                <p className="t-meta text-smoke-500 mb-1">no signal</p>
                <p className="text-xs text-smoke-400 font-mono tracking-wide">
                  {info?.device_ip
                    ? "影像載入失敗,確認 ESP32 在線且 :81/stream 可達"
                    : "等待 ESP32 連線到 plugin"}
                </p>
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

    try {
      const stream = await tryConstraints({
        video: { deviceId: { exact: deviceId } },
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
            <button
              type="button"
              onClick={pause}
              className="absolute top-2 right-2 z-20 border border-accent-warn/70 bg-ink-950/70 text-accent-warn hover:bg-accent-warn/20 px-2 py-1 text-[10px] tracking-widest font-mono"
            >
              ⏸ PAUSE
            </button>
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
                <div className="text-center px-6 max-w-md">
                  <p className="text-[10px] tracking-widest text-accent-warn font-mono mb-2">
                    PERMISSION DENIED
                  </p>
                  <p className="text-xs text-smoke-300 font-han mb-3 leading-relaxed">
                    若你在 <b className="text-smoke-100">Snapdragon X / Windows on ARM</b> 機台 — 這是已知的 Chromium 限制,所有瀏覽器旗標都繞不過,**在 Strix Halo (x86_64) 機台上會自動運作**。
                  </p>
                  <p className="text-[11px] tracking-widest text-smoke-500 font-mono mb-2">
                    NORMAL DESKTOP FIX:
                  </p>
                  <ol className="text-xs text-smoke-400 text-left font-han space-y-1 mb-3 list-decimal list-inside">
                    <li>
                      開無痕視窗{" "}
                      <code className="text-smoke-200">Ctrl+Shift+N</code>,貼
                      dashboard URL → 秒跳對話框
                    </li>
                    <li>
                      <code className="text-smoke-200">
                        edge://settings/content/all
                      </code>{" "}
                      搜 127.0.0.1 → 全刪
                    </li>
                  </ol>
                  <button
                    type="button"
                    onClick={start}
                    className="border border-ink-600 text-smoke-200 hover:bg-ink-700 px-3 py-1.5 font-mono text-xs tracking-widest"
                  >
                    ▸ RETRY
                  </button>
                </div>
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
