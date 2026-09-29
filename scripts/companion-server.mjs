import { createServer as createHttpServer } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { randomBytes, randomInt } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
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
const MAX_COMPANION_DEVICES = 16;
const sessionIdsByCredential = new Map();
const sessionIdsByPairingCode = new Map();
const MAX_EVENT_WAIT_MS = 25_000;
const MAX_QUEUED_EVENTS = 20;
const SESSION_TTL_MS = 30 * 60 * 1000;
const PAIRING_TTL_MS = 5 * 60 * 1000;
const pairingAttempts = new Map();
const mediaJobs = new Map();
const MAX_ACTIVE_MEDIA_JOBS = 2;
const MAX_ACTIVE_MEDIA_JOBS_PER_CLIENT = 1;
const MEDIA_REQUEST_WINDOW_MS = 60_000;
const MAX_MEDIA_REQUESTS_PER_WINDOW = 120;
const MAX_MEDIA_CONVERSIONS_PER_WINDOW = 12;
const MAX_MEDIA_CLIENTS = 128;
const mediaClients = new Map();
let activeMediaJobs = 0;
const NORDIC_EPG_URL = "https://epgshare01.online/epgshare01/epg_ripper_SE1.xml.gz";
const NORDIC_EPG_MAX_BYTES = 8 * 1024 * 1024;
const MAX_REQUEST_BODY_BYTES = 128 * 1024;
const NORDIC_EPG_TTL_MS = 5 * 60 * 1000;
let nordicEpgCache = null;
let nordicEpgPending = null;
const metricCounts = new Map();

function metric(name) {
  metricCounts.set(name, (metricCounts.get(name) || 0) + 1);
}

export function getRelayMetrics() {
  return Object.fromEntries(metricCounts);
}

function clientKey(request) {
  const address = String(request.socket?.remoteAddress || "unknown").toLowerCase();
  const origin = allowedOrigin(request.headers?.origin) ? request.headers.origin : "same-origin";
  return `${address}|${origin}`;
}

function clientUsage(key, now = Date.now()) {
  let usage = mediaClients.get(key);
  if (!usage) {
    if (mediaClients.size >= MAX_MEDIA_CLIENTS) {
      for (const [oldKey, oldUsage] of mediaClients) {
        if (oldUsage.activeJobs === 0 && now - oldUsage.lastSeenAt > MEDIA_REQUEST_WINDOW_MS) mediaClients.delete(oldKey);
      }
      if (mediaClients.size >= MAX_MEDIA_CLIENTS) {
        const reclaim = [...mediaClients].find(([, candidate]) => candidate.activeJobs === 0)?.[0];
        if (reclaim) mediaClients.delete(reclaim);
      }
    }
    if (mediaClients.size >= MAX_MEDIA_CLIENTS) return null;
    usage = { startedAt: now, requests: 0, conversions: 0, activeJobs: 0, lastSeenAt: now };
    mediaClients.set(key, usage);
  } else if (now - usage.startedAt >= MEDIA_REQUEST_WINDOW_MS) {
    usage.startedAt = now;
    usage.requests = 0;
    usage.conversions = 0;
  }
  if (usage) {
    usage.lastSeenAt = now;
  }
  return usage;
}

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
    try { return await readFile(filename); }
    catch { if (attempt + 1 < attempts) await new Promise((resolve) => setTimeout(resolve, 40)); }
  }
  return null;
}

async function mediaRoute(request, response, url) {
  const routeKind = url.pathname.endsWith("/prepare") ? "prepare" : url.pathname.endsWith(".m3u8") ? "playlist" : url.pathname.endsWith(".ts") ? "segment" : "cleanup";
  if (!loopbackPeer(request)) return json(response, 403, { error: "Media compatibility request was rejected." });
  const usage = clientUsage(clientKey(request));
  if (!usage) return json(response, 503, { error: "Media compatibility service is busy." });
  usage.requests += 1;
  if (usage.requests > MAX_MEDIA_REQUESTS_PER_WINDOW) {
    metric("media_rate_limited");
    return json(response, 429, { error: "Media requests are temporarily limited." });
  }
  metric(`media_${routeKind}_request`);
  mediaDebug("request", { method: request.method, kind: routeKind });
  response.once?.("close", () => { if (!response.writableFinished) mediaDebug("client_closed_early", { method: request.method, kind: routeKind }); });
  if (request.method === "POST" && url.pathname === "/api/media/prepare") {
    if (!sameOriginRequest(request)) return json(response, 403, { error: "Media compatibility request was rejected." });
    if (usage.conversions >= MAX_MEDIA_CONVERSIONS_PER_WINDOW) {
      metric("media_conversion_quota_limited");
      return json(response, 429, { error: "Media conversions are temporarily limited." });
    }
    if (usage.activeJobs >= MAX_ACTIVE_MEDIA_JOBS_PER_CLIENT || activeMediaJobs >= MAX_ACTIVE_MEDIA_JOBS) {
      metric("media_conversion_busy");
      return json(response, 503, { error: "Media conversion is busy. Try again shortly." });
    }
    usage.conversions += 1;
    usage.activeJobs += 1;
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
        usage.activeJobs = Math.max(0, usage.activeJobs - 1);
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
      metric("media_conversion_failed");
      return json(response, 422, { error: "Media could not be prepared for browser playback." });
    } finally {
      if (!slotTransferred) {
        activeMediaJobs = Math.max(0, activeMediaJobs - 1);
        usage.activeJobs = Math.max(0, usage.activeJobs - 1);
      }
    }
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
  if (!isPlaylist) {
    try {
      const info = await stat(filename);
      if (!info.isFile()) throw new Error("Not a media segment");
      response.writeHead(200, { "content-type": "video/mp2t", "content-length": info.size, "cache-control": "no-store", ...(allowedOrigin(request.headers.origin) ? { "access-control-allow-origin": request.headers.origin, vary: "Origin" } : {}) });
      metric("media_segment_served");
      mediaDebug("served", { kind: routeKind, status: 200, bytes: info.size });
      const stream = createReadStream(filename);
      stream.once("error", () => { if (!response.writableEnded) response.destroy?.(); });
      stream.pipe(response);
    } catch {
      metric("media_segment_unavailable");
      response.writeHead(503, { "retry-after": "2", "cache-control": "no-store", "content-type": "text/plain" });
      response.end("Preparing media");
    }
    return true;
  }
  try {
    const data = await readPlaylistWithRetry(filename);
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
    if (nordicEpgCache && nordicEpgCache.expiresAt > Date.now()) {
      metric("epg_cache_hit");
      return sendNordicEpg(response, nordicEpgCache.payload);
    }
    if (!nordicEpgPending) {
      metric("epg_cache_miss");
      nordicEpgPending = fetchNordicEpg().then((payload) => {
        nordicEpgCache = { payload, expiresAt: Date.now() + NORDIC_EPG_TTL_MS };
        return payload;
      }).finally(() => { nordicEpgPending = null; });
    } else metric("epg_singleflight_waiter");
    const payload = await nordicEpgPending;
    sendNordicEpg(response, payload);
  } catch {
    metric("epg_upstream_failure");
    json(response, 502, { error: "Nordic EPG is unavailable." });
  }
}

async function fetchNordicEpg() {
  const upstream = await fetch(NORDIC_EPG_URL, { signal: AbortSignal.timeout(30_000) });
  const declaredLength = Number(upstream.headers.get("content-length"));
  if (!upstream.ok || (Number.isFinite(declaredLength) && declaredLength > NORDIC_EPG_MAX_BYTES)) throw new Error("Nordic EPG unavailable");
  if (!upstream.body) throw new Error("Nordic EPG unavailable");
  const reader = upstream.body.getReader();
  const chunks = [];
  let byteLength = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      byteLength += value.byteLength;
      if (byteLength > NORDIC_EPG_MAX_BYTES) throw new Error("Nordic EPG too large");
      chunks.push(Buffer.from(value));
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  }
  return Buffer.concat(chunks, byteLength);
}

function sendNordicEpg(response, payload) {
  metric("epg_served");
  response.writeHead(200, {
    "content-type": "application/gzip",
    "content-length": payload.byteLength,
    "cache-control": "public, max-age=300",
    ...(response.corsOrigin ? { "access-control-allow-origin": response.corsOrigin, vary: "Origin" } : {}),
  });
  response.end(payload);
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
    if (session) deleteSession(value);
    return null;
  }
  return session;
}

function publicSession(session) {
  return {
    deviceId: session.deviceId,
    deviceName: session.deviceName,
    expiresAt: session.createdAt + SESSION_TTL_MS,
    sourceFingerprint: session.sourceFingerprint,
  };
}

function deleteSession(deviceId) {
  const session = sessions.get(deviceId);
  if (!session) return;
  sessions.delete(deviceId);
  sessionIdsByCredential.delete(session.tvCredential);
  if (session.browserCredential) sessionIdsByCredential.delete(session.browserCredential);
  if (session.pairingCode) sessionIdsByPairingCode.delete(session.pairingCode);
  wakeEventWaiters(session);
}

function issuePairingCode(session) {
  if (session.pairingCode) sessionIdsByPairingCode.delete(session.pairingCode);
  let code = "";
  do { code = String(randomInt(0, 100_000_000)).padStart(8, "0"); }
  while (sessionIdsByPairingCode.has(code));
  session.pairingCode = code;
  session.pairingExpiresAt = Date.now() + PAIRING_TTL_MS;
  sessionIdsByPairingCode.set(code, session.deviceId);
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
  const deviceId = sessionIdsByCredential.get(credential);
  if (!deviceId) return null;
  const session = sessionFor(deviceId);
  if (!session || (scope === "tv" ? session.tvCredential !== credential : session.browserCredential !== credential)) return null;
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
    try {
      const input = await body(request);
      if (!supportsCompanionProtocolVersion(input.protocolVersion)) return json(response, 400, { error: "Companion protocol version is unsupported." });
      const sourceFingerprint = String(input.sourceFingerprint || "");
      const deviceId = String(input.deviceId || "").toLowerCase();
      const deviceName = String(input.deviceName || "").replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 40);
      if (!/^vod_[a-z0-9]{1,8}$/.test(sourceFingerprint)) return json(response, 400, { error: "A valid Xtream source fingerprint is required." });
      if (!/^[a-f0-9]{32}$/.test(deviceId) || !deviceName) return json(response, 400, { error: "TV device identity is invalid." });
      let session = sessionFor(deviceId);
      if (session && sessionForCredential(request, "tv") !== session) return json(response, 404, { error: "Companion connection could not be established." });
      if (!session && sessions.size >= MAX_COMPANION_DEVICES) return json(response, 503, { error: "The relay has reached its TV connection limit." });
      const now = Date.now();
      if (session) {
        const sourceChanged = session.sourceFingerprint !== sourceFingerprint;
        session.createdAt = now;
        session.deviceName = deviceName;
        session.sourceFingerprint = sourceFingerprint;
        if (sourceChanged) {
          if (session.browserCredential) sessionIdsByCredential.delete(session.browserCredential);
          session.browserCredential = "";
          session.pairingRedeemed = false;
          session.events = [];
          session.nextEvent = 1;
          session.acknowledgedSequence = 0;
          session.highestDeliveredSequence = 0;
          session.droppedThroughSequence = 0;
          session.reportedGapThroughSequence = 0;
          wakeEventWaiters(session);
          issuePairingCode(session);
        } else if (!session.pairingRedeemed && Date.now() >= session.pairingExpiresAt) {
          issuePairingCode(session);
        }
      } else {
        session = {
          deviceId, deviceName, createdAt: now, sourceFingerprint, events: [], nextEvent: 1,
          acknowledgedSequence: 0, highestDeliveredSequence: 0, droppedThroughSequence: 0, reportedGapThroughSequence: 0, eventWaiters: new Set(),
          tvCredential: randomBytes(32).toString("hex"), browserCredential: "",
          pairingCode: "", pairingExpiresAt: 0, pairingRedeemed: false,
        };
        issuePairingCode(session);
        sessions.set(deviceId, session);
        sessionIdsByCredential.set(session.tvCredential, deviceId);
      }
      return json(response, 200, {
        protocolVersion: COMPANION_PROTOCOL_VERSION,
        ...publicSession(session),
        tvCredential: session.tvCredential,
        pairingCode: session.pairingCode,
        pairingExpiresAt: session.pairingExpiresAt,
        paired: session.pairingRedeemed,
      });
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
      const deviceId = sessionIdsByPairingCode.get(String(input.code || ""));
      const session = deviceId ? sessionFor(deviceId) : null;
      if (!session || Date.now() >= session.createdAt + SESSION_TTL_MS || session.pairingRedeemed
        || Date.now() >= session.pairingExpiresAt || String(input.code || "") !== session.pairingCode) return json(response, 400, { error: "Pairing code is invalid or expired." });
      session.pairingRedeemed = true;
      sessionIdsByPairingCode.delete(session.pairingCode);
      session.pairingCode = "";
      session.browserCredential = randomBytes(32).toString("hex");
      sessionIdsByCredential.set(session.browserCredential, session.deviceId);
      wakeEventWaiters(session);
      return json(response, 200, { protocolVersion: COMPANION_PROTOCOL_VERSION, ...publicSession(session), browserCredential: session.browserCredential });
    } catch { return json(response, 400, { error: "Pairing request was invalid." }); }
  }
  if (request.method === "POST" && url.pathname === "/api/pair/reset") {
    const session = sessionForCredential(request, "tv");
    if (!session) return json(response, 404, { error: "Companion connection expired." });
    try {
      const input = await body(request);
      if (!supportsCompanionProtocolVersion(input.protocolVersion)) return json(response, 400, { error: "Pairing protocol version is unsupported." });
      if (session.browserCredential) sessionIdsByCredential.delete(session.browserCredential);
      session.browserCredential = "";
      session.pairingRedeemed = false;
      session.events = [];
      session.nextEvent = 1;
      session.acknowledgedSequence = 0;
      session.highestDeliveredSequence = 0;
      session.droppedThroughSequence = 0;
      session.reportedGapThroughSequence = 0;
      issuePairingCode(session);
      wakeEventWaiters(session);
      return json(response, 200, {
        protocolVersion: COMPANION_PROTOCOL_VERSION,
        deviceId: session.deviceId,
        pairingCode: session.pairingCode,
        pairingExpiresAt: session.pairingExpiresAt,
      });
    } catch { return json(response, 400, { error: "Pairing reset request was invalid." }); }
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

function handleRequest(request, response) {
  const url = new URL(request.url || "/", `http://${request.headers.host || "localhost"}`);
  void route(request, response, url);
}

export function createCompanionServer(tlsMaterial) {
  const hasCert = Boolean(tlsMaterial?.cert);
  const hasKey = Boolean(tlsMaterial?.key);
  if (hasCert !== hasKey) throw new Error("Companion TLS requires both certificate and private key.");
  return hasCert
    ? createHttpsServer({ cert: tlsMaterial.cert, key: tlsMaterial.key, minVersion: "TLSv1.2" }, handleRequest)
    : createHttpServer(handleRequest);
}

async function startCompanionServer() {
  const certificatePath = process.env.COMPANION_TLS_CERT?.trim() || "";
  const privateKeyPath = process.env.COMPANION_TLS_KEY?.trim() || "";
  if (Boolean(certificatePath) !== Boolean(privateKeyPath)) {
    console.error("Companion TLS requires both COMPANION_TLS_CERT and COMPANION_TLS_KEY.");
    process.exitCode = 1;
    return;
  }
  let server;
  if (certificatePath) {
    try {
      const [cert, key] = await Promise.all([readFile(certificatePath), readFile(privateKeyPath)]);
      server = createCompanionServer({ cert, key });
    } catch {
      console.error("Companion TLS certificate could not be loaded. Check the configured certificate and private-key files.");
      process.exitCode = 1;
      return;
    }
  } else {
    server = createCompanionServer();
  }

  server.once("error", (error) => {
    const code = typeof error?.code === "string" && /^[A-Z0-9_]+$/.test(error.code) ? error.code : "UNKNOWN";
    const explanation = code === "EADDRINUSE" ? "the port is already in use"
      : code === "EACCES" || code === "EPERM" ? "permission was denied"
        : "the network listener could not be started";
    console.error(`Companion service could not listen on port ${port}: ${explanation} (${code}).`);
    process.exitCode = 1;
  });
  const protocol = certificatePath ? "https" : "http";
  if (lanEnabled && !certificatePath) console.warn("WARNING: Companion LAN mode uses plain HTTP. Pairing codes and scoped credentials are unencrypted in transit; use only on a trusted network.");
  if (lanEnabled && certificatePath) console.warn("Companion TLS is enabled. Self-signed certificates are accepted by the server; clients must trust the certificate before making requests.");
  server.listen(port, host, () => {
    const address = server.address();
    const listeningPort = address && typeof address === "object" ? address.port : port;
    console.log(`Companion service listening on ${protocol}://${host}:${listeningPort}`);
  });

  const mediaCleanup = setInterval(() => {
    for (const [id, job] of mediaJobs) if (job.finishedAt && Date.now() - job.finishedAt > 10 * 60 * 1000) {
      mediaJobs.delete(id);
      void job.cleanup().catch(() => undefined);
    }
  }, 60_000);
  mediaCleanup.unref();
  const metricsInterval = process.env.COMPANION_METRICS === "1" ? setInterval(() => {
    console.info(`[companion:metrics] ${JSON.stringify({ activeMediaJobs, counters: getRelayMetrics() })}`);
  }, 60_000) : null;
  metricsInterval?.unref();
  for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => {
    clearInterval(mediaCleanup);
    if (metricsInterval) clearInterval(metricsInterval);
    void Promise.allSettled([...mediaJobs.values()].map((job) => job.cleanup())).finally(() => {
      mediaJobs.clear();
      server.close(() => process.exit(0));
    });
  });

  setInterval(() => {
    for (const [deviceId, session] of sessions) if (Date.now() - session.createdAt > SESSION_TTL_MS) deleteSession(deviceId);
  }, 60_000).unref();
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  void startCompanionServer();
}
