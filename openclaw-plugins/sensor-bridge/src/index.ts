import type { IncomingMessage, ServerResponse } from "node:http";
import os from "node:os";
import path from "node:path";
import { URL } from "node:url";
import {
  definePluginEntry,
  type OpenClawPluginApi,
} from "openclaw/plugin-sdk/core";
import { sendActuator } from "./actuator.js";
import { Judge } from "./judge.js";
import { RuleEngine } from "./rules.js";
import { SseChannel } from "./sse.js";
import { servePlaceholder, serveStatic } from "./static.js";
import { isSensorFrame, type ActuatorCommand } from "./types.js";
import { Vision } from "./vision.js";

/**
 * Plugin runtime knobs are read from process.env, NOT from plugins.entries.<id>.*
 * in openclaw.json. The core gateway config validator rejects unknown keys at
 * plugins.entries.<id>.* before the plugin manifest is loaded, so anything
 * besides `enabled` is unsafe to put there. Env vars sidestep that.
 *
 *   OPENCLAW_DEMO2_STATIC_DIR     — override SPA path (default: <plugin>/static)
 *   OPENCLAW_DEMO2_BRIDGE_URL     — Python bridge base URL (default: http://127.0.0.1:8765)
 *   OPENCLAW_DEMO2_OLLAMA_URL     — Ollama HTTP API URL (default: http://127.0.0.1:11434)
 *   OPENCLAW_DEMO2_JUDGE_MODEL    — Ollama model id for judge-1 (default: qwen2:1.5b)
 *   OPENCLAW_DEMO2_VISION_MODEL   — Ollama VLM id for vision-1 (default: qwen2.5vl:3b)
 */

const PLUGIN_ID = "sensor-bridge";
const PROFILE = "strixdemo2";

function defaultStaticDir(): string {
  return path.join(
    os.homedir(),
    `.openclaw-${PROFILE}`,
    "extensions",
    PLUGIN_ID,
    "static",
  );
}

function readJsonBody(
  req: IncomingMessage,
  maxBytes = 64 * 1024,
): Promise<{ ok: true; value: unknown } | { ok: false; error: string }> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;
    const finish = (r: { ok: true; value: unknown } | { ok: false; error: string }) => {
      if (settled) return;
      settled = true;
      resolve(r);
    };
    req.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > maxBytes) {
        finish({ ok: false, error: "payload too large" });
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      try {
        const raw = Buffer.concat(chunks).toString("utf8");
        finish({ ok: true, value: raw.length > 0 ? JSON.parse(raw) : {} });
      } catch {
        finish({ ok: false, error: "invalid JSON body" });
      }
    });
    req.on("error", () => finish({ ok: false, error: "request error" }));
  });
}

function writeJson(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(body));
}

function extractToken(req: IncomingMessage): string {
  const auth = req.headers.authorization;
  const headerVal = Array.isArray(auth) ? auth[0] ?? "" : auth ?? "";
  if (headerVal.toLowerCase().startsWith("bearer ")) {
    return headerVal.slice(7).trim();
  }
  try {
    const url = new URL(req.url ?? "/", "http://localhost");
    return url.searchParams.get("token")?.trim() ?? "";
  } catch {
    return "";
  }
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function resolveGatewayToken(api: OpenClawPluginApi): string | null {
  const tokenRaw = (api.config as { gateway?: { auth?: { token?: unknown } } })
    .gateway?.auth?.token;
  return typeof tokenRaw === "string" && tokenRaw.length > 0 ? tokenRaw : null;
}

export default definePluginEntry({
  id: PLUGIN_ID,
  name: "Sensor Bridge",
  description:
    "Ingest sensor frames, broadcast SSE, run rule engine, dispatch judge agent + actuator commands, serve dashboard SPA.",
  register(api: OpenClawPluginApi) {
    const env = process.env;
    const staticDir = env.OPENCLAW_DEMO2_STATIC_DIR && env.OPENCLAW_DEMO2_STATIC_DIR.length > 0
      ? env.OPENCLAW_DEMO2_STATIC_DIR
      : defaultStaticDir();
    const bridgeUrl = env.OPENCLAW_DEMO2_BRIDGE_URL ?? "http://127.0.0.1:8765";
    const ollamaBaseUrl = env.OPENCLAW_DEMO2_OLLAMA_URL ?? "http://127.0.0.1:11434";
    const judgeModel = env.OPENCLAW_DEMO2_JUDGE_MODEL ?? "qwen2:1.5b";
    const visionModel = env.OPENCLAW_DEMO2_VISION_MODEL ?? "qwen2.5vl:3b";
    const log = api.logger;
    const expectedToken = resolveGatewayToken(api);

    if (!expectedToken) {
      log.warn(
        `[${PLUGIN_ID}] gateway.auth.token not resolvable as plain string — /api/* routes will reject all requests`,
      );
    }

    const sensorSse = new SseChannel({ replayLast: 1 });
    const alertSse = new SseChannel({ replayLast: 5 });

    // Last-seen device cache. ESP32 firmware sets device_ip in every frame so
    // the plugin can POST actuator commands back to it (port 80) and the
    // dashboard can <img> the camera stream (port 81). TTL = 60s; after that
    // we fall back to the legacy bridgeUrl env (Python USB-bridge dev mode).
    const DEVICE_TTL_MS = 60_000;
    let lastDevice: { ip: string; id: string | null; ts: number } | null = null;
    const isDeviceFresh = () =>
      lastDevice !== null && Date.now() - lastDevice.ts < DEVICE_TTL_MS;
    const getActuatorTarget = (): string => {
      if (isDeviceFresh()) return `http://${lastDevice!.ip}/cmd`;
      return `${bridgeUrl.replace(/\/$/, "")}/cmd`;
    };
    // Try rules.yaml shipped alongside the plugin; fall back to built-in
    // defaults if the file is missing (still safe — defaults match yaml).
    const pluginRoot = path.dirname(staticDir);
    const rulesPath = path.join(pluginRoot, "rules.yaml");
    let engine: RuleEngine;
    try {
      engine = new RuleEngine(rulesPath, 120);
      log.info(`[${PLUGIN_ID}] loaded rules from ${rulesPath}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn(`[${PLUGIN_ID}] rules.yaml load failed (${msg}) — using built-in defaults`);
      engine = new RuleEngine();
    }

    // Judge: optional anomaly enrichment via Ollama. The judge-1 workspace
    // markdown is copied into <pluginRoot>/judge-prompt/ by the installer;
    // if missing (e.g. dev iteration), Judge falls back to its built-in
    // default prompt.
    const judge = new Judge({
      ollamaBaseUrl,
      model: judgeModel,
      promptDir: path.join(pluginRoot, "judge-prompt"),
    });
    log.info(`[${PLUGIN_ID}] judge: ollama=${ollamaBaseUrl} model=${judgeModel}`);

    // Vision: per-click webcam frame describer. Bound to the dashboard's
    // "describe scene" button via POST /api/vision/describe. Same direct-
    // Ollama strategy as Judge.
    const vision = new Vision({
      ollamaBaseUrl,
      model: visionModel,
      promptDir: path.join(pluginRoot, "vision-prompt"),
    });
    log.info(`[${PLUGIN_ID}] vision: ollama=${ollamaBaseUrl} model=${visionModel}`);

    const requireToken = (req: IncomingMessage, res: ServerResponse): boolean => {
      if (!expectedToken) {
        writeJson(res, 503, { ok: false, error: "gateway token unavailable" });
        return false;
      }
      const presented = extractToken(req);
      if (!presented || !timingSafeEqual(presented, expectedToken)) {
        writeJson(res, 401, { ok: false, error: "unauthorized" });
        return false;
      }
      return true;
    };

    // POST /api/sensor/ingest — Python bridge pushes a sensor frame.
    api.registerHttpRoute({
      path: "/api/sensor/ingest",
      auth: "plugin",
      match: "exact",
      handler: async (req, res) => {
        if (req.method !== "POST") {
          writeJson(res, 405, { ok: false, error: "method not allowed" });
          return true;
        }
        if (!requireToken(req, res)) return true;
        const body = await readJsonBody(req);
        if (!body.ok) {
          writeJson(res, 400, { ok: false, error: body.error });
          return true;
        }
        if (!isSensorFrame(body.value)) {
          writeJson(res, 400, { ok: false, error: "invalid sensor frame shape" });
          return true;
        }
        const frame = body.value;
        if (frame.device_ip) {
          lastDevice = {
            ip: frame.device_ip,
            id: frame.device_id ?? null,
            ts: Date.now(),
          };
        }
        sensorSse.broadcast(frame);
        const fired = engine.ingest(frame);
        for (const alert of fired) {
          alertSse.broadcast(alert);
          log.info(
            `[${PLUGIN_ID}] alert fired rule=${alert.rule} severity=${alert.severity} actuator=${alert.actuator_fired ?? "-"}`,
          );
          const actuator = engine.getActuator(alert.rule);
          if (actuator) {
            void sendActuator(getActuatorTarget(), actuator as ActuatorCommand, log);
          }
          // Async enrichment: same alert id re-broadcast with explanation
          // populated. UI dedups by id and replaces the stale v1.
          void (async () => {
            const t0 = Date.now();
            const reply = await judge.judge(alert, log);
            const dt = Date.now() - t0;
            if (reply) {
              alertSse.broadcast({
                ...alert,
                explanation: reply.explanation,
                suggested_action: reply.suggested_action,
              });
              log.info(
                `[${PLUGIN_ID}] judge enriched ${alert.rule} in ${dt}ms — ` +
                  `explanation="${reply.explanation}" action="${reply.suggested_action}"`,
              );
            } else {
              log.warn(`[${PLUGIN_ID}] judge returned null for ${alert.rule} after ${dt}ms`);
            }
          })();
        }
        writeJson(res, 200, { ok: true, alerts: fired.length });
        return true;
      },
    });

    // GET /api/sensor/stream — SSE of every ingested frame.
    api.registerHttpRoute({
      path: "/api/sensor/stream",
      auth: "plugin",
      match: "exact",
      handler: async (req, res) => {
        if (req.method !== "GET") {
          writeJson(res, 405, { ok: false, error: "method not allowed" });
          return true;
        }
        if (!requireToken(req, res)) return true;
        sensorSse.add(req, res);
        log.info(`[${PLUGIN_ID}] sensor SSE subscribed (count=${sensorSse.size()})`);
        return true;
      },
    });

    // GET /api/alert/stream — SSE of rule-engine alerts (with last 5 replay).
    api.registerHttpRoute({
      path: "/api/alert/stream",
      auth: "plugin",
      match: "exact",
      handler: async (req, res) => {
        if (req.method !== "GET") {
          writeJson(res, 405, { ok: false, error: "method not allowed" });
          return true;
        }
        if (!requireToken(req, res)) return true;
        alertSse.add(req, res);
        log.info(`[${PLUGIN_ID}] alert SSE subscribed (count=${alertSse.size()})`);
        return true;
      },
    });

    // POST /api/actuator — dashboard manual override (forwards to bridge /cmd).
    api.registerHttpRoute({
      path: "/api/actuator",
      auth: "gateway",
      match: "exact",
      handler: async (req, res) => {
        if (req.method !== "POST") {
          writeJson(res, 405, { ok: false, error: "method not allowed" });
          return true;
        }
        if (!requireToken(req, res)) return true;
        const body = await readJsonBody(req);
        if (!body.ok) {
          writeJson(res, 400, { ok: false, error: body.error });
          return true;
        }
        const cmd = body.value as ActuatorCommand;
        const validDevice =
          cmd && typeof cmd === "object" &&
          (cmd.device === "buzzer" || cmd.device === "led" || cmd.device === "servo");
        if (!validDevice) {
          writeJson(res, 400, {
            ok: false,
            error: "device must be 'buzzer', 'led', or 'servo'",
          });
          return true;
        }
        if (cmd.device === "servo") {
          const angle = (cmd as { angle?: unknown }).angle;
          if (
            (cmd.state !== "pan" && cmd.state !== "tilt") ||
            typeof angle !== "number" ||
            !Number.isFinite(angle) ||
            angle < 0 ||
            angle > 180
          ) {
            writeJson(res, 400, {
              ok: false,
              error: "servo requires state='pan'|'tilt' and angle:number 0..180",
            });
            return true;
          }
        }
        await sendActuator(getActuatorTarget(), cmd, log);
        writeJson(res, 200, { ok: true });
        return true;
      },
    });

    // POST /api/vision/describe — dashboard "describe scene" button. Body:
    //   { image_b64: string, source_label?: string }
    // Returns { description, took_ms } on success, 503 on agent failure.
    api.registerHttpRoute({
      path: "/api/vision/describe",
      auth: "plugin",
      match: "exact",
      handler: async (req, res) => {
        if (req.method !== "POST") {
          writeJson(res, 405, { ok: false, error: "method not allowed" });
          return true;
        }
        if (!requireToken(req, res)) return true;
        // Allow up to 2MB body (base64 of ~1.5MB image). UI downscales to
        // 640x480 q70 which is typically <60KB b64, so this is a wide cap.
        const body = await readJsonBody(req, 2 * 1024 * 1024);
        if (!body.ok) {
          writeJson(res, 400, { ok: false, error: body.error });
          return true;
        }
        const payload = body.value as { image_b64?: unknown; source_label?: unknown };
        const img = typeof payload.image_b64 === "string" ? payload.image_b64 : "";
        if (img.length === 0) {
          writeJson(res, 400, { ok: false, error: "image_b64 required" });
          return true;
        }
        const label = typeof payload.source_label === "string" ? payload.source_label : undefined;
        const t0 = Date.now();
        const reply = await vision.describe(img, label, log);
        const dt = Date.now() - t0;
        if (!reply) {
          log.warn(`[${PLUGIN_ID}] vision describe failed after ${dt}ms (label=${label ?? "-"})`);
          writeJson(res, 503, { ok: false, error: "vision agent unavailable", took_ms: dt });
          return true;
        }
        log.info(
          `[${PLUGIN_ID}] vision described ${label ?? "webcam"} in ${dt}ms — "${reply.description}"`,
        );
        writeJson(res, 200, { ok: true, description: reply.description, took_ms: dt });
        return true;
      },
    });

    // GET /api/device-info — dashboard polls this to learn the ESP32's IP so
    // it can build the camera <img src=http://<ip>:81/stream> URL. Returns
    // null fields when no recent device frame has arrived (mock dev mode).
    api.registerHttpRoute({
      path: "/api/device-info",
      auth: "plugin",
      match: "exact",
      handler: async (req, res) => {
        if (req.method !== "GET") {
          writeJson(res, 405, { ok: false, error: "method not allowed" });
          return true;
        }
        if (!requireToken(req, res)) return true;
        const fresh = isDeviceFresh();
        const dev = fresh ? lastDevice : null;
        writeJson(res, 200, {
          device_ip: dev?.ip ?? null,
          device_id: dev?.id ?? null,
          last_seen: dev ? new Date(dev.ts).toISOString() : null,
          camera_stream_url: dev ? `http://${dev.ip}:81/stream` : null,
          ttl_ms: DEVICE_TTL_MS,
        });
        return true;
      },
    });

    // GET / and /static/* — serve the SPA bundle.
    const staticHandler = async (req: IncomingMessage, res: ServerResponse): Promise<boolean> => {
      if (req.method !== "GET" && req.method !== "HEAD") {
        writeJson(res, 405, { ok: false, error: "method not allowed" });
        return true;
      }
      const url = new URL(req.url ?? "/", "http://localhost");
      const sub =
        url.pathname === "/" || url.pathname === ""
          ? "/"
          : url.pathname.startsWith("/static/")
            ? url.pathname.slice("/static".length) || "/"
            : url.pathname;
      const handled = await serveStatic({ baseDir: staticDir, urlPath: sub, res }).catch(() => false);
      if (handled) return true;
      if (sub === "/" || sub === "/index.html") return servePlaceholder(res);
      if (!res.headersSent) {
        res.statusCode = 404;
        res.end("Not Found");
      }
      return true;
    };
    api.registerHttpRoute({ path: "/", auth: "plugin", match: "exact", handler: staticHandler });
    api.registerHttpRoute({
      path: "/static/",
      auth: "plugin",
      match: "prefix",
      handler: staticHandler,
    });

    api.registerRuntimeLifecycle({
      id: `${PLUGIN_ID}.sse-cleanup`,
      description: "Close SSE channels on plugin shutdown.",
      cleanup: () => {
        sensorSse.closeAll();
        alertSse.closeAll();
      },
    });

    log.info(
      `[${PLUGIN_ID}] registered: POST /api/sensor/ingest, GET /api/sensor/stream, GET /api/alert/stream, POST /api/actuator, POST /api/vision/describe, GET /api/device-info, GET / + /static/* (staticDir=${staticDir}, bridgeUrl=${bridgeUrl})`,
    );
  },
});
