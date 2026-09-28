import { createServer } from "node:http";
import { randomBytes, randomInt } from "node:crypto";
import { readFile } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readFile as readMediaFile } from "node:fs/promises";
import { randomBytes as randomToken } from "node:crypto";
import { prepareMedia } from "./media-compat.mjs";
import { COMPANION_PROTOCOL_VERSION, parseCompanionSelection, supportsCompanionProtocolVersion } from "../src/core/companion-protocol.mjs";

const port = Number(process.env.COMPANION_PORT || 8787);
const lanEnabled = process.argv.includes("--lan") || process.env.COMPANION_LAN === "1";
const host = lanEnabled ? (process.env.COMPANION_HOST || "0.0.0.0") : "127.0.0.1";
const allowedOrigins = new Set((process.env.COMPANION_ALLOWED_ORIGINS || "http://localhost:5173,http://127.0.0.1:5173")
  .split(",").map((origin) => origin.trim()).filter(Boolean));
const projectDir = fileURLToPath(new URL("../", import.meta.url));
const publicDir = join(projectDir, "public");
const distDir = join(projectDir, "dist");
const sessions = new Map();
let activeSessionId = "";
const MAX_EVENT_WAIT_MS = 25_000;
const MAX_QUEUED_EVENTS = 20;
const SESSION_TTL_MS = 30 * 60 * 1000;
const PAIRING_TTL_MS = 5 * 60 * 1000;
const pairingAttempts = new Map();
const mediaJobs = new Map();
const MAX_ACTIVE_MEDIA_JOBS = 2;
let activeMediaJobs = 0;
const NORDIC_EPG_URL = "https://epgshare01.online/epgshare01/epg_ripper_SE1.xml.gz";
const NORDIC_EPG_MAX_BYTES = 8 * 1024 * 1024;
const MAX_REQUEST_BODY_BYTES = 128 * 1024;

function mediaDebug(event, fields = {}) {
  if (process.env.MEDIA_COMPAT_DEBUG !== "1") return;
  console.info(`[media-compat:route] ${JSON.stringify({ event, ...fields })}`);
}

function sameOriginRequest(request) {
  const origin = request.headers?.origin;
  const host = request.headers?.host;
  if (!host) return false;
  if (!origin) return request.headers?.["sec-fetch-site"] === "same-origin";
  try {
    const parsed = new URL(origin);
    if (`${parsed.host}` === host) return true;
    // Vite's local dev proxy rewrites Host to the relay while retaining the
    // browser's localhost origin. Do not extend this exception to LAN hosts.
    return /^(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/i.test(parsed.host)
      && /^(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/i.test(host);
  } catch { return false; }
}

function loopbackPeer(request) {
  const address = String(request.socket?.remoteAddress || "").toLowerCase();
  return address === "::1" || address === "127.0.0.1" || address === "::ffff:127.0.0.1";
}

function allowedOrigin(origin) {
  if (!origin) return false;
  try {
    const parsed = new URL(origin);
    return parsed.origin === origin && allowedOrigins.has(origin);
  } catch { return false; }
}

async function readPlaylistWithRetry(filename, attempts = 5) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try { return await readMediaFile(filename); }
    catch { if (attempt + 1 < attempts) await new Promise((resolve) => setTimeout(resolve, 40)); }
  }
  return null;
}

async function mediaRoute(request, response, url) {
  const routeKind = url.pathname.endsWith("/prepare") ? "prepare" : url.pathname.endsWith(".m3u8") ? "playlist" : url.pathname.endsWith(".ts") ? "segment" : "cleanup";
  mediaDebug("request", { method: request.method, kind: routeKind });
  response.once?.("close", () => { if (!response.writableFinished) mediaDebug("client_closed_early", { method: request.method, kind: routeKind }); });
  if (!loopbackPeer(request)) return json(response, 403, { error: "Media compatibility request was rejected." });
  if (request.method === "POST" && url.pathname === "/api/media/prepare") {
    if (!sameOriginRequest(request)) return json(response, 403, { error: "Media compatibility request was rejected." });
    if (activeMediaJobs >= MAX_ACTIVE_MEDIA_JOBS) return json(response, 503, { error: "Media conversion is busy. Try again shortly." });
    activeMediaJobs += 1;
    let slotTransferred = false;
    try {
      const input = await body(request);
      if (typeof input.streamUrl !== "string" || input.streamUrl.length > 8192) return json(response, 400, { error: "Media compatibility request was invalid." });
      const job = await prepareMedia(input.streamUrl, { supportsEac3: input.supportsEac3 === true, supportsAc3: input.supportsAc3 === true, supportsH264: input.supportsH264 === true, startSeconds: input.startSeconds });
      if (job.direct) return json(response, 200, { direct: true, audioConverted: false });
      const id = randomToken(18).toString("hex");
      let slotReleased = false;
      const releaseSlot = () => {
        if (slotReleased) return;
        slotReleased = true;
        activeMediaJobs = Math.max(0, activeMediaJobs - 1);
      };
      const record = { ...job, id, createdAt: Date.now(), lastPlaylist: await readPlaylistWithRetry(job.playlist) };
      const jobCleanup = record.cleanup;
      record.cleanup = async () => {
        try { await jobCleanup(); } finally { releaseSlot(); }
      };
      mediaJobs.set(id, record);
      record.process.once("close", () => { record.finishedAt = Date.now(); releaseSlot(); });
      if ((record.process.exitCode !== null && record.process.exitCode !== undefined)
        || (record.process.signalCode !== null && record.process.signalCode !== undefined)) {
        record.finishedAt = Date.now();
        releaseSlot();
      }
      slotTransferred = true;
      const durationSeconds = Number.isFinite(job.plan.duration) && job.plan.duration > 0 ? job.plan.duration : null;
      return json(response, 200, { url: `/api/media/${id}/index.m3u8`, audioConverted: job.plan.convertAudio, durationSeconds, startSeconds: job.startSeconds || 0 });
    } catch {
      return json(response, 422, { error: "Media could not be prepared for browser playback." });
    } finally { if (!slotTransferred) activeMediaJobs = Math.max(0, activeMediaJobs - 1); }
  }
  const remove = url.pathname.match(/^\/api\/media\/([a-f0-9]{36})$/);
  if (request.method === "DELETE" && remove) {
    if (!sameOriginRequest(request)) return json(response, 403, { error: "Media compatibility request was rejected." });
    const job = mediaJobs.get(remove[1]);
    if (job) {
      mediaJobs.delete(remove[1]);
      try { await job.cleanup(); } catch { /* Stale temp-file cleanup must not turn DELETE into an unhandled server error. */ }
    }
    response.writeHead(204, { "cache-control": "no-store" });
    response.end();
    return true;
  }
  const match = url.pathname.match(/^\/api\/media\/([a-f0-9]{36})\/(index\.m3u8|segment\d{5}\.ts)$/);
  if (!match || request.method !== "GET") { mediaDebug("unmatched", { method: request.method, kind: routeKind }); return false; }
  if (!sameOriginRequest(request)) return json(response, 403, { error: "Media compatibility request was rejected." });
  const job = mediaJobs.get(match[1]);
  if (!job) return json(response, 404, { error: "Media playback expired." });
  const isPlaylist = match[2] === "index.m3u8";
  const filename = isPlaylist ? job.playlist : join(job.directory, match[2]);
  try {
    const data = isPlaylist ? await readPlaylistWithRetry(filename) : await readMediaFile(filename);
    if (!data) throw new Error("Playlist is being updated.");
    if (isPlaylist) job.lastPlaylist = data;
    response.writeHead(200, { "content-type": isPlaylist ? "application/vnd.apple.mpegurl" : "video/mp2t", "content-length": data.byteLength, "cache-control": "no-store", ...(allowedOrigin(request.headers.origin) ? { "access-control-allow-origin": request.headers.origin, vary: "Origin" } : {}) });
    mediaDebug("served", { kind: routeKind, status: 200, bytes: data.byteLength });
    response.end(data);
  } catch {
    // FFmpeg atomically replaces EVENT playlists via temp_file. A concurrent
    // hls.js level reload can briefly see ENOENT during rename; return the last
    // complete manifest instead of a fatal 503 that stops playback.
    if (isPlaylist && job.lastPlaylist) {
      mediaDebug("served_cached", { kind: "playlist", status: 200, bytes: job.lastPlaylist.byteLength });
      response.writeHead(200, { "content-type": "application/vnd.apple.mpegurl", "content-length": job.lastPlaylist.byteLength, "cache-control": "no-store", ...(allowedOrigin(request.headers.origin) ? { "access-control-allow-origin": request.headers.origin, vary: "Origin" } : {}) });
      response.end(job.lastPlaylist);
      return true;
    }
    mediaDebug("unavailable", { kind: routeKind, status: 503 });
    response.writeHead(503, { "retry-after": "2", "cache-control": "no-store", "content-type": "text/plain" });
    response.end("Preparing media");
  }
  return true;
}

function json(response, status, value) {
  const body = JSON.stringify(value);
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...(response.corsOrigin ? { "access-control-allow-origin": response.corsOrigin, vary: "Origin" } : {}) });
  response.end(body);
}

/** Browser-only CORS bridge for a public guide; TV clients fetch it directly. */
async function nordicEpg(response) {
  try {
    const upstream = await fetch(NORDIC_EPG_URL, { signal: AbortSignal.timeout(30_000) });
    const declaredLength = Number(upstream.headers.get("content-length"));
    if (!upstream.ok || (Number.isFinite(declaredLength) && declaredLength > NORDIC_EPG_MAX_BYTES)) throw new Error("Nordic EPG unavailable");
    const payload = Buffer.from(await upstream.arrayBuffer());
    if (payload.byteLength > NORDIC_EPG_MAX_BYTES) throw new Error("Nordic EPG too large");
    response.writeHead(200, {
      "content-type": "application/gzip",
      "content-length": payload.byteLength,
      "cache-control": "public, max-age=300",
      ...(response.corsOrigin ? { "access-control-allow-origin": response.corsOrigin, vary: "Origin" } : {}),
    });
    response.end(payload);
  } catch {
    json(response, 502, { error: "Nordic EPG is unavailable." });
  }
}

async function body(request) {
  const declaredLength = request.headers?.["content-length"];
  if (declaredLength !== undefined) {
    const length = typeof declaredLength === "string" && /^\d+$/.test(declaredLength) ? Number(declaredLength) : NaN;
    if (!Number.isSafeInteger(length) || length > MAX_REQUEST_BODY_BYTES) {
      request.destroy?.();
      throw new Error("Request body rejected");
    }
  }
  const chunks = [];
  let byteLength = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    byteLength += bytes.byteLength;
    if (byteLength > MAX_REQUEST_BODY_BYTES) {
      request.destroy?.();
      throw new Error("Request body rejected");
    }
    chunks.push(bytes);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

function sessionFor(value) {
  const session = sessions.get(value);
  if (!session || Date.now() - session.createdAt > SESSION_TTL_MS) {
    if (session) sessions.delete(value);
    if (activeSessionId === value) activeSessionId = "";
    return null;
  }
  return session;
}

function publicSession(session) {
  return { expiresAt: session.createdAt + SESSION_TTL_MS, sourceFingerprint: session.sourceFingerprint };
}

function wakeEventWaiters(session) {
  for (const wake of [...(session?.eventWaiters || [])]) wake();
}

function waitForCompanionEvent(request, response, session, after, timeoutMs) {
  if (session.events.some((event) => event.sequence > after)) return Promise.resolve("event");
  return new Promise((resolve) => {
    let settled = false;
    const cleanup = () => {
      clearTimeout(timer);
      session.eventWaiters.delete(wake);
      request.removeListener?.("aborted", onAbort);
      response.removeListener?.("close", onClose);
    };
    const finish = (reason) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(reason);
    };
    const wake = () => finish("wake");
    const onAbort = () => finish("disconnect");
    const onClose = () => { if (!response.writableFinished) finish("disconnect"); };
    const timer = setTimeout(() => finish("timeout"), timeoutMs);
    session.eventWaiters.add(wake);
    request.once?.("aborted", onAbort);
    response.once?.("close", onClose);
    // Cover a publication between the initial check and waiter registration.
    if (session.events.some((event) => event.sequence > after)) wake();
  });
}

function bearer(request) {
  const value = request.headers?.authorization;
  const match = typeof value === "string" ? value.match(/^Bearer ([a-f0-9]{64})$/i) : null;
  return match?.[1] || "";
}

function sessionForCredential(request, scope) {
  const credential = bearer(request);
  if (!credential) return null;
  const session = sessions.get(activeSessionId);
  if (!session || Date.now() >= session.createdAt + SESSION_TTL_MS) return null;
  if (scope === "tv" ? session.tvCredential !== credential : session.browserCredential !== credential) return null;
  return session;
}

export async function route(request, response, url) {
  const origin = request.headers?.origin;
  if (allowedOrigin(origin)) response.corsOrigin = origin;
  if (request.method === "OPTIONS") {
    if (!allowedOrigin(origin)) return json(response, 403, { error: "Request origin is not allowed." });
    response.writeHead(204, { "access-control-allow-origin": origin, "access-control-allow-methods": "GET,POST,DELETE,OPTIONS", "access-control-allow-headers": "content-type, authorization", vary: "Origin" });
    response.end();
    return;
  }
  if (["POST", "PUT", "PATCH", "DELETE"].includes(request.method) && origin && !allowedOrigin(origin)) return json(response, 403, { error: "Request origin is not allowed." });
  if (url.pathname.startsWith("/api/media/")) { const handled = await mediaRoute(request, response, url); if (handled !== false) return; }
  if (request.method === "GET" && url.pathname === "/api/nordic-epg") return nordicEpg(response);
  if (request.method === "POST" && url.pathname === "/api/connect") {
    // A live TV owns the single active slot. An app reload loses its in-memory
    // credential, so replacing that session then requires an explicit relay restart.
    const current = sessionFor(activeSessionId);
    if (current && sessionForCredential(request, "tv") !== current) return json(response, 404, { error: "Companion connection could not be established." });
    try {
      const input = await body(request);
      if (!supportsCompanionProtocolVersion(input.protocolVersion)) return json(response, 400, { error: "Companion protocol version is unsupported." });
      const sourceFingerprint = String(input.sourceFingerprint || "");
      if (!/^vod_[a-z0-9]{1,8}$/.test(sourceFingerprint)) return json(response, 400, { error: "A valid Xtream source fingerprint is required." });
      for (const oldSession of sessions.values()) wakeEventWaiters(oldSession);
      const session = {
        id: randomBytes(18).toString("hex"), createdAt: Date.now(), sourceFingerprint, events: [], nextEvent: 1,
        acknowledgedSequence: 0, highestDeliveredSequence: 0, droppedThroughSequence: 0, reportedGapThroughSequence: 0, eventWaiters: new Set(),
        tvCredential: randomBytes(32).toString("hex"), browserCredential: "",
        pairingCode: String(randomInt(0, 100_000_000)).padStart(8, "0"),
        pairingExpiresAt: Date.now() + PAIRING_TTL_MS, pairingRedeemed: false,
      };
      sessions.clear();
      sessions.set(session.id, session);
      activeSessionId = session.id;
      return json(response, 200, { protocolVersion: COMPANION_PROTOCOL_VERSION, ...publicSession(session), tvCredential: session.tvCredential, pairingCode: session.pairingCode, pairingExpiresAt: session.pairingExpiresAt });
    } catch { return json(response, 400, { error: "Companion connection request was invalid." }); }
  }
  if (request.method === "POST" && url.pathname === "/api/pair/redeem") {
    if (!allowedOrigin(origin)) return json(response, 403, { error: "Request origin is not allowed." });
    const peer = String(request.socket?.remoteAddress || "unknown");
    const now = Date.now();
    const attempt = pairingAttempts.get(peer);
    if (attempt && now - attempt.startedAt < 60_000 && attempt.count >= 10) return json(response, 429, { error: "Pairing attempts are temporarily limited." });
    pairingAttempts.set(peer, !attempt || now - attempt.startedAt >= 60_000 ? { startedAt: now, count: 1 } : { ...attempt, count: attempt.count + 1 });
    try {
      const input = await body(request);
      if (!supportsCompanionProtocolVersion(input.protocolVersion)) return json(response, 400, { error: "Pairing protocol version is unsupported." });
      const session = sessions.get(activeSessionId);
      if (!session || Date.now() >= session.createdAt + SESSION_TTL_MS || session.pairingRedeemed
        || Date.now() >= session.pairingExpiresAt || String(input.code || "") !== session.pairingCode) return json(response, 400, { error: "Pairing code is invalid or expired." });
      session.pairingRedeemed = true;
      session.pairingCode = "";
      session.browserCredential = randomBytes(32).toString("hex");
      wakeEventWaiters(session);
      return json(response, 200, { protocolVersion: COMPANION_PROTOCOL_VERSION, ...publicSession(session), browserCredential: session.browserCredential });
    } catch { return json(response, 400, { error: "Pairing request was invalid." }); }
  }
  if (request.method === "GET" && url.pathname === "/api/active") {
    const session = sessionForCredential(request, "browser");
    return session ? json(response, 200, { protocolVersion: COMPANION_PROTOCOL_VERSION, ...publicSession(session) }) : json(response, 404, { error: "No paired TV connection is available." });
  }
  if (request.method === "POST" && url.pathname === "/api/pair/select") {
    try {
      const input = await body(request);
      const session = sessionForCredential(request, "browser");
      if (!supportsCompanionProtocolVersion(input.protocolVersion)) return json(response, 400, { error: "Selection protocol version is unsupported." });
      const selection = parseCompanionSelection(input.selection);
      if (!session || !selection || selection.sourceFingerprint !== session.sourceFingerprint) return json(response, 400, { error: "Selection is invalid or companion connection expired." });
      const event = { sequence: session.nextEvent++, selection };
      session.events.push(event);
      if (session.events.length > MAX_QUEUED_EVENTS) {
        const removed = session.events.splice(0, session.events.length - MAX_QUEUED_EVENTS);
        session.droppedThroughSequence = Math.max(session.droppedThroughSequence, removed.at(-1).sequence);
      }
      wakeEventWaiters(session);
      return json(response, 200, { protocolVersion: COMPANION_PROTOCOL_VERSION, accepted: true });
    } catch { return json(response, 400, { error: "Selection request was invalid." }); }
  }
  if (request.method === "POST" && url.pathname === "/api/pair/play") {
    try {
      const input = await body(request);
      const session = sessionForCredential(request, "browser");
      if (!supportsCompanionProtocolVersion(input.protocolVersion)) return json(response, 400, { error: "Playback protocol version is unsupported." });
      const selection = parseCompanionSelection(input.selection);
      if (!session || !selection || selection.sourceFingerprint !== session.sourceFingerprint
        || !/^(movie|episode)$/.test(selection.kind)
        || (selection.kind === "episode" && !selection.seriesId)) return json(response, 400, { error: "Playback command is invalid or the TV connection expired." });
      const event = { sequence: session.nextEvent++, action: "play", selection };
      session.events.push(event);
      if (session.events.length > MAX_QUEUED_EVENTS) {
        const removed = session.events.splice(0, session.events.length - MAX_QUEUED_EVENTS);
        session.droppedThroughSequence = Math.max(session.droppedThroughSequence, removed.at(-1).sequence);
      }
      wakeEventWaiters(session);
      return json(response, 200, { protocolVersion: COMPANION_PROTOCOL_VERSION, accepted: true });
    } catch { return json(response, 400, { error: "Playback command was invalid." }); }
  }
  if (request.method === "GET" && url.pathname === "/api/pair/events") {
    const session = sessionForCredential(request, "tv");
    if (!session) return json(response, 404, { error: "Companion connection expired." });
    const after = Number(url.searchParams.get("after") || 0);
    if (!Number.isSafeInteger(after) || after < 0) return json(response, 400, { error: "Events sequence is invalid." });
    const requestedVersion = url.searchParams.get("protocolVersion");
    if (requestedVersion !== null && !supportsCompanionProtocolVersion(Number(requestedVersion))) return json(response, 400, { error: "Events protocol version is unsupported." });
    const requestedWait = Number(url.searchParams.get("wait") ?? MAX_EVENT_WAIT_MS);
    if (!Number.isFinite(requestedWait) || requestedWait < 0) return json(response, 400, { error: "Events wait duration is invalid." });
    const waitMs = Math.min(MAX_EVENT_WAIT_MS, Math.floor(requestedWait));
    const alreadyHasGap = after < Math.max(session.acknowledgedSequence, session.droppedThroughSequence);
    if (!alreadyHasGap && !session.events.some((event) => event.sequence > after) && waitMs > 0) {
      const reason = await waitForCompanionEvent(request, response, session, after, waitMs);
      if (reason === "disconnect" || response.writableEnded) return;
      if (sessionForCredential(request, "tv") !== session) return json(response, 404, { error: "Companion connection expired." });
    }
    const firstAvailableSequence = session.events[0]?.sequence ?? session.nextEvent;
    const gapThroughSequence = Math.max(session.acknowledgedSequence, session.droppedThroughSequence);
    const retentionGap = after < gapThroughSequence
      ? { throughSequence: gapThroughSequence, firstAvailableSequence }
      : null;
    const events = session.events.filter((event) => event.sequence > Math.max(after, gapThroughSequence));
    if (retentionGap) session.reportedGapThroughSequence = Math.max(session.reportedGapThroughSequence, gapThroughSequence);
    if (events.length) session.highestDeliveredSequence = Math.max(session.highestDeliveredSequence, events.at(-1).sequence);
    return json(response, 200, { protocolVersion: COMPANION_PROTOCOL_VERSION, events, paired: session.pairingRedeemed, retentionGap });
  }
  if (request.method === "POST" && url.pathname === "/api/pair/ack") {
    const session = sessionForCredential(request, "tv");
    if (!session) return json(response, 404, { error: "Companion connection expired." });
    try {
      const input = await body(request);
      if (!supportsCompanionProtocolVersion(input.protocolVersion)) return json(response, 400, { error: "Acknowledgement protocol version is unsupported." });
      const sequence = input.sequence;
      const maximumAcknowledgable = Math.max(session.highestDeliveredSequence, session.reportedGapThroughSequence);
      if (!Number.isSafeInteger(sequence) || sequence < session.acknowledgedSequence || sequence > maximumAcknowledgable) {
        return json(response, 400, { error: "Acknowledgement sequence is invalid." });
      }
      session.acknowledgedSequence = sequence;
      session.events = session.events.filter((event) => event.sequence > sequence);
      return json(response, 200, { protocolVersion: COMPANION_PROTOCOL_VERSION, acknowledged: sequence });
    } catch { return json(response, 400, { error: "Acknowledgement request was invalid." }); }
  }
  if (url.pathname.startsWith("/api/")) return json(response, 404, { error: "Not found" });
  return serveStatic(url.pathname, response);
}

async function serveStatic(pathname, response) {
  let relative;
  try { relative = decodeURIComponent(pathname).replace(/^\/+/, ""); } catch { return json(response, 404, { error: "Not found" }); }
  if (relative.split(/[\\/]/).some((part) => part === "..")) return json(response, 404, { error: "Not found" });
  const candidates = relative
    ? [join(distDir, relative), join(publicDir, relative)]
    : [join(distDir, "index.html")];
  for (const candidate of candidates) {
    try {
      const file = await readFile(candidate);
      const extension = extname(candidate);
      const contentType = extension === ".html" ? "text/html; charset=utf-8"
        : extension === ".js" ? "text/javascript; charset=utf-8"
          : extension === ".css" ? "text/css; charset=utf-8"
            : extension === ".svg" ? "image/svg+xml"
              : extension === ".json" ? "application/json; charset=utf-8"
                : "application/octet-stream";
      response.writeHead(200, { "content-type": contentType, "cache-control": extension === ".html" ? "no-store" : "public, max-age=3600" });
      response.end(file);
      return;
    } catch { /* Try the next safe static root. */ }
  }
  // SPA route fallback: serve the React entry point for non-API browser paths.
  try {
    const file = await readFile(join(distDir, "index.html"));
    response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    response.end(file);
  } catch { json(response, 404, { error: "Not found" }); }
}

const server = createServer((request, response) => {
  const url = new URL(request.url || "/", `http://${request.headers.host || "localhost"}`);
  void route(request, response, url);
});
if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  server.once("error", (error) => {
    const code = typeof error?.code === "string" && /^[A-Z0-9_]+$/.test(error.code) ? error.code : "UNKNOWN";
    const explanation = code === "EADDRINUSE" ? "the port is already in use"
      : code === "EACCES" || code === "EPERM" ? "permission was denied"
        : "the network listener could not be started";
    console.error(`Companion service could not listen on port ${port}: ${explanation} (${code}).`);
    process.exitCode = 1;
  });
  if (lanEnabled) console.warn("WARNING: Companion LAN mode uses plain HTTP. Pairing codes and scoped credentials are unencrypted in transit; use only on a trusted network.");
  server.listen(port, host, () => {
    const address = server.address();
    const listeningPort = address && typeof address === "object" ? address.port : port;
    console.log(`Companion service listening on http://${host}:${listeningPort}`);
  });

  const mediaCleanup = setInterval(() => {
    for (const [id, job] of mediaJobs) if (job.finishedAt && Date.now() - job.finishedAt > 10 * 60 * 1000) {
      mediaJobs.delete(id);
      void job.cleanup().catch(() => undefined);
    }
  }, 60_000);
  mediaCleanup.unref();
  for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => {
    clearInterval(mediaCleanup);
    void Promise.allSettled([...mediaJobs.values()].map((job) => job.cleanup())).finally(() => {
      mediaJobs.clear();
      server.close(() => process.exit(0));
    });
  });

  setInterval(() => {
    for (const [id, session] of sessions) if (Date.now() - session.createdAt > SESSION_TTL_MS) {
      sessions.delete(id);
      if (activeSessionId === id) activeSessionId = "";
    }
  }, 60_000).unref();
}
