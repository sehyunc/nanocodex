import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { Readable } from "node:stream";
import { connect as connectTls } from "node:tls";
import { connect as connectTcp } from "node:net";
import { pathToFileURL } from "node:url";
import { AsyncLocalStorage } from "node:async_hooks";
import { channel } from "node:diagnostics_channel";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";

// Observe the existing transport without changing pooling, uploads, or retries.
// Never retain request/response headers, bodies, or credentials in telemetry.
const callTiming = new AsyncLocalStorage();
const requestTimings = new WeakMap();
const usedSockets = new WeakSet();
channel("undici:request:create").subscribe(({ request }) => {
  const timing = callTiming.getStore();
  if (timing) requestTimings.set(request, timing);
});
channel("undici:client:sendHeaders").subscribe(({ request, socket }) => {
  const timing = requestTimings.get(request);
  if (timing) {
    timing.sent = performance.now();
    timing.socket_reused = usedSockets.has(socket);
  }
  usedSockets.add(socket);
});
channel("undici:request:bodySent").subscribe(({ request }) => {
  const timing = requestTimings.get(request);
  if (timing) timing.uploaded = performance.now();
});
channel("undici:request:headers").subscribe(({ request }) => {
  const timing = requestTimings.get(request);
  if (timing) timing.headers = performance.now();
});

const DEFAULT_UPSTREAM_ORIGIN = "https://chatgpt.com";
const MAX_UPSTREAM_HEADER_BYTES = 64 * 1024;
const UPSTREAM_HANDSHAKE_TIMEOUT_MS = 15_000;
const ALLOWED_HTTP_PATHS = new Set([
  "/backend-api/codex/responses",
  "/backend-api/codex/alpha/search",
  "/backend-api/codex/images/edits",
  "/backend-api/codex/images/generations",
  "/backend-api/codex/realtime/calls",
]);
const RESPONSES_PATH = "/backend-api/codex/responses";
const CLIPROXY_RESPONSES_PATH = "/v1/responses";
const CLAUDE_AUTH_PATH = "/tmp/nanocodex-cliproxy-auth/claude-auth.json";
const FORWARDED_HEADERS = [
  "accept",
  "authorization",
  "chatgpt-account-id",
  "content-type",
  "openai-alpha",
  "openai-beta",
  "originator",
  "session-id",
  "thread-id",
  "user-agent",
  "x-client-request-id",
  "x-codex-turn-state",
  "x-oai-attestation",
  "x-openai-fedramp",
  "x-openai-internal-codex-responses-lite",
  "x-responsesapi-include-timing-metrics",
  "x-session-id",
];
const RETURNED_HEADERS = [
  "content-type",
  "location",
  "openai-model",
  "retry-after",
  "x-codex-turn-state",
  "x-reasoning-included",
  "x-request-id",
];

export function startRelay({
  host = "0.0.0.0",
  port = Number(process.env.PORT ?? 8080),
  upstreamOrigin = DEFAULT_UPSTREAM_ORIGIN,
  cliProxyOrigin = "http://127.0.0.1:8317",
} = {}) {
  const upstream = new URL(upstreamOrigin);
  const cliProxy = new URL(cliProxyOrigin);
  if (upstream.protocol !== "https:" && upstream.hostname !== "127.0.0.1") {
    throw new Error("upstream must use HTTPS");
  }
  if (cliProxy.protocol !== "http:" || cliProxy.hostname !== "127.0.0.1"
    || cliProxy.pathname !== "/" || cliProxy.search || cliProxy.hash) {
    throw new Error("CLIProxyAPI must be a loopback HTTP origin");
  }
  const server = createServer((request, response) => {
    void proxyHttp(request, response, upstream, cliProxy).catch((error) => {
      console.warn({ type: "relay.proxy_error", error: error?.name ?? "unknown",
        cause: error?.cause?.code ?? undefined });
      if (response.destroyed) return;
      if (response.headersSent) response.destroy(error);
      else {
        const cause = error?.cause?.code ?? error?.code;
        const safeCause = typeof cause === "string" && /^(?:E[A-Z0-9_]{2,40}|UND_ERR_[A-Z0-9_]{2,40})$/.test(cause)
          ? cause : "unknown";
        response.writeHead(502, { "cache-control": "no-store", "content-type": "text/plain",
          "x-nanocodex-relay-error": safeCause });
        response.end("upstream request failed\n");
      }
    });
  });
  server.on("upgrade", (request, socket, head) => {
    void proxyWebSocket(request, socket, head, upstream, cliProxy).catch((error) => {
      console.warn({ type: "relay.websocket_error", error: error?.name ?? "unknown",
        cause: error?.cause?.code ?? undefined });
      rejectSocket(socket, 503, "gateway unavailable");
    });
  });
  server.on("clientError", (_error, socket) => rejectSocket(socket, 400, "bad request"));
  server.headersTimeout = 10_000;
  server.requestTimeout = 120_000;
  server.listen(port, host);
  return server;
}

async function proxyHttp(request, response, upstreamOrigin, cliProxyOrigin) {
  const incoming = new URL(request.url ?? "/", "http://relay.internal");
  if (incoming.pathname === "/internal/claude-auth" && !incoming.search) {
    if (request.method === "GET") {
      try {
        const auth = await readFile(CLAUDE_AUTH_PATH);
        response.writeHead(200, { "cache-control": "no-store", "content-type": "application/json" });
        response.end(auth);
      } catch (error) {
        response.writeHead(error?.code === "ENOENT" ? 404 : 500, { "cache-control": "no-store" });
        response.end();
      }
      return;
    }
    if (request.method === "PUT") {
      const chunks = [];
      let bytes = 0;
      for await (const chunk of request) {
        bytes += chunk.byteLength;
        if (bytes > 16_384) { response.writeHead(413); response.end(); return; }
        chunks.push(chunk);
      }
      const auth = Buffer.concat(chunks);
      try {
        const value = JSON.parse(auth.toString("utf8"));
        if (value?.type !== "claude" || typeof value.refresh_token !== "string"
          || typeof value.access_token !== "string") throw new Error("invalid auth");
      } catch { response.writeHead(400); response.end(); return; }
      await mkdir("/tmp/nanocodex-cliproxy-auth", { recursive: true, mode: 0o700 });
      const temporary = `${CLAUDE_AUTH_PATH}.${crypto.randomUUID()}`;
      await writeFile(temporary, auth, { mode: 0o600 });
      await rename(temporary, CLAUDE_AUTH_PATH);
      response.writeHead(204, { "cache-control": "no-store" });
      response.end();
      return;
    }
    response.writeHead(405); response.end(); return;
  }
  if (request.method === "GET" && incoming.pathname === "/health") {
    response.writeHead(204, { "cache-control": "no-store" });
    response.end();
    return;
  }
  if (request.method !== "POST" || !ALLOWED_HTTP_PATHS.has(incoming.pathname)
    || (incoming.pathname === RESPONSES_PATH && incoming.search)) {
    response.writeHead(404, { "cache-control": "no-store", "content-type": "text/plain" });
    response.end("not found\n");
    return;
  }
  if (!hasBearer(request.headers.authorization)) {
    response.writeHead(401, { "cache-control": "no-store", "content-type": "text/plain" });
    response.end("missing authorization\n");
    return;
  }

  const headers = forwardedHeaders(request.headers);
  const canary = incoming.pathname === RESPONSES_PATH && isCliProxyCanary(request.headers);
  if (canary && !isClaudeRoute(request.headers) && !hasProviderAccount(request.headers)) {
    response.writeHead(403, { "cache-control": "no-store" });
    response.end();
    return;
  }
  if (canary) prepareCliProxyHeaders(headers, request.headers);
  if (canary) console.info({ type: "relay.cliproxy_canary", transport: "http" });
  if (canary) await waitForCliProxy(cliProxyOrigin);
  headers.set("accept-encoding", "identity");
  const target = canary ? new URL(CLIPROXY_RESPONSES_PATH, cliProxyOrigin)
    : new URL(`${incoming.pathname}${incoming.search}`, upstreamOrigin);
  const controller = new AbortController();
  request.once("aborted", () => controller.abort());
  // The upload is normally already complete when a caller times out waiting
  // for SDP. IncomingMessage's aborted event does not cover that disconnect.
  response.once("close", () => {
    if (!response.writableFinished) controller.abort();
  });
  const timing = incoming.pathname === "/backend-api/codex/realtime/calls"
    ? { began: performance.now() } : undefined;
  const upstream = await callTiming.run(timing, () => fetch(target, {
    method: "POST",
    headers,
    body: request,
    duplex: "half",
    redirect: "manual",
    signal: controller.signal,
  }));
  const returned = { "cache-control": "no-store" };
  if (timing) {
    const durations = {
      process_age_ms: process.uptime() * 1_000,
      fetch_ms: performance.now() - timing.began,
      socket_wait_ms: timing.sent - timing.began,
      upload_ms: timing.uploaded - timing.sent,
      response_wait_ms: timing.headers - timing.uploaded,
    };
    returned["x-nanocodex-relay-timing"] = JSON.stringify({
      ...Object.fromEntries(Object.entries(durations)
        .filter(([, value]) => Number.isFinite(value) && value >= 0)
        .map(([key, value]) => [key, Math.round(value * 100) / 100])),
      ...(typeof timing.socket_reused === "boolean" ? { socket_reused: timing.socket_reused } : {}),
    });
  }
  for (const name of RETURNED_HEADERS) {
    const value = upstream.headers.get(name);
    if (value !== null) returned[name] = value;
  }
  response.writeHead(upstream.status, returned);
  if (!upstream.body) {
    response.end();
    return;
  }
  Readable.fromWeb(upstream.body).once("error", (error) => response.destroy(error)).pipe(response);
}

async function proxyWebSocket(request, socket, head, upstreamOrigin, cliProxyOrigin) {
  const incoming = new URL(request.url ?? "/", "http://relay.internal");
  const websocketKey = firstHeader(request.headers["sec-websocket-key"]);
  if (incoming.pathname !== RESPONSES_PATH) {
    rejectSocket(socket, 404, "not found");
    return;
  }
  if (!hasBearer(request.headers.authorization)) {
    rejectSocket(socket, 401, "missing authorization");
    return;
  }
  if (!websocketKey) {
    rejectSocket(socket, 400, "missing WebSocket key");
    return;
  }
  const canary = isCliProxyCanary(request.headers);
  if (canary && !isClaudeRoute(request.headers) && !hasProviderAccount(request.headers)) {
    rejectSocket(socket, 403, "missing provider account");
    return;
  }
  if (canary) console.info({ type: "relay.cliproxy_canary", transport: "websocket" });
  if (canary) await waitForCliProxy(cliProxyOrigin);
  if (socket.destroyed) return;

  const upstream = canary
    ? connectTcp({ host: cliProxyOrigin.hostname, port: Number(cliProxyOrigin.port) })
    : connectTls({ host: upstreamOrigin.hostname,
        port: Number(upstreamOrigin.port || 443), servername: upstreamOrigin.hostname });
  socket.setNoDelay(true);
  upstream.setNoDelay(true);
  let header = Buffer.alloc(0);
  let upgraded = false;
  const timeout = setTimeout(() => {
    upstream.destroy();
    rejectSocket(socket, 504, "upstream timeout");
  }, UPSTREAM_HANDSHAKE_TIMEOUT_MS);

  upstream.once(canary ? "connect" : "secureConnect", () => {
    const lines = [
      `GET ${canary ? CLIPROXY_RESPONSES_PATH : RESPONSES_PATH + incoming.search} HTTP/1.1`,
      `Host: ${canary ? cliProxyOrigin.host : upstreamOrigin.host}`,
      "Connection: Upgrade",
      "Upgrade: websocket",
      "Sec-WebSocket-Version: 13",
      `Sec-WebSocket-Key: ${websocketKey}`,
    ];
    const headers = forwardedHeaders(request.headers);
    if (canary) prepareCliProxyHeaders(headers, request.headers);
    for (const [name, value] of headers) lines.push(`${name}: ${value}`);
    lines.push("", "");
    upstream.write(lines.join("\r\n"));
  });
  upstream.on("data", function onHandshake(chunk) {
    if (upgraded) return;
    header = Buffer.concat([header, chunk]);
    if (header.byteLength > MAX_UPSTREAM_HEADER_BYTES) {
      clearTimeout(timeout);
      upstream.destroy();
      rejectSocket(socket, 502, "upstream headers too large");
      return;
    }
    const headerEnd = header.indexOf("\r\n\r\n");
    if (headerEnd === -1) return;
    clearTimeout(timeout);
    upgraded = true;
    upstream.off("data", onHandshake);
    socket.write(header);
    if (head.byteLength > 0) upstream.write(head);
    const status = responseStatus(header);
    if (status !== 101) {
      upstream.pipe(socket);
      return;
    }
    socket.pipe(upstream);
    upstream.pipe(socket);
  });
  upstream.once("error", () => {
    clearTimeout(timeout);
    if (!upgraded) rejectSocket(socket, 502, "upstream WebSocket failed");
    else socket.destroy();
  });
  socket.once("error", () => upstream.destroy());
  socket.once("close", () => upstream.destroy());
}

function isCliProxyCanary(headers) {
  return firstHeader(headers["x-nanocodex-cliproxy-canary"]) === "v1";
}

function isClaudeRoute(headers) {
  return firstHeader(headers["x-nanocodex-cliproxy-provider"]) === "claude";
}

function hasProviderAccount(headers) {
  const account = firstHeader(headers["chatgpt-account-id"]);
  return typeof account === "string" && /^[\x21-\x7e]{1,256}$/.test(account);
}

function prepareCliProxyHeaders(headers, source) {
  headers.set("authorization", "Bearer nanocodex-loopback");
  if (isClaudeRoute(source)) {
    headers.delete("chatgpt-account-id");
    return;
  }
  headers.set("x-nanocodex-provider-authorization", firstHeader(source.authorization));
  headers.set("x-nanocodex-provider-account", firstHeader(source["chatgpt-account-id"]));
  headers.delete("chatgpt-account-id");
}

async function waitForCliProxy(origin) {
  const deadline = Date.now() + 20_000;
  while (true) {
    const ready = await new Promise((resolve) => {
      const socket = connectTcp({ host: origin.hostname, port: Number(origin.port) });
      socket.setTimeout(1_000);
      socket.once("connect", () => { socket.destroy(); resolve(true); });
      socket.once("error", () => { socket.destroy(); resolve(false); });
      socket.once("timeout", () => { socket.destroy(); resolve(false); });
    });
    if (ready) return;
    if (Date.now() >= deadline) throw new Error("CLIProxyAPI did not become ready");
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

export function responseStatus(header) {
  const lineEnd = header.indexOf("\r\n");
  if (lineEnd < 0) return Number.NaN;
  return Number(header.subarray(0, lineEnd).toString("ascii").split(" ")[1]);
}

function forwardedHeaders(source) {
  const headers = new Headers();
  for (const name of FORWARDED_HEADERS) {
    const value = firstHeader(source[name]);
    if (value) headers.set(name, value);
  }
  return headers;
}

function firstHeader(value) {
  return Array.isArray(value) ? value[0] : value;
}

function hasBearer(value) {
  return typeof firstHeader(value) === "string" && firstHeader(value).startsWith("Bearer ");
}

function rejectSocket(socket, status, message) {
  if (socket.destroyed || socket.writableEnded) return;
  const body = `${message}\n`;
  socket.end(
    `HTTP/1.1 ${status} ${message}\r\nContent-Type: text/plain\r\nCache-Control: no-store\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`,
  );
}

const entry = process.argv[1] ? pathToFileURL(process.argv[1]).href : undefined;
if (import.meta.url === entry) {
  const server = startRelay();
  server.once("listening", () => {
    let child;
    const start = () => {
      child = spawn("/app/cliproxyapi", ["--config", "/app/cliproxy.config.yaml"], { stdio: "inherit" });
      child.once("error", (error) => console.warn({ type: "relay.cliproxy_start_error", code: error.code }));
      child.once("exit", (code, signal) => {
        console.warn({ type: "relay.cliproxy_exit", code, signal });
        if (server.listening) setTimeout(start, 1_000);
      });
    };
    start();
    process.once("SIGTERM", () => { server.close(); child?.kill("SIGTERM"); });
  });
}
