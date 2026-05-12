/**
 * demo2 — HTTPS reverse proxy for the OpenClaw gateway.
 *
 * Why: mobile Firefox treats `http://10.x.x.x:N` as an insecure context and
 * refuses `getUserMedia`, so a phone scanning the booth QR can't activate
 * its own camera (front/rear chips fail with "insecure context"). Surface
 * itself uses http://127.0.0.1:18790 which IS a secure context (localhost
 * exception), so the gateway can stay HTTP — this proxy adds an HTTPS
 * surface ONLY for LAN clients.
 *
 * What it does:
 *   - Generates (once) a self-signed cert covering 127.0.0.1 + every
 *     detected private-network LAN IPv4. Caches in .cert/.
 *   - Listens HTTPS on DEMO2_HTTPS_PORT (default 18443).
 *   - Transparent proxy → http://127.0.0.1:18790.
 *   - SSE-safe: pipes streams directly, no buffering.
 *
 * Visitors get a cert warning the first time (booth operator says "tap
 * advanced → continue"). The cert is regenerated whenever .cert/ is
 * cleared (e.g. LAN IP changes between venues — delete .cert/ to refresh).
 *
 * ESP32 keeps using HTTP :18790 directly; it doesn't go through this proxy
 * (the firmware lacks a TLS truststore for a self-signed cert).
 */

import https from "node:https";
import http from "node:http";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { networkInterfaces } from "node:os";
import selfsigned from "selfsigned";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CERT_DIR = join(__dirname, ".cert");
const CERT_FILE = join(CERT_DIR, "cert.pem");
const KEY_FILE = join(CERT_DIR, "key.pem");

const HTTPS_PORT = parseInt(process.env.DEMO2_HTTPS_PORT ?? "18443", 10);
const UPSTREAM = process.env.DEMO2_UPSTREAM ?? "http://127.0.0.1:18790";

function detectLanIps() {
  const out = [];
  for (const list of Object.values(networkInterfaces())) {
    for (const nic of list ?? []) {
      if (
        nic.family === "IPv4" &&
        !nic.internal &&
        /^(10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.|169\.254\.)/.test(nic.address)
      ) {
        out.push(nic.address);
      }
    }
  }
  return out;
}

function ensureCert() {
  if (existsSync(CERT_FILE) && existsSync(KEY_FILE)) {
    return {
      cert: readFileSync(CERT_FILE, "utf8"),
      key: readFileSync(KEY_FILE, "utf8"),
      reused: true,
    };
  }
  mkdirSync(CERT_DIR, { recursive: true });
  const ips = detectLanIps();
  const altNames = [
    { type: 2, value: "localhost" },
    { type: 7, ip: "127.0.0.1" },
    ...ips.map((ip) => ({ type: 7, ip })),
  ];
  const pems = selfsigned.generate(
    [{ name: "commonName", value: "demo2-booth" }],
    {
      days: 365,
      keySize: 2048,
      algorithm: "sha256",
      extensions: [
        { name: "basicConstraints", cA: false },
        { name: "subjectAltName", altNames },
      ],
    },
  );
  writeFileSync(CERT_FILE, pems.cert);
  writeFileSync(KEY_FILE, pems.private);
  return { cert: pems.cert, key: pems.private, reused: false };
}

const { cert, key, reused } = ensureCert();
const upstream = new URL(UPSTREAM);

const server = https.createServer({ cert, key }, (req, res) => {
  const opts = {
    hostname: upstream.hostname,
    port: upstream.port || (upstream.protocol === "https:" ? 443 : 80),
    path: req.url,
    method: req.method,
    headers: req.headers,
  };
  const upReq = http.request(opts, (upRes) => {
    const headers = { ...upRes.headers };
    delete headers.connection;
    // OpenClaw gateway sets `Permissions-Policy: camera=(), microphone=(self),
    // geolocation=()` which hard-blocks getUserMedia in Chromium. We rewrite
    // it to permissive on the way out — this is what makes Chrome mobile
    // visitors able to SCAN with their phone's camera at all. Firefox
    // doesn't enforce the policy strictly so it doesn't notice the change.
    headers["permissions-policy"] =
      "camera=(self), microphone=(self), display-capture=(self), geolocation=(self)";
    res.writeHead(upRes.statusCode ?? 502, headers);
    upRes.pipe(res);
  });
  upReq.on("error", (err) => {
    if (!res.headersSent) {
      res.writeHead(502, { "content-type": "text/plain; charset=utf-8" });
    }
    res.end(`upstream error: ${err.message}`);
  });
  req.on("error", () => upReq.destroy());
  req.pipe(upReq);
});

server.listen(HTTPS_PORT, "0.0.0.0", () => {
  const ips = detectLanIps();
  console.log(
    `[demo2-https-proxy] listening on :${HTTPS_PORT}  →  ${UPSTREAM}`,
  );
  console.log(`  Cert ${reused ? "loaded from" : "generated to"} ${CERT_DIR}`);
  console.log(`  SAN: localhost, 127.0.0.1, ${ips.join(", ") || "(no LAN IP)"}`);
  console.log(
    `  Browser URLs (accept cert warning first visit):\n    https://127.0.0.1:${HTTPS_PORT}/`,
  );
  for (const ip of ips) {
    console.log(`    https://${ip}:${HTTPS_PORT}/`);
  }
});
