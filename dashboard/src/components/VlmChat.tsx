import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
  type ClipboardEvent as ReactClipboardEvent,
  type DragEvent,
  type KeyboardEvent,
} from "react";
import { streamVlmChat, type OllamaChatChunk, type VlmTurn } from "../lib/api";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const DEFAULT_MODEL = "qwen2.5vl:3b";
const MAX_LONG_SIDE = 1024; // px — downscale before upload
const JPEG_QUALITY = 0.85;

const EXAMPLE_PROMPTS: string[] = [
  "這張圖看到什麼?",
  "用一句話描述場景",
  "圖中有幾個人?",
  "Describe this image in English.",
];

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type ChatMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
  /** Data URL of the image attached to this user turn, if any. Stored so we
   *  can echo it in the transcript when scrolling back. */
  imageDataUrl?: string;
  /** Set once the assistant turn is fully received and we get total_duration
   *  + eval_count from the Ollama "done" chunk. */
  stats?: { tookMs: number; tokensPerSec: number };
  /** True while the assistant is still streaming this turn. */
  streaming?: boolean;
  /** Filled when the assistant turn failed or aborted. */
  error?: string;
};

type ImageSlot = {
  dataUrl: string;
  /** "image/jpeg" after downscale, or the original mime if not resized. */
  mime: string;
  /** Approximate payload size in bytes (after b64 → byte estimate). */
  approxBytes: number;
  origName: string | null;
  width: number;
  height: number;
  /** True if we shrank the image before encoding. */
  resized: boolean;
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function approxB64Bytes(dataUrl: string): number {
  const comma = dataUrl.indexOf(",");
  const b64 = comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl;
  return Math.floor((b64.length * 3) / 4);
}

function humanBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

/** Load a File or Blob into an HTMLImageElement (via object URL). */
function loadImage(blob: Blob): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => {
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("圖片解碼失敗"));
    };
    img.src = url;
  });
}

/** Auto-downscale to MAX_LONG_SIDE if needed; always re-encode to JPEG so
 *  payload stays small even when the source is a giant PNG. */
async function prepareImage(file: File | Blob, origName: string | null): Promise<ImageSlot> {
  const img = await loadImage(file);
  const longSide = Math.max(img.naturalWidth, img.naturalHeight);
  const resized = longSide > MAX_LONG_SIDE;
  const scale = resized ? MAX_LONG_SIDE / longSide : 1;
  const w = Math.round(img.naturalWidth * scale);
  const h = Math.round(img.naturalHeight * scale);
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("canvas 2D 不支援");
  ctx.drawImage(img, 0, 0, w, h);
  const dataUrl = canvas.toDataURL("image/jpeg", JPEG_QUALITY);
  return {
    dataUrl,
    mime: "image/jpeg",
    approxBytes: approxB64Bytes(dataUrl),
    origName,
    width: w,
    height: h,
    resized,
  };
}

function newId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function VlmChat() {
  const [image, setImage] = useState<ImageSlot | null>(null);
  const [imageError, setImageError] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [draft, setDraft] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [modelLabel, setModelLabel] = useState<string>(DEFAULT_MODEL);
  const [dragOver, setDragOver] = useState(false);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  // ---- image loading -------------------------------------------------------

  const acceptFile = useCallback(async (file: File | Blob, name: string | null) => {
    setImageError(null);
    try {
      const slot = await prepareImage(file, name);
      setImage(slot);
    } catch (e) {
      setImageError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  const onFilePick = useCallback(
    (ev: ChangeEvent<HTMLInputElement>) => {
      const f = ev.target.files?.[0];
      if (f) void acceptFile(f, f.name);
      // reset so the same file can be picked again
      ev.target.value = "";
    },
    [acceptFile],
  );

  const onDrop = useCallback(
    (ev: DragEvent<HTMLDivElement>) => {
      ev.preventDefault();
      setDragOver(false);
      const f = ev.dataTransfer.files?.[0];
      if (f && f.type.startsWith("image/")) {
        void acceptFile(f, f.name);
      } else if (f) {
        setImageError(`不是圖片檔: ${f.type || "unknown"}`);
      }
    },
    [acceptFile],
  );

  const onDragOver = useCallback((ev: DragEvent<HTMLDivElement>) => {
    ev.preventDefault();
    setDragOver(true);
  }, []);
  const onDragLeave = useCallback(() => setDragOver(false), []);

  // Page-level paste listener — only active when the VLM view is mounted.
  useEffect(() => {
    const onPaste = (ev: ClipboardEvent) => {
      const items = ev.clipboardData?.items;
      if (!items) return;
      for (const it of items) {
        if (it.kind === "file" && it.type.startsWith("image/")) {
          const blob = it.getAsFile();
          if (blob) {
            ev.preventDefault();
            void acceptFile(blob, blob.name || "pasted.png");
            return;
          }
        }
      }
    };
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  }, [acceptFile]);

  // Block the browser from opening the image when the drop target misses.
  useEffect(() => {
    const prevent = (e: globalThis.DragEvent) => {
      if (e.dataTransfer?.types?.includes("Files")) e.preventDefault();
    };
    window.addEventListener("dragover", prevent);
    window.addEventListener("drop", prevent);
    return () => {
      window.removeEventListener("dragover", prevent);
      window.removeEventListener("drop", prevent);
    };
  }, []);

  // ---- textarea auto-grow --------------------------------------------------

  useEffect(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    const max = 6 * 22; // ~6 lines at line-height 22px
    ta.style.height = `${Math.min(ta.scrollHeight, max)}px`;
  }, [draft]);

  // ---- autoscroll on new tokens -------------------------------------------

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    // Snap to bottom; cheap to call every render — list is short (chat).
    el.scrollTop = el.scrollHeight;
  }, [messages]);

  // ---- abort on unmount ----------------------------------------------------

  useEffect(() => {
    return () => {
      abortRef.current?.abort();
    };
  }, []);

  // ---- send ----------------------------------------------------------------

  const canSend = draft.trim().length > 0 && !streaming;

  const send = useCallback(async () => {
    const prompt = draft.trim();
    if (!prompt || streaming) return;

    // Build history from prior turns (text only — Ollama VLM only needs
    // the image for the current turn; we still pass past images so the model
    // can ground follow-ups, but the backend handles whatever it likes).
    const history: VlmTurn[] = messages
      .filter((m) => !m.error)
      .map((m) => ({
        role: m.role,
        content: m.content,
        ...(m.imageDataUrl ? { images: [m.imageDataUrl] } : {}),
      }));

    const userMsg: ChatMessage = {
      id: newId(),
      role: "user",
      content: prompt,
      ...(image ? { imageDataUrl: image.dataUrl } : {}),
    };
    const asstId = newId();
    const asstMsg: ChatMessage = {
      id: asstId,
      role: "assistant",
      content: "",
      streaming: true,
    };
    setMessages((prev) => [...prev, userMsg, asstMsg]);
    setDraft("");
    setStreaming(true);

    const ctl = new AbortController();
    abortRef.current = ctl;

    const startedAt = performance.now();

    try {
      const req = {
        prompt,
        ...(image ? { image_b64: image.dataUrl } : {}),
        history,
      };
      let acc = "";
      let lastChunk: OllamaChatChunk | null = null;
      for await (const chunk of streamVlmChat(req, ctl.signal)) {
        lastChunk = chunk;
        if (chunk.error) {
          throw new Error(chunk.error);
        }
        if (chunk.model && chunk.model !== modelLabel) {
          setModelLabel(chunk.model);
        }
        const piece = chunk.message?.content;
        if (piece) {
          acc += piece;
          setMessages((prev) =>
            prev.map((m) => (m.id === asstId ? { ...m, content: acc } : m)),
          );
        }
        if (chunk.done) break;
      }

      // Compute stats — prefer the server-side `total_duration` (ns) and
      // `eval_count` from the final chunk; fall back to wall-clock.
      const elapsedMs = lastChunk?.total_duration
        ? lastChunk.total_duration / 1_000_000
        : performance.now() - startedAt;
      const tokens = lastChunk?.eval_count ?? 0;
      const tokensPerSec = tokens > 0 && elapsedMs > 0
        ? (tokens / (elapsedMs / 1000))
        : 0;
      setMessages((prev) =>
        prev.map((m) =>
          m.id === asstId
            ? {
                ...m,
                streaming: false,
                stats: { tookMs: elapsedMs, tokensPerSec },
              }
            : m,
        ),
      );
    } catch (e) {
      const isAbort =
        (e instanceof DOMException && e.name === "AbortError") ||
        (e instanceof Error && e.name === "AbortError");
      const msg = isAbort
        ? "已中止 (aborted)"
        : e instanceof Error
          ? e.message
          : String(e);
      setMessages((prev) =>
        prev.map((m) =>
          m.id === asstId
            ? { ...m, streaming: false, error: msg }
            : m,
        ),
      );
    } finally {
      setStreaming(false);
      abortRef.current = null;
    }
  }, [draft, streaming, messages, image, modelLabel]);

  const abort = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  const onKeyDown = useCallback(
    (ev: KeyboardEvent<HTMLTextAreaElement>) => {
      // IME (Chinese/Japanese/Korean) composition: nativeEvent.isComposing is
      // true between compositionstart/compositionend. React's synthetic event
      // doesn't surface this so we read it off the native event.
      const composing = ev.nativeEvent.isComposing;
      if (ev.key === "Enter" && !ev.shiftKey && !composing) {
        ev.preventDefault();
        void send();
      }
    },
    [send],
  );

  const onTextareaPaste = useCallback(
    (_ev: ReactClipboardEvent<HTMLTextAreaElement>) => {
      // Image paste is handled by the window listener; let the textarea
      // handle text paste as usual.
    },
    [],
  );

  const clearImage = useCallback(() => {
    setImage(null);
    setImageError(null);
  }, []);

  const newChat = useCallback(() => {
    abortRef.current?.abort();
    setMessages([]);
  }, []);

  const back = useCallback(() => {
    window.location.hash = "";
  }, []);

  // ---- render --------------------------------------------------------------

  const utcClock = useUtcClock();

  return (
    <div className="min-h-screen px-4 py-4 md:px-7 md:py-6 max-w-[1480px] mx-auto flex flex-col">
      {/* === HEADER (matches dashboard's HUD strip) ====================== */}
      <header className="mb-4 md:mb-5 border border-ink-600 bg-ink-900/70 backdrop-blur-[1px] hud-frame relative">
        <span className="hud-corner" />
        <div className="flex flex-wrap items-stretch">
          {/* Brand mark + back affordance */}
          <button
            type="button"
            onClick={back}
            title="返回 sensor station 主畫面"
            className="flex items-center gap-3 px-4 py-3 border-r border-ink-600 min-w-0 text-left hover:bg-ink-800/60 transition-colors"
          >
            <span className="text-accent-strix font-bold text-xl leading-none">◢◣</span>
            <div className="leading-tight">
              <div className="font-mono text-[15px] md:text-base font-bold tracking-hud text-smoke-50">
                VLM AGENT
              </div>
              <div className="t-meta text-smoke-500">
                ← back · demo · 02 · STRIX HALO
              </div>
            </div>
          </button>

          {/* Status pills */}
          <div className="flex-1 flex flex-wrap items-center gap-x-5 gap-y-1 px-4 py-3 min-w-0">
            <StatusPill
              ok={!streaming}
              streaming={streaming}
              label="model"
              value={modelLabel}
            />
            <StatusPill
              ok={!!image}
              label="image"
              value={image ? `${image.width}×${image.height}` : "—"}
            />
            <StatusPill
              ok={messages.length > 0}
              label="turns"
              value={String(messages.filter((m) => m.role === "user").length).padStart(2, "0")}
            />
            <button
              type="button"
              onClick={newChat}
              disabled={messages.length === 0 && !image}
              className="ml-auto inline-flex items-center gap-2 border border-ink-600 text-smoke-300 hover:text-smoke-100 hover:border-ink-500 disabled:opacity-40 disabled:hover:text-smoke-300 disabled:hover:border-ink-600 px-2.5 py-1.5 font-mono text-[11px] tracking-widest transition-colors"
              title="清掉對話與圖片"
            >
              <span className="w-1.5 h-1.5 bg-smoke-500" aria-hidden />
              NEW CHAT
            </button>
          </div>

          {/* Clock */}
          <div className="px-4 py-3 border-l border-ink-600 flex flex-col items-end justify-center">
            <span className="t-meta text-smoke-500">utc{utcClock ? "+8" : ""}</span>
            <span className="font-mono text-base md:text-lg font-bold tracking-widest text-smoke-100 tnum">
              {utcClock || "—"}
            </span>
          </div>
        </div>
      </header>

      {/* === MAIN GRID =================================================== */}
      <main className="flex-1 grid grid-cols-1 lg:grid-cols-[480px_1fr] gap-3 md:gap-4 min-h-0">
        <ImageDock
          image={image}
          dragOver={dragOver}
          error={imageError}
          onPick={() => fileInputRef.current?.click()}
          onClear={clearImage}
          onDrop={onDrop}
          onDragOver={onDragOver}
          onDragLeave={onDragLeave}
        />
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          onChange={onFilePick}
          className="hidden"
        />

        <ChatPanel
          scrollRef={scrollRef}
          textareaRef={textareaRef}
          messages={messages}
          draft={draft}
          setDraft={setDraft}
          streaming={streaming}
          canSend={canSend}
          onSend={send}
          onAbort={abort}
          onKeyDown={onKeyDown}
          onTextareaPaste={onTextareaPaste}
          onExamplePick={(p) => {
            setDraft(p);
            textareaRef.current?.focus();
          }}
          hasImage={!!image}
        />
      </main>

      {/* === FOOTER ====================================================== */}
      <footer className="border-t border-ink-700 pt-3 mt-4 flex flex-wrap items-center justify-between gap-2 t-meta">
        <span>vlm chat · {modelLabel} · ndjson stream</span>
        <span className="text-smoke-500/60">
          demo2 · vlm-page · {new Date().toISOString().slice(0, 10)}
        </span>
      </footer>

      <BlinkStyles />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Header utils — duplicated tiny pieces so VlmChat is self-contained and
// doesn't force us to refactor App.tsx for shared chrome.
// ---------------------------------------------------------------------------

function StatusPill({
  ok,
  streaming,
  label,
  value,
}: {
  ok: boolean;
  streaming?: boolean;
  label: string;
  value: string;
}) {
  const dot = streaming
    ? "bg-accent-warn animate-pulse-dot"
    : ok
      ? "bg-accent-ok"
      : "bg-smoke-600";
  return (
    <div className="flex items-center gap-2 min-w-0">
      <span className={`w-1.5 h-1.5 ${dot}`} aria-hidden />
      <span className="t-meta">{label}</span>
      <span className="font-mono text-xs text-smoke-200 tracking-widest truncate">
        {value}
      </span>
    </div>
  );
}

function useUtcClock(): string {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(t);
  }, []);
  return now.toLocaleTimeString("zh-TW", { hour12: false });
}

// ---------------------------------------------------------------------------
// Left column — image dock
// ---------------------------------------------------------------------------

function ImageDock({
  image,
  dragOver,
  error,
  onPick,
  onClear,
  onDrop,
  onDragOver,
  onDragLeave,
}: {
  image: ImageSlot | null;
  dragOver: boolean;
  error: string | null;
  onPick: () => void;
  onClear: () => void;
  onDrop: (e: DragEvent<HTMLDivElement>) => void;
  onDragOver: (e: DragEvent<HTMLDivElement>) => void;
  onDragLeave: () => void;
}) {
  return (
    <section className="hud-frame relative border border-ink-600 bg-ink-900/80 p-4 flex flex-col min-h-[260px]">
      <span className="hud-corner" />
      <div className="flex items-baseline justify-between mb-3">
        <span className="t-meta">input image</span>
        <span className="text-[10px] tracking-widest font-mono text-smoke-400/70">
          /IM
        </span>
      </div>

      {image ? (
        <div className="flex-1 flex flex-col min-h-0">
          <div className="relative flex-1 min-h-0 bg-ink-950 border border-ink-700 flex items-center justify-center overflow-hidden">
            <img
              src={image.dataUrl}
              alt={image.origName ?? "input"}
              className="max-w-full max-h-[70vh] object-contain"
            />
            <button
              type="button"
              onClick={onClear}
              title="清掉圖片"
              className="absolute top-2 right-2 z-10 border border-ink-500 bg-ink-950/80 text-smoke-300 hover:text-accent-danger hover:border-accent-danger px-2 py-0.5 font-mono text-xs tracking-widest leading-none"
            >
              × CLEAR
            </button>
            <div className="absolute bottom-2 left-2 right-2 text-[10px] tracking-widest font-mono text-smoke-200/80 bg-ink-950/70 px-1.5 py-0.5 truncate">
              {image.origName ?? "image"} · {image.width}×{image.height} ·{" "}
              {humanBytes(image.approxBytes)}
              {image.resized && (
                <span className="text-accent-info">
                  {" · DOWNSCALED → "}
                  {MAX_LONG_SIDE}
                  {"px"}
                </span>
              )}
            </div>
          </div>
          <button
            type="button"
            onClick={onPick}
            className="mt-3 border border-ink-600 text-smoke-300 hover:text-smoke-100 hover:border-ink-500 px-3 py-2 font-mono text-[11px] tracking-widest transition-colors"
          >
            ▸ REPLACE IMAGE
          </button>
        </div>
      ) : (
        <button
          type="button"
          onClick={onPick}
          onDrop={onDrop as unknown as (e: DragEvent<HTMLButtonElement>) => void}
          onDragOver={onDragOver as unknown as (e: DragEvent<HTMLButtonElement>) => void}
          onDragLeave={onDragLeave}
          className={`flex-1 min-h-[260px] relative border border-dashed transition-colors flex items-center justify-center overflow-hidden ${
            dragOver
              ? "border-accent-info bg-accent-info/5"
              : "border-ink-600 hover:border-ink-500 bg-ink-950/40"
          }`}
        >
          <div className="telemetry-strip absolute top-0 inset-x-0" />
          <div className="scanline-overlay" />
          <div className="text-center px-6 pointer-events-none">
            <p className="text-[10px] tracking-hud text-accent-info font-mono mb-2">
              DROP IMAGE · CLICK · PASTE
            </p>
            <p className="text-xs text-smoke-400 font-han leading-relaxed">
              拖一張圖進來,或點這裡開啟檔案選單,或直接 Ctrl+V 貼上剪貼簿截圖
            </p>
            <p className="mt-3 text-[10px] tracking-widest text-smoke-500/70 font-mono">
              JPEG · PNG · WEBP · auto-downscale → {MAX_LONG_SIDE}px
            </p>
          </div>
        </button>
      )}

      {error && (
        <p className="mt-3 text-[11px] font-mono tracking-wide text-accent-danger break-all">
          {error}
        </p>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Right column — chat panel
// ---------------------------------------------------------------------------

function ChatPanel({
  scrollRef,
  textareaRef,
  messages,
  draft,
  setDraft,
  streaming,
  canSend,
  onSend,
  onAbort,
  onKeyDown,
  onTextareaPaste,
  onExamplePick,
  hasImage,
}: {
  scrollRef: React.RefObject<HTMLDivElement | null>;
  textareaRef: React.RefObject<HTMLTextAreaElement | null>;
  messages: ChatMessage[];
  draft: string;
  setDraft: (s: string) => void;
  streaming: boolean;
  canSend: boolean;
  onSend: () => void;
  onAbort: () => void;
  onKeyDown: (e: KeyboardEvent<HTMLTextAreaElement>) => void;
  onTextareaPaste: (e: ReactClipboardEvent<HTMLTextAreaElement>) => void;
  onExamplePick: (s: string) => void;
  hasImage: boolean;
}) {
  return (
    <section className="hud-frame relative border border-ink-600 bg-ink-900/80 flex flex-col min-h-[420px]">
      <span className="hud-corner" />

      {/* sub-header inside chat panel */}
      <div className="px-4 pt-3 pb-2 border-b border-ink-700 flex items-baseline justify-between">
        <span className="t-meta">transcript</span>
        <span className="text-[10px] tracking-widest font-mono text-smoke-400/70">
          /CH
        </span>
      </div>

      {/* message list */}
      <div
        ref={scrollRef}
        className="flex-1 min-h-0 overflow-y-auto px-4 py-4 space-y-3"
      >
        {messages.length === 0 ? (
          <EmptyState
            hasImage={hasImage}
            onPick={onExamplePick}
          />
        ) : (
          messages.map((m) => <MessageBubble key={m.id} message={m} />)
        )}
      </div>

      {/* input area */}
      <div className="border-t border-ink-700 p-3 md:p-4">
        <div className="flex items-end gap-2">
          <textarea
            ref={textareaRef}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={onKeyDown}
            onPaste={onTextareaPaste}
            placeholder={
              hasImage
                ? "問模型這張圖… (Enter 送出 · Shift+Enter 換行)"
                : "輸入訊息… 也可以先丟一張圖再問"
            }
            rows={1}
            className="flex-1 bg-ink-800 border border-ink-600 focus:border-accent-info focus:outline-none text-smoke-100 font-mono text-sm leading-[22px] px-3 py-2 resize-none placeholder:text-smoke-500/70"
            style={{ maxHeight: "132px" }}
          />
          {streaming ? (
            <button
              type="button"
              onClick={onAbort}
              className="border border-accent-danger text-accent-danger hover:bg-accent-danger/10 px-4 py-2 font-mono text-xs tracking-hud transition-colors h-fit"
            >
              ▣ ABORT
            </button>
          ) : (
            <button
              type="button"
              onClick={onSend}
              disabled={!canSend}
              className="border border-accent-info text-accent-info hover:bg-accent-info/10 disabled:opacity-30 disabled:hover:bg-transparent disabled:cursor-not-allowed px-4 py-2 font-mono text-xs tracking-hud transition-colors h-fit"
            >
              ▸ SEND
            </button>
          )}
        </div>
        <p className="mt-2 text-[10px] tracking-widest font-mono text-smoke-500/60">
          ENTER: SEND · SHIFT+ENTER: NEWLINE · CTRL+V: 貼圖
        </p>
      </div>
    </section>
  );
}

function EmptyState({
  hasImage,
  onPick,
}: {
  hasImage: boolean;
  onPick: (s: string) => void;
}) {
  return (
    <div className="h-full min-h-[260px] flex flex-col items-center justify-center text-center px-4">
      <p className="text-[11px] tracking-hud text-accent-info font-mono mb-3">
        ╱╱ READY
      </p>
      <p className="text-sm text-smoke-300 font-han max-w-md leading-relaxed mb-5">
        {hasImage
          ? "圖已就位。問點東西看看 — 中文/English 都可以,模型會盡量沿用你的語言。"
          : "可以先丟一張圖再聊,也可以純文字對話。Strix Halo 本地推論,不離開這台機器。"}
      </p>
      <div className="flex flex-wrap items-center justify-center gap-2 max-w-lg">
        {EXAMPLE_PROMPTS.map((p) => (
          <button
            key={p}
            type="button"
            onClick={() => onPick(p)}
            className="border border-ink-600 hover:border-accent-info hover:text-accent-info text-smoke-300 px-3 py-1.5 font-mono text-[11px] tracking-wide transition-colors"
          >
            {p}
          </button>
        ))}
      </div>
    </div>
  );
}

function MessageBubble({ message }: { message: ChatMessage }) {
  const isUser = message.role === "user";
  const isStreaming = !!message.streaming;
  const accentBorder = isUser
    ? "border-l-accent-strix"
    : message.error
      ? "border-l-accent-danger"
      : isStreaming
        ? "border-l-accent-photon"
        : "border-l-accent-ok";
  const align = isUser ? "ml-auto" : "mr-auto";
  const roleLabel = isUser ? "USER" : "VLM";

  return (
    <div className={`max-w-[88%] ${align}`}>
      <div className="flex items-baseline gap-2 mb-1">
        <span
          className={`text-[10px] tracking-hud font-mono ${
            isUser
              ? "text-accent-strix"
              : message.error
                ? "text-accent-danger"
                : "text-accent-ok"
          }`}
        >
          {roleLabel}
        </span>
        {message.streaming && (
          <span className="text-[10px] tracking-widest font-mono text-accent-warn animate-pulse-dot">
            ▌ STREAMING
          </span>
        )}
        {message.stats && (
          <span className="text-[10px] tracking-widest font-mono text-accent-photon tnum">
            {(message.stats.tookMs / 1000).toFixed(1)}s
            {message.stats.tokensPerSec > 0 && (
              <>
                {" · "}
                {message.stats.tokensPerSec.toFixed(0)} tok/s
              </>
            )}
          </span>
        )}
      </div>
      <div
        className={`relative border-l-2 ${accentBorder} bg-ink-800/70 border border-ink-700 px-3 py-2`}
      >
        {isStreaming && (
          <div className="absolute left-0 top-0 bottom-0 w-px border-energize text-accent-photon pointer-events-none" />
        )}
        {message.imageDataUrl && (
          <img
            src={message.imageDataUrl}
            alt=""
            className="max-h-40 object-contain border border-ink-700 mb-2"
          />
        )}
        {message.error ? (
          <p className="text-xs font-mono text-accent-danger break-all whitespace-pre-wrap">
            {message.error}
          </p>
        ) : (
          <p className="text-[13px] leading-relaxed text-smoke-100 font-mono whitespace-pre-wrap break-words">
            {message.content || (message.streaming ? "" : "(empty)")}
            {message.streaming && <span className="vlm-blink">▮</span>}
          </p>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Inline styles for the blinking cursor — defining as a one-off keyframe
// keeps the HUD aesthetic without touching tailwind.config.js or index.css.
// ---------------------------------------------------------------------------

function BlinkStyles() {
  return (
    <style>{`
      @keyframes vlm-blink {
        0%, 49% { opacity: 1; }
        50%, 100% { opacity: 0.15; }
      }
      .vlm-blink {
        display: inline-block;
        margin-left: 2px;
        color: #06b6d4;
        animation: vlm-blink 0.85s steps(2, end) infinite;
      }
    `}</style>
  );
}
