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
import { MockFrameGenerator } from "./mockFrames.js";
import { RuleEngine } from "./rules.js";
import { SseChannel } from "./sse.js";
import { servePlaceholder, serveStatic } from "./static.js";
import { isSensorFrame, type ActuatorCommand, type SensorFrame } from "./types.js";
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
 *   OPENCLAW_DEMO2_VLM_MODEL      — Ollama VLM id for free-form chat (default: qwen2.5vl:3b)
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

// Duplicate of vision.ts's stripDataUriPrefix — small enough that re-exporting
// isn't worth the import churn. Ollama expects raw base64 in messages[i].images;
// canvas.toDataURL() returns "data:image/jpeg;base64,<...>". Strip the prefix.
function stripDataUriPrefix(b64: string): string {
  const trimmed = b64.trim();
  const comma = trimmed.indexOf(",");
  if (trimmed.startsWith("data:") && comma > 0) return trimmed.slice(comma + 1);
  return trimmed;
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
    const vlmChatModel = env.OPENCLAW_DEMO2_VLM_MODEL ?? "qwen2.5vl:3b";
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
    // Base URL of the actuator host (without /cmd path). sendActuator() adds
    // /cmd itself — keep this responsibility in one place to avoid the
    // double-/cmd bug that silently broke servo dispatch until 2026-05-13.
    const getActuatorTarget = (): string => {
      if (isDeviceFresh()) return `http://${lastDevice!.ip}`;
      return bridgeUrl.replace(/\/$/, "");
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

    /**
     * Shared post-ingest pipeline: broadcast on sensorSse, push through rule
     * engine, then for each fired alert: broadcast alert v1, dispatch actuator,
     * async judge enrichment, optional auto-vision capture.
     *
     * Called by both the real /api/sensor/ingest HTTP handler (updateDevice
     * = true, so lastDevice tracks the ESP32) and the synthetic mock tick
     * (updateDevice = false, so mock traffic never refreshes lastDevice and
     * "auto" mode correctly yields the moment real hardware appears).
     *
     * Returns the count of alerts fired so the ingest handler can echo it.
     */
    const processFrame = (
      frame: SensorFrame,
      opts: { updateDevice: boolean },
    ): number => {
      if (opts.updateDevice && frame.device_ip) {
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
        // Async enrichment(s) — each broadcasts a partial alert keyed by id.
        // Dashboard's onAlert merges by id, so the two enrichments below race
        // safely: judge fills explanation/suggested_action, vision fills
        // scene_description. v1 already has the trigger/severity/etc.
        void (async () => {
          const t0 = Date.now();
          const reply = await judge.judge(alert, log);
          const dt = Date.now() - t0;
          if (reply) {
            alertSse.broadcast({
              id: alert.id,
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

        // Optional auto-vision: rules with `auto_vision: true` get a fresh
        // ESP32 /capture snapshot fed to vision-1; the resulting Chinese
        // scene description is patched into the alert. Skipped silently if
        // no ESP32 has been seen recently (DEVICE_TTL_MS expired) — which
        // is the normal case for mock-generated frames.
        if (engine.isAutoVision(alert.rule)) {
          void (async () => {
            if (!isDeviceFresh()) {
              log.warn(
                `[${PLUGIN_ID}] auto-vision: no fresh ESP32 device — skipping for ${alert.rule}`,
              );
              return;
            }
            const ip = lastDevice!.ip;
            const t0 = Date.now();
            try {
              const ctrl = new AbortController();
              const tid = setTimeout(() => ctrl.abort(), 5000);
              const cap = await fetch(`http://${ip}/capture`, { signal: ctrl.signal });
              clearTimeout(tid);
              if (!cap.ok) throw new Error(`/capture HTTP ${cap.status}`);
              const buf = Buffer.from(await cap.arrayBuffer());
              const b64 = buf.toString("base64");
              const reply = await vision.describe(
                b64,
                `${alert.rule} alert capture`,
                log,
              );
              const dt = Date.now() - t0;
              if (reply) {
                alertSse.broadcast({
                  id: alert.id,
                  scene_description: reply.description,
                  scene_took_ms: dt,
                });
                log.info(
                  `[${PLUGIN_ID}] auto-vision ${alert.rule} in ${dt}ms — "${reply.description}"`,
                );
              } else {
                log.warn(
                  `[${PLUGIN_ID}] auto-vision ${alert.rule} returned null after ${dt}ms`,
                );
              }
            } catch (err) {
              const msg = err instanceof Error ? err.message : String(err);
              log.warn(`[${PLUGIN_ID}] auto-vision ${alert.rule} failed: ${msg}`);
            }
          })();
        }
      }
      return fired.length;
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
        const alerts = processFrame(body.value, { updateDevice: true });
        writeJson(res, 200, { ok: true, alerts });
        return true;
      },
    });

    // --- Synthetic mock generator (booth fallback) ------------------------
    // Drives a 1Hz synthetic sensor stream when no real ESP32 is broadcasting,
    // so a dashboard at the booth never shows empty "—" cards. Modes:
    //   "auto"  : emit only when isDeviceFresh() === false (default).
    //   "force" : emit every tick regardless of device state (debug).
    //   "off"   : never emit (clean-room mode).
    // Frames are pushed through the SAME processFrame() pipeline as real
    // ingest, with updateDevice=false so synthetic traffic never masks a real
    // ESP32 reappearing on the LAN.
    type MockMode = "auto" | "force" | "off";
    let mockMode: MockMode = "auto";
    const mockGen = new MockFrameGenerator();
    let lastMockEmitTs = 0;
    const QUIET_GAP_MS = 5_000;

    const mockInterval = setInterval(() => {
      if (mockMode === "off") return;
      if (mockMode === "auto" && isDeviceFresh()) return;
      const now = Date.now();
      if (now - lastMockEmitTs > QUIET_GAP_MS) {
        log.info(`[${PLUGIN_ID}] mock generator active (no fresh ESP32 device)`);
      }
      lastMockEmitTs = now;
      const frame = mockGen.tick(now);
      processFrame(frame, { updateDevice: false });
    }, 1000);

    // GET /api/dev/mock — report current mock mode + whether the generator
    // is actually emitting this instant (matters for "auto" mode where it
    // pauses while a real ESP32 is fresh).
    api.registerHttpRoute({
      path: "/api/dev/mock",
      auth: "plugin",
      match: "exact",
      handler: async (req, res) => {
        if (req.method === "GET") {
          if (!requireToken(req, res)) return true;
          const isEmitting =
            mockMode === "force" || (mockMode === "auto" && !isDeviceFresh());
          writeJson(res, 200, { mode: mockMode, is_emitting: isEmitting });
          return true;
        }
        if (req.method === "POST") {
          if (!requireToken(req, res)) return true;
          const body = await readJsonBody(req);
          if (!body.ok) {
            writeJson(res, 400, { ok: false, error: body.error });
            return true;
          }
          const payload = body.value as { mode?: unknown };
          const requested = payload.mode;
          if (requested !== "auto" && requested !== "force" && requested !== "off") {
            writeJson(res, 400, {
              ok: false,
              error: "mode must be 'auto', 'force', or 'off'",
            });
            return true;
          }
          mockMode = requested;
          log.info(`[${PLUGIN_ID}] mock mode → ${mockMode}`);
          writeJson(res, 200, { ok: true, mode: mockMode });
          return true;
        }
        writeJson(res, 405, { ok: false, error: "method not allowed" });
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

    // GET /api/booth/info — returns the host's non-loopback LAN IPv4(s) so
    // the dashboard can generate a QR code pointing visitors' phones at the
    // dashboard via LAN. Probes :18443 to decide whether the HTTPS reverse
    // proxy is up (mobile Firefox needs HTTPS for getUserMedia on LAN IPs).
    // Token-protected like other /api routes.
    api.registerHttpRoute({
      path: "/api/booth/info",
      auth: "plugin",
      match: "exact",
      handler: async (req, res) => {
        if (req.method !== "GET") {
          writeJson(res, 405, { ok: false, error: "method not allowed" });
          return true;
        }
        if (!requireToken(req, res)) return true;
        const nics = os.networkInterfaces();
        const lanIps: string[] = [];
        for (const list of Object.values(nics)) {
          for (const nic of list ?? []) {
            if (
              nic.family === "IPv4" &&
              !nic.internal &&
              // Restrict to private/link-local ranges so we don't accidentally
              // advertise a public IP if the host happens to be dual-homed.
              /^(10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.|169\.254\.)/.test(nic.address)
            ) {
              lanIps.push(nic.address);
            }
          }
        }
        // HTTPS proxy is optional. Probe with a 250ms TCP connect — if it's
        // up, dashboard uses https://<ip>:18443 in the QR; else falls back
        // to http://<ip>:18790 (and webcam SCAN from phones won't work).
        const httpsPort = 18443;
        const probeHttps = (): Promise<boolean> =>
          new Promise((resolve) => {
            // dynamic import keeps the optional-deps story clean
            void import("node:net").then(({ Socket }) => {
              const s = new Socket();
              const done = (ok: boolean) => {
                s.destroy();
                resolve(ok);
              };
              s.setTimeout(250);
              s.once("connect", () => done(true));
              s.once("timeout", () => done(false));
              s.once("error", () => done(false));
              s.connect(httpsPort, "127.0.0.1");
            });
          });
        const httpsAvailable = await probeHttps();
        writeJson(res, 200, {
          ok: true,
          judge_model: judgeModel,
          vision_model: visionModel,
          vlm_model: vlmChatModel,
          ollama_url: ollamaBaseUrl,
          lan_ips: lanIps,
          port: 18790,
          https_port: httpsAvailable ? httpsPort : null,
        });
        return true;
      },
    });

    // GET /api/esp32/capture — same-origin proxy for the ESP32's single-JPEG
    // /capture endpoint. Phones loading the dashboard over HTTPS can't fetch
    // http://<esp32>/capture directly (mixed-content block); this route
    // serves it through the gateway so it inherits the HTTPS-proxy origin.
    api.registerHttpRoute({
      path: "/api/esp32/capture",
      auth: "plugin",
      match: "exact",
      handler: async (req, res) => {
        if (req.method !== "GET") {
          writeJson(res, 405, { ok: false, error: "method not allowed" });
          return true;
        }
        if (!requireToken(req, res)) return true;
        if (!isDeviceFresh()) {
          writeJson(res, 503, { ok: false, error: "no fresh esp32 device" });
          return true;
        }
        const ip = lastDevice!.ip;
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), 5000);
        try {
          const upstream = await fetch(`http://${ip}/capture`, { signal: ctrl.signal });
          clearTimeout(t);
          if (!upstream.ok) {
            writeJson(res, 502, { ok: false, error: `upstream ${upstream.status}` });
            return true;
          }
          res.statusCode = 200;
          res.setHeader(
            "Content-Type",
            upstream.headers.get("content-type") ?? "image/jpeg",
          );
          res.setHeader("Cache-Control", "no-cache");
          const buf = Buffer.from(await upstream.arrayBuffer());
          res.end(buf);
          return true;
        } catch (err) {
          clearTimeout(t);
          writeJson(res, 502, {
            ok: false,
            error: err instanceof Error ? err.message : String(err),
          });
          return true;
        }
      },
    });

    // GET /api/esp32/stream — MJPEG passthrough proxy. Same mixed-content
    // story as /capture. multipart/x-mixed-replace is a long-running stream;
    // we use raw node:http and pipe so we don't buffer the whole thing.
    api.registerHttpRoute({
      path: "/api/esp32/stream",
      auth: "plugin",
      match: "exact",
      handler: async (req, res) => {
        if (req.method !== "GET") {
          writeJson(res, 405, { ok: false, error: "method not allowed" });
          return true;
        }
        if (!requireToken(req, res)) return true;
        if (!isDeviceFresh()) {
          writeJson(res, 503, { ok: false, error: "no fresh esp32 device" });
          return true;
        }
        const ip = lastDevice!.ip;
        const httpMod = await import("node:http");
        // Aggressive cleanup — ESP32-S3 httpd has ~7 socket slots; each leak
        // strands one until the half-closed timeout (minutes). Listen on
        // both req+res close, and idle-timeout the upstream.
        let cleaned = false;
        const cleanup = () => {
          if (cleaned) return;
          cleaned = true;
          try {
            upReq.destroy();
          } catch {
            /* noop */
          }
        };
        const upReq = httpMod.request(
          { hostname: ip, port: 81, path: "/stream", method: "GET" },
          (upRes) => {
            res.statusCode = upRes.statusCode ?? 502;
            for (const [k, v] of Object.entries(upRes.headers)) {
              if (v !== undefined && k.toLowerCase() !== "connection") {
                res.setHeader(k, v as string | string[]);
              }
            }
            upRes.pipe(res);
            upRes.on("error", () => {
              if (!res.writableEnded) res.end();
              cleanup();
            });
            upRes.on("end", () => {
              if (!res.writableEnded) res.end();
              cleanup();
            });
          },
        );
        upReq.setTimeout(15000, () => cleanup());
        upReq.on("error", (err) => {
          if (!res.headersSent) {
            writeJson(res, 502, { ok: false, error: err.message });
          } else if (!res.writableEnded) {
            res.end();
          }
          cleanup();
        });
        req.on("close", cleanup);
        req.on("aborted", cleanup);
        res.on("close", cleanup);
        res.on("error", cleanup);
        upReq.end();
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

    // POST /api/vlm/chat — free-form streaming multimodal chat. Unlike
    // /api/vision/describe (one-shot, JSON-formatted, blocking) this endpoint
    // passes Ollama's NDJSON token stream through to the client for a
    // typewriter UX. Body:
    //   {
    //     model?: string,                  // overrides OPENCLAW_DEMO2_VLM_MODEL
    //     prompt: string,                  // required, current user turn
    //     image_b64?: string,              // optional, data: URI prefix ok
    //     history?: Array<{ role, content, images? }>,
    //   }
    // No upstream timeout — VLM generation legitimately takes 1-3min on CPU;
    // we rely on client disconnect (req close) to abort. Errors before the
    // stream starts → 502 JSON; errors mid-stream → one final ndjson line
    // {"done":true,"error":"..."} then end.
    api.registerHttpRoute({
      path: "/api/vlm/chat",
      auth: "plugin",
      match: "exact",
      handler: async (req, res) => {
        if (req.method !== "POST") {
          writeJson(res, 405, { ok: false, error: "method not allowed" });
          return true;
        }
        if (!requireToken(req, res)) return true;
        // 6MB cap: tolerates one ~4MB base64 image in the current turn plus
        // a few prior-turn image references (already-stripped raw base64).
        const body = await readJsonBody(req, 6 * 1024 * 1024);
        if (!body.ok) {
          writeJson(res, 400, { ok: false, error: body.error });
          return true;
        }
        const payload = body.value as {
          model?: unknown;
          prompt?: unknown;
          image_b64?: unknown;
          history?: unknown;
        };
        const prompt = typeof payload.prompt === "string" ? payload.prompt : "";
        if (prompt.length === 0) {
          writeJson(res, 400, { ok: false, error: "prompt required" });
          return true;
        }
        const requestedModel =
          typeof payload.model === "string" && payload.model.length > 0
            ? payload.model
            : vlmChatModel;
        const rawImage = typeof payload.image_b64 === "string" ? payload.image_b64 : "";
        const currentImage = rawImage.length > 0 ? stripDataUriPrefix(rawImage) : "";
        // Map prior history. We accept only {role,content,images?} and discard
        // anything else; images here are expected raw base64 (caller already
        // stripped any data: prefix when they originally sent the turn).
        type HistMsg = { role: "user" | "assistant"; content: string; images?: string[] };
        const messages: HistMsg[] = [];
        if (Array.isArray(payload.history)) {
          for (const item of payload.history) {
            if (!item || typeof item !== "object") continue;
            const m = item as { role?: unknown; content?: unknown; images?: unknown };
            if (m.role !== "user" && m.role !== "assistant") continue;
            if (typeof m.content !== "string") continue;
            const out: HistMsg = { role: m.role, content: m.content };
            if (Array.isArray(m.images)) {
              const imgs = m.images.filter(
                (s): s is string => typeof s === "string" && s.length > 0,
              );
              if (imgs.length > 0) out.images = imgs;
            }
            messages.push(out);
          }
        }
        const currentTurn: HistMsg = { role: "user", content: prompt };
        if (currentImage.length > 0) currentTurn.images = [currentImage];
        messages.push(currentTurn);

        // Upstream call. AbortController is wired to req close so a client
        // disconnect tears down the Ollama stream instead of letting it run
        // to completion against a dead socket.
        const ctrl = new AbortController();
        let cleaned = false;
        const cleanup = () => {
          if (cleaned) return;
          cleaned = true;
          try {
            ctrl.abort();
          } catch {
            /* noop */
          }
        };
        req.on("close", cleanup);
        req.on("aborted", cleanup);
        res.on("close", cleanup);
        res.on("error", cleanup);

        let upstream: Response;
        try {
          upstream = await fetch(`${ollamaBaseUrl}/api/chat`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              model: requestedModel,
              messages,
              stream: true,
              // Match vision.ts — prevents Ollama from evicting the 10GB VLM
              // between dashboard interactions during a booth session.
              keep_alive: "10m",
            }),
            signal: ctrl.signal,
          });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          log.warn(`[${PLUGIN_ID}] vlm chat: upstream fetch failed (${msg})`);
          if (!res.headersSent) {
            writeJson(res, 502, { ok: false, error: msg });
          } else if (!res.writableEnded) {
            res.end();
          }
          return true;
        }
        if (!upstream.ok || !upstream.body) {
          const status = upstream.status;
          log.warn(`[${PLUGIN_ID}] vlm chat: ollama HTTP ${status}`);
          writeJson(res, 502, { ok: false, error: `ollama HTTP ${status}` });
          return true;
        }

        res.statusCode = 200;
        res.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
        res.setHeader("Cache-Control", "no-cache");
        res.setHeader("Connection", "keep-alive");

        const t0 = Date.now();
        const reader = upstream.body.getReader();
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            if (!value || value.length === 0) continue;
            if (res.writableEnded) break;
            // value is a Uint8Array — Ollama already frames responses as
            // newline-delimited JSON, so passthrough is sufficient.
            const ok = res.write(Buffer.from(value));
            if (!ok) {
              await new Promise<void>((resolve) => res.once("drain", () => resolve()));
            }
          }
          if (!res.writableEnded) res.end();
          log.info(
            `[${PLUGIN_ID}] vlm chat ${requestedModel} streamed ${Date.now() - t0}ms ` +
              `(history=${messages.length - 1}, image=${currentImage.length > 0 ? "yes" : "no"})`,
          );
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          log.warn(`[${PLUGIN_ID}] vlm chat: stream error (${msg})`);
          if (!res.writableEnded) {
            try {
              res.write(`${JSON.stringify({ done: true, error: msg })}\n`);
            } catch {
              /* noop */
            }
            try {
              res.end();
            } catch {
              /* noop */
            }
          }
        } finally {
          try {
            reader.releaseLock();
          } catch {
            /* noop */
          }
          cleanup();
        }
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

    api.registerRuntimeLifecycle({
      id: `${PLUGIN_ID}.mock-cleanup`,
      description: "Stop synthetic mock frame generator on plugin shutdown.",
      cleanup: () => {
        clearInterval(mockInterval);
      },
    });

    log.info(
      `[${PLUGIN_ID}] registered: POST /api/sensor/ingest, GET /api/sensor/stream, GET /api/alert/stream, POST /api/actuator, POST /api/vision/describe, POST /api/vlm/chat, GET /api/device-info, GET /api/booth/info, GET+POST /api/dev/mock, GET / + /static/* (staticDir=${staticDir}, bridgeUrl=${bridgeUrl})`,
    );
  },
});
