import { readFileSync } from "node:fs";
import path from "node:path";
import type { Alert } from "./types.js";

/**
 * Judge — turn anomaly JSON into a Chinese explanation by calling the Ollama
 * HTTP API directly. We bypass `api.runtime.subagent.run` for two reasons:
 *
 *   1. Direct fetch lets us enforce a hard timeout via AbortController; the
 *      subagent runtime streams via events and is awkward to time-bound.
 *   2. We sidestep the operator.write scope dance documented in demo1.
 *
 * The judge-1 workspace markdown (SOUL.md + AGENTS.md) is read at startup and
 * fed as the system prompt — so the persona authored in workspace files is
 * still the source of truth. We just call inference ourselves.
 *
 * Failure modes are all collapsed to `null` from `judge()`. Callers should
 * treat null as "no enrichment available; ship alert v1 as-is". The live UI
 * already rendered v1 by the time we get here, so a null reply is benign.
 */

export type JudgeConfig = {
  ollamaBaseUrl?: string;
  model?: string;
  timeoutMs?: number;
  /** Path that contains SOUL.md + AGENTS.md (judge-1 workspace copy). */
  promptDir?: string;
};

export type JudgeReply = { explanation: string; suggested_action: string };

const DEFAULT_PROMPT = `你是設備警報判讀助理。輸入永遠是一個 JSON 物件,描述一條 sensor 警報,有 rule、severity、trigger 三個欄位。

你**只能**輸出單一 JSON 物件,有且只有兩個 key:
{"explanation": "繁體中文一句 15-30 字", "suggested_action": "繁體中文一句 10-20 字"}

絕對不能加 markdown 圍欄、不能寒暄、不能輸出多個 JSON、不能寫英文(技術單位 °C/cm/lx 例外)。

依 severity 寫 suggested_action:
- critical → 立即類動作(查現場、報警)
- warn → 檢查類動作(檢查設定、通風)
- info → 確認類動作(留意一下)`;

export class Judge {
  private readonly systemPrompt: string;
  private readonly ollamaBaseUrl: string;
  private readonly model: string;
  private readonly timeoutMs: number;

  constructor(cfg: JudgeConfig = {}) {
    this.ollamaBaseUrl = cfg.ollamaBaseUrl ?? "http://127.0.0.1:11434";
    this.model = cfg.model ?? "qwen2:1.5b";
    // 120s default -- large models (35B+) can take 30-60s on cold load;
    // warm calls typically finish in 3-5s.
    this.timeoutMs = cfg.timeoutMs ?? 120000;
    this.systemPrompt = loadSystemPrompt(cfg.promptDir) ?? DEFAULT_PROMPT;
  }

  async judge(alert: Alert, log?: { warn(msg: string): void }): Promise<JudgeReply | null> {
    const userMsg = JSON.stringify({
      rule: alert.rule,
      severity: alert.severity,
      trigger: alert.trigger,
    });
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
          stream: false,
          // Ollama's structured-output mode forces the model's reply to be
          // valid JSON. Combined with the system prompt schema, this nearly
          // eliminates the "model returns markdown bullet list" failure mode.
          format: "json",
          options: { temperature: 0.2, num_predict: 200 },
          keep_alive: "10m",
          // Disable Qwen3 "thinking" mode -- without this the model puts
          // all output in the `thinking` field and returns empty `response`.
          think: false,
        }),
        signal: ctrl.signal,
      });
      if (!res.ok) {
        log?.warn(`judge: ollama HTTP ${res.status}`);
        return null;
      }
      const data = (await res.json()) as { response?: string };
      const reply = (data.response ?? "").trim();
      const parsed = parseJudgeReply(reply);
      if (!parsed) {
        log?.warn(
          `judge: parse failed; raw response (first 200 chars): ${reply.slice(0, 200)}`,
        );
      }
      return parsed;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log?.warn(`judge: fetch failed (${msg})`);
      return null;
    } finally {
      clearTimeout(t);
    }
  }
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

function parseJudgeReply(raw: string): JudgeReply | null {
  let s = raw.trim();
  // Strip ```json fences if the model wrapped despite instructions.
  if (s.startsWith("```")) {
    s = s.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");
  }
  // Pull the outermost {...} block in case the model added trailing chatter.
  const start = s.indexOf("{");
  const end = s.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const parsed = JSON.parse(s.slice(start, end + 1)) as Partial<JudgeReply>;
    if (typeof parsed.explanation === "string" && typeof parsed.suggested_action === "string") {
      return { explanation: parsed.explanation, suggested_action: parsed.suggested_action };
    }
  } catch {
    /* fall through */
  }
  return null;
}
