import type { IncomingMessage, ServerResponse } from "node:http";
import os from "node:os";
import path from "node:path";
import { URL } from "node:url";
import {
  definePluginEntry,
  type OpenClawPluginApi,
} from "openclaw/plugin-sdk/core";
import { sendActuator } from "./actuator.js";
import { RuleEngine } from "./rules.js";
import { SseChannel } from "./sse.js";
import { servePlaceholder, serveStatic } from "./static.js";
import { isSensorFrame, type ActuatorCommand } from "./types.js";

type SensorBridgeConfig = {
  staticDir?: string;
  bridgeUrl?: string;
};

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
    const cfg = (api.pluginConfig ?? {}) as SensorBridgeConfig;
    const staticDir = cfg.staticDir && cfg.staticDir.length > 0 ? cfg.staticDir : defaultStaticDir();
    const bridgeUrl = cfg.bridgeUrl ?? "http://127.0.0.1:8765";
    const log = api.logger;
    const expectedToken = resolveGatewayToken(api);

    if (!expectedToken) {
      log.warn(
        `[${PLUGIN_ID}] gateway.auth.token not resolvable as plain string — /api/* routes will reject all requests`,
      );
    }

    const sensorSse = new SseChannel({ replayLast: 1 });
    const alertSse = new SseChannel({ replayLast: 5 });
    const engine = new RuleEngine(120);

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
        sensorSse.broadcast(frame);
        const fired = engine.ingest(frame);
        for (const alert of fired) {
          alertSse.broadcast(alert);
          log.info(
            `[${PLUGIN_ID}] alert fired rule=${alert.rule} severity=${alert.severity} actuator=${alert.actuator_fired ?? "-"}`,
          );
          const actuator = engine.getActuator(alert.rule);
          if (actuator) {
            void sendActuator(bridgeUrl, actuator as ActuatorCommand, log);
          }
          // W2: kick off async judge.run() here to enrich alert with explanation
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
        if (!cmd || typeof cmd !== "object" || (cmd.device !== "buzzer" && cmd.device !== "led")) {
          writeJson(res, 400, { ok: false, error: "device must be 'buzzer' or 'led'" });
          return true;
        }
        await sendActuator(bridgeUrl, cmd, log);
        writeJson(res, 200, { ok: true });
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
      `[${PLUGIN_ID}] registered: POST /api/sensor/ingest, GET /api/sensor/stream, GET /api/alert/stream, POST /api/actuator, GET / + /static/* (staticDir=${staticDir}, bridgeUrl=${bridgeUrl})`,
    );
  },
});
