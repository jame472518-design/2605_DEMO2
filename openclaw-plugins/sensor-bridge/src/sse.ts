import type { IncomingMessage, ServerResponse } from "node:http";

export type SseSink = {
  res: ServerResponse;
  heartbeat: NodeJS.Timeout;
};

/**
 * SSE broadcast channel. Adapted from demo1's telemetry-source SSE registry.
 *
 * Two channels are used in this plugin:
 *   - sensor channel: replayLast=1, so a freshly-loaded dashboard renders
 *     instantly with the most recent frame instead of waiting up to 1s.
 *   - alert channel: replayLast=5, so a dashboard opened after an alert
 *     fired sees recent alerts in JudgePanel.
 *
 * No per-session keying — this is a global broadcast (every subscriber gets
 * every frame). For demo2 the dashboard is the only consumer; per-session
 * routing is unnecessary.
 */
export class SseChannel {
  private readonly subs = new Set<SseSink>();
  private readonly replay: string[] = [];
  private readonly replayLast: number;

  constructor(opts: { replayLast?: number } = {}) {
    this.replayLast = Math.max(0, opts.replayLast ?? 0);
  }

  add(req: IncomingMessage, res: ServerResponse): SseSink {
    res.statusCode = 200;
    res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.write(":connected\n\n");

    for (const frame of this.replay) {
      try {
        res.write(frame);
      } catch {
        /* socket may be gone — close handler evicts */
      }
    }

    const heartbeat = setInterval(() => {
      try {
        res.write(":keepalive\n\n");
      } catch {
        /* socket likely closed */
      }
    }, 15_000);
    if (typeof heartbeat.unref === "function") heartbeat.unref();

    const sink: SseSink = { res, heartbeat };
    this.subs.add(sink);

    const cleanup = () => this.remove(sink);
    req.on("close", cleanup);
    req.on("error", cleanup);
    return sink;
  }

  remove(sink: SseSink): void {
    if (!this.subs.has(sink)) return;
    clearInterval(sink.heartbeat);
    this.subs.delete(sink);
  }

  broadcast(payload: unknown): void {
    const frame = `event: message\ndata: ${JSON.stringify(payload)}\n\n`;
    if (this.replayLast > 0) {
      this.replay.push(frame);
      while (this.replay.length > this.replayLast) this.replay.shift();
    }
    for (const sink of this.subs) {
      try {
        sink.res.write(frame);
      } catch {
        /* drop on write error; close handler evicts */
      }
    }
  }

  closeAll(): void {
    for (const sink of this.subs) {
      clearInterval(sink.heartbeat);
      try {
        sink.res.end();
      } catch {
        /* noop */
      }
    }
    this.subs.clear();
  }

  size(): number {
    return this.subs.size;
  }
}
