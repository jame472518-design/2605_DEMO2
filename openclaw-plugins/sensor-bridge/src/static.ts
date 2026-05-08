import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import type { ServerResponse } from "node:http";
import path from "node:path";

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".map": "application/json; charset=utf-8",
};

const PLACEHOLDER_HTML = `<!doctype html>
<html lang="zh-Hant"><head><meta charset="utf-8"><title>demo2 Sensor Station — bundle missing</title>
<style>body{font:14px system-ui;margin:2rem;color:#222;background:#fafafa}code{background:#eee;padding:.1em .35em;border-radius:3px}</style>
</head><body>
<h1>Dashboard SPA bundle not yet installed</h1>
<p>The sensor-bridge plugin is running, but no SPA bundle was found at the configured <code>staticDir</code>.</p>
<p>Build the dashboard (<code>cd dashboard; pnpm run build</code>) then re-run <code>scripts\\install-plugins.ps1</code>.</p>
</body></html>`;

export async function serveStatic(params: {
  baseDir: string;
  urlPath: string;
  res: ServerResponse;
}): Promise<boolean> {
  const { baseDir, urlPath, res } = params;
  const cleanPath = urlPath.split("?")[0]?.split("#")[0] ?? "/";
  let decoded: string;
  try {
    decoded = decodeURIComponent(cleanPath);
  } catch {
    res.statusCode = 400;
    res.end("Bad Request");
    return true;
  }
  const requested = decoded === "/" || decoded === "" ? "/index.html" : decoded;
  const absolute = path.resolve(baseDir, "." + requested);
  const baseResolved = path.resolve(baseDir);
  if (!absolute.startsWith(baseResolved + path.sep) && absolute !== baseResolved) {
    res.statusCode = 403;
    res.end("Forbidden");
    return true;
  }

  try {
    const info = await stat(absolute);
    if (!info.isFile()) {
      const indexPath = path.join(absolute, "index.html");
      const indexInfo = await stat(indexPath).catch(() => null);
      if (!indexInfo?.isFile()) {
        res.statusCode = 404;
        res.end("Not Found");
        return true;
      }
      return streamFile(indexPath, res);
    }
    return streamFile(absolute, res);
  } catch {
    res.statusCode = 404;
    res.end("Not Found");
    return true;
  }
}

async function streamFile(absolute: string, res: ServerResponse): Promise<boolean> {
  const ext = path.extname(absolute).toLowerCase();
  res.statusCode = 200;
  res.setHeader("Content-Type", MIME[ext] ?? "application/octet-stream");
  res.setHeader("Cache-Control", "no-cache");
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(absolute);
    stream.on("error", reject);
    stream.on("end", () => resolve());
    stream.pipe(res);
  });
  return true;
}

export function servePlaceholder(res: ServerResponse): boolean {
  res.statusCode = 200;
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache");
  res.end(PLACEHOLDER_HTML);
  return true;
}
