import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * Vision — turn a single webcam frame into a one-sentence Chinese scene
 * description by calling the Ollama HTTP API directly with a vision-capable
 * model (default qwen2.5vl:3b). Same direct-fetch reasoning as Judge: hard
 * timeout via AbortController, no operator.write dance.
 *
 * The vision-1 workspace markdown (SOUL.md + AGENTS.md) is read at startup
 * and fed as system prompt. The image arrives as raw base64 (no data: URI
 * prefix); callers may pass either — the strip step handles both.
 *
 * Failure modes all collapse to `null` from `describe()`. Callers should
 * surface "agent unavailable" to the UI rather than retrying.
 */

export type VisionConfig = {
  ollamaBaseUrl?: string;
  model?: string;
  timeoutMs?: number;
  /** Path that contains SOUL.md + AGENTS.md (vision-1 workspace copy). */
  promptDir?: string;
};

export type VisionReply = { description: string };

/**
 * IMPORTANT — empirically qwen2.5vl:3b ignores Chinese instructions in its
 * system prompt and either replies in English or fails to attend to the image.
 * Hence: persona/style is described in English; output language constraint is
 * stated bilingually with explicit Trad/Simplified character examples.
 *
 * The character-set examples in EXEC_RULES below were measured: without them
 * the model emits Simplified Chinese (蓝色) despite the "Traditional Chinese"
 * label; with them it emits Traditional (藍色).
 */
const DEFAULT_PROMPT = `You are the scene describer at the Strix Halo AI edge-computing demo booth. The image is from a live camera at that booth - visitors are walking by, watching demos, gesturing at displays. Describe what you see, with a tone that lets the visitor feel "the AI is really watching".

Output rules:
- Output ONLY a single JSON object: {"description": "..."}
- The description MUST be in Traditional Chinese (繁體中文, zh-TW). NEVER Simplified Chinese.
  Correct examples: 顯 號 個 體 樣 經 機 學 藍 圖 觀 眾 場
  Forbidden Simplified: 显 号 个 体 样 经 机 学 蓝 图 观 众 场
- 60-100 Chinese characters total. One or two sentences. First sentence: scene + people. Optional second sentence: highlight, motion, or notable detail.
- Describe what is visually present: people count and posture, demo station / display / device on table, exhibition fixtures, lighting. If at a booth context is visible (visitors gesturing at a display, looking at a demo, etc.), say so naturally.
- Stay factual - no guesses about visitor identity, mood, intent, or brand allegiance.
- End every sentence with 。 (full-width period).
- No "The image shows..." prefix, no markdown fences, no English in the description value.`;

/**
 * Always-appended LLM execution rules. Kept in English even when SOUL.md /
 * AGENTS.md (the human-authored persona docs) are loaded — those docs target
 * humans reading the workspace, this block targets the VLM's instruction
 * follower. Without this addendum the model regresses to either English
 * output or Simplified Chinese depending on input phrasing.
 */
const EXEC_RULES = `

---

# LLM EXECUTION RULES (read these last, obey strictly)

You are now serving a single image-to-description request. The image is from a live camera at the **Strix Halo AI edge-computing demo booth**. Visitors are walking by, watching demos, sometimes gesturing at displays.

Output ONLY a single JSON object with one key:
  {"description": "..."}

The "description" value MUST be:
- Traditional Chinese (繁體中文, zh-TW). NEVER Simplified Chinese.
  Correct chars: 顯 號 個 體 樣 經 機 學 藍 圖 觀 眾 場 邊
  FORBIDDEN chars (Simplified): 显 号 个 体 样 经 机 学 蓝 图 观 众 场 边
- **60-100 Chinese characters total.** Aim for ~80. Shorter = boring at booth. Longer = breaks demo rhythm.
- One or two sentences. First sentence: scene + people (positions, posture, count). Optional second sentence: highlight, motion, notable object, or lighting state. End every sentence with 。
- If demo / booth / visitor context is visible (a display, a station, people gesturing at a screen, observing), **name it naturally** - "展示區", "示範台", "螢幕前", "訪客".
- Describe only what is visually present. If there is no person say so. If lighting is dim say so. If unclear say "畫面過暗" or "畫面模糊".
- Stay factual. **No guesses** about visitor identity, mood, intent, age, gender, or brand allegiance.
- No "The image shows" prefix, no markdown fences, no English words inside the description.`;

export class Vision {
  private readonly systemPrompt: string;
  private readonly ollamaBaseUrl: string;
  private readonly model: string;
  private readonly timeoutMs: number;

  constructor(cfg: VisionConfig = {}) {
    this.ollamaBaseUrl = cfg.ollamaBaseUrl ?? "http://127.0.0.1:11434";
    this.model = cfg.model ?? "qwen2.5vl:3b";
    // Vision inference is markedly slower than text. 300s default tolerates
    // first-call cold model loads on CPU-only Snapdragon X (worst case seen:
    // ~190s on 7B; 3B warmed-up is ~20s). Jetson Orin much faster.
    this.timeoutMs = cfg.timeoutMs ?? 300000;
    // SOUL.md+AGENTS.md is human-authored Chinese persona doc; we append the
    // English EXEC_RULES so the VLM actually follows the schema/language
    // constraint. DEFAULT_PROMPT (fallback) is already English so no append.
    const loaded = loadSystemPrompt(cfg.promptDir);
    this.systemPrompt = loaded ? `${loaded}${EXEC_RULES}` : DEFAULT_PROMPT;
  }

  async describe(
    imageB64: string,
    sourceLabel: string | undefined,
    log?: { warn(msg: string): void },
  ): Promise<VisionReply | null> {
    const cleaned = stripDataUriPrefix(imageB64);
    if (!cleaned) {
      log?.warn("vision: empty image payload");
      return null;
    }
    // English user msg: Chinese here also degrades the model's image attention
    // on qwen2.5vl:3b. Source label is appended only as inert context.
    const userMsg = sourceLabel
      ? `Source: ${sourceLabel}. Describe this image.`
      : "Describe this image.";
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), this.timeoutMs);
    try {
      const res = await fetch(`${this.ollamaBaseUrl}/api/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: this.model,
          system: this.systemPrompt,
          prompt: userMsg,
          images: [cleaned],
          stream: false,
          format: "json",
          // temperature 0.35 (was 0.2): allow some variety between consecutive
          // SCANs at the booth without losing factuality.
          // num_predict 280 (was 120): 100 Trad-Chinese chars ~ 180-200 tokens,
          // plus JSON wrapper + safety margin.
          options: { temperature: 0.35, num_predict: 280 },
          // Keep the VLM resident — booth visitors hit SCAN unpredictably and
          // the 30-60s cold reload of qwen2.5vl:3b (10GB working set) is a
          // demo-killer. "10m" means Ollama won't evict for 10 minutes after
          // the most recent call.
          keep_alive: "10m",
          // Disable Qwen3 "thinking" mode -- without this the model puts
          // all output in the `thinking` field and returns empty `response`.
          think: false,
        }),
        signal: ctrl.signal,
      });
      if (!res.ok) {
        log?.warn(`vision: ollama HTTP ${res.status}`);
        return null;
      }
      const data = (await res.json()) as { response?: string };
      const reply = (data.response ?? "").trim();
      const parsed = parseVisionReply(reply);
      if (!parsed) {
        log?.warn(
          `vision: parse failed; raw response (first 200 chars): ${reply.slice(0, 200)}`,
        );
      }
      return parsed;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log?.warn(`vision: fetch failed (${msg})`);
      return null;
    } finally {
      clearTimeout(t);
    }
  }
}

function stripDataUriPrefix(b64: string): string {
  // Browsers' canvas.toDataURL() returns "data:image/jpeg;base64,<...>". Ollama
  // expects raw base64 in the images[] array.
  const trimmed = b64.trim();
  const comma = trimmed.indexOf(",");
  if (trimmed.startsWith("data:") && comma > 0) return trimmed.slice(comma + 1);
  return trimmed;
}

function loadSystemPrompt(dir: string | undefined): string | null {
  if (!dir) return null;
  try {
    const soul = readFileSync(path.join(dir, "SOUL.md"), "utf-8");
    const agents = readFileSync(path.join(dir, "AGENTS.md"), "utf-8");
    return `${soul}\n\n---\n\n${agents}`;
  } catch {
    return null;
  }
}

function parseVisionReply(raw: string): VisionReply | null {
  let s = raw.trim();
  if (s.startsWith("```")) {
    s = s.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");
  }
  const start = s.indexOf("{");
  const end = s.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const parsed = JSON.parse(s.slice(start, end + 1)) as Partial<VisionReply>;
    if (typeof parsed.description === "string" && parsed.description.length > 0) {
      return { description: parsed.description };
    }
  } catch {
    /* fall through */
  }
  return null;
}
