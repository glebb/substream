import { createServer as createHttpServer } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { randomBytes, randomInt } from "node:crypto";
import { readFile, stat, mkdir, open, truncate, unlink, readdir, rm } from "node:fs/promises";
import { rmSync } from "node:fs";
import { createReadStream } from "node:fs";
import { extname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { randomBytes as randomToken } from "node:crypto";
import { prepareMedia } from "./media-compat.mjs";
import { prepareLocalTvMedia } from "./local-tv-media.mjs";
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
const localMediaSessions = new Map();
const localMediaParent = join(tmpdir(), "substream-local-media-v1");
const localMediaRoot = join(localMediaParent, `${process.pid}-${randomBytes(8).toString("hex")}`);
const LOCAL_MEDIA_CHUNK_BYTES = 4 * 1024 * 1024;
const LOCAL_MEDIA_MAX_BYTES = Number.isSafeInteger(Number(process.env.COMPANION_LOCAL_MEDIA_MAX_BYTES)) && Number(process.env.COMPANION_LOCAL_MEDIA_MAX_BYTES) > 0
  ? Number(process.env.COMPANION_LOCAL_MEDIA_MAX_BYTES) : 100 * 1024 * 1024 * 1024;
const LOCAL_MEDIA_MAX_SESSIONS = 2;
const LOCAL_MEDIA_LEASE_MS = 5 * 60 * 1000;
const LOCAL_MEDIA_ABANDONED_MS = 30 * 60 * 1000;
const LOCAL_MEDIA_IDLE_MS = 2 * 60 * 60 * 1000;
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

void (async () => {
  try {
    await mkdir(localMediaParent, { recursive: true, mode: 0o700 });
    const now = Date.now();
    for (const entry of await readdir(localMediaParent, { withFileTypes: true })) {
      if (!entry.isDirectory() || !/^\d+-[a-f0-9]{16}$/.test(entry.name)) continue;
      const candidate = join(localMediaParent, entry.name);
      try { if (now - (await stat(candidate)).mtimeMs > 24 * 60 * 60 * 1000) await rm(candidate, { recursive: true, force: true }); } catch { /* Ignore inaccessible stale runtime directories. */ }
    }
    await mkdir(localMediaRoot, { recursive: true, mode: 0o700 });
  } catch { /* A later session creation reports the sanitized storage error. */ }
})();
process.once("exit", () => { for (const media of localMediaSessions.values()) media.preparationController?.abort(); try { rmSync(localMediaRoot, { recursive: true, force: true }); } catch { /* The OS reclaims the private temporary directory later. */ } });

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

function allowedPackagedTvRequest(request, url) {
  const origin = request.headers?.origin;
  if (origin !== "file://" && origin !== "null") return false;
  const method = request.method === "OPTIONS" ? request.headers?.["access-control-request-method"] : request.method;
  if (method === "POST") {
    return ["/api/connect", "/api/pair/reset", "/api/pair/ack"].includes(url.pathname)
      || /^\/api\/local-media\/sessions\/[a-f0-9]{32}\/(lease|state)$/.test(url.pathname);
  }
  if (method === "GET" || method === "HEAD") {
    return url.pathname === "/api/pair/events"
      || /^\/api\/local-media\/[a-f0-9]{32}(?:\/subtitle)?$/.test(url.pathname);
  }
  return false;
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
  if (response.companionConnectDiagnostic) {
    const reasons = {
      "Companion protocol version is unsupported.": "protocol-mismatch",
      "Local media capability negotiation is required.": "missing-local-media-capability",
      "Companion connection could not be established.": "saved-pairing-rejected",
      "Request origin is not allowed.": "origin-rejected",
      "The relay has reached its TV connection limit.": "connection-limit",
      "TV device identity is invalid.": "invalid-device-identity",
      "Provider source fingerprint is invalid.": "invalid-source-identity",
      "Companion connection request was invalid.": "invalid-request",
    };
    console.info(`[companion-connect] ${JSON.stringify({
      ...response.companionConnectDiagnostic,
      status,
      result: status === 200 ? "connected" : (reasons[value?.error] || "rejected"),
      relayProtocol: COMPANION_PROTOCOL_VERSION,
    })}`);
  }
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

async function localMediaBody(request) {
  const maxBytes = 2 * 1024 * 1024;
  const declared = request.headers?.["content-length"];
  if (declared !== undefined && (!/^\d+$/.test(String(declared)) || Number(declared) > maxBytes)) throw new Error("Local media request rejected");
  const chunks = [];
  let byteLength = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    byteLength += bytes.byteLength;
    if (byteLength > maxBytes) throw new Error("Local media request rejected");
    chunks.push(bytes);
  }
  const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Local media request invalid");
  return parsed;
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
    capabilities: { localMedia: true },
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

const LOCAL_VIDEO_TYPES = Object.freeze({
  mp4: "video/mp4", m4v: "video/mp4", mov: "video/quicktime", webm: "video/webm",
  mkv: "video/x-matroska", avi: "video/x-msvideo", mpg: "video/mpeg", mpeg: "video/mpeg",
  ts: "video/mp2t", m2ts: "video/mp2t",
});

function localVideoType(name) {
  const extension = String(name).toLowerCase().match(/\.([a-z0-9]{1,8})$/)?.[1] || "";
  return LOCAL_VIDEO_TYPES[extension] || "application/octet-stream";
}

function localMediaPublicStatus(media) {
  const accepted = media.playbackState || "accepted";
  const expiresAt = media.state === "uploading"
    ? (media.lastActivityAt || media.createdAt) + LOCAL_MEDIA_ABANDONED_MS
    : ["preparing", "playing", "paused"].includes(accepted) && media.ticket
      ? media.ticket.expiresAt
      : (media.lastLeaseAt || media.createdAt) + (accepted === "ended" || accepted === "failed" || accepted === "stopped" ? 2 * 60 * 1000 : LOCAL_MEDIA_ABANDONED_MS);
  return { sessionId: media.id, state: media.state, playbackState: accepted, expectedSize: media.expectedSize, uploadOffset: media.uploadOffset, expiresAt };
}

async function deleteLocalMedia(media) {
  media.deletePending = true;
  media.ticket = null;
  media.preparationController?.abort();
  for (const reader of media.readerStreams || []) reader.destroy();
  if (media.activeReaders > 0 || media.uploadingChunk || media.preparationController) return false;
  localMediaSessions.delete(media.id);
  media.ticket = null;
  for (const path of new Set([media.path, media.playbackPath].filter(Boolean))) {
    try { await unlink(path); } catch { /* File may already be gone. */ }
  }
  return true;
}

function parseSingleByteRange(value, size) {
  if (typeof value !== "string" || !value.startsWith("bytes=") || value.includes(",")) return null;
  const match = value.slice(6).match(/^(\d*)-(\d*)$/);
  if (!match || (!match[1] && !match[2])) return null;
  if (!match[1]) {
    const suffix = Number(match[2]);
    if (!Number.isSafeInteger(suffix) || suffix <= 0 || size <= 0) return null;
    return { start: Math.max(0, size - suffix), end: size - 1 };
  }
  const start = Number(match[1]);
  const end = match[2] ? Number(match[2]) : size - 1;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || start >= size) return null;
  return { start, end: Math.min(size - 1, end) };
}

async function localMediaRoute(request, response, url) {
  const pathname = url.pathname;
  if (request.method === "POST" && pathname === "/api/local-media/sessions") {
    const browser = sessionForCredential(request, "browser");
    if (!browser || !browser.pairingRedeemed) return json(response, 401, { error: "Pair a TV before preparing local playback." });
    try {
      const input = await body(request);
      const expectedSize = Number(input.expectedSize);
      const name = typeof input.name === "string" ? input.name.replace(/[\u0000-\u001f\u007f]/g, "").split(/[\\/]/).pop().slice(0, 180) : "";
      if (!Number.isSafeInteger(expectedSize) || expectedSize < 1 || expectedSize > LOCAL_MEDIA_MAX_BYTES || !name) return json(response, 413, { error: "Selected media exceeds the companion service limit." });
      const active = [...localMediaSessions.values()].filter((item) => !item.deletePending);
      if (active.length >= LOCAL_MEDIA_MAX_SESSIONS || active.reduce((sum, item) => sum + (item.reservedBytes || item.expectedSize), 0) + expectedSize > LOCAL_MEDIA_MAX_BYTES) return json(response, 429, { error: "The companion service has no local media capacity available." });
      await mkdir(localMediaRoot, { recursive: true, mode: 0o700 });
      const id = randomBytes(16).toString("hex");
      const path = join(localMediaRoot, id + ".media");
      const file = await open(path, "wx", 0o600); await file.close();
      const createdAt = Date.now();
      const media = { id, path, name, mediaType: localVideoType(name), expectedSize, uploadOffset: 0, state: "uploading", playbackState: "accepted", deviceId: browser.deviceId, createdAt, lastActivityAt: createdAt, lastLeaseAt: createdAt, activeReaders: 0, readerStreams: new Set(), deletePending: false, ticket: null, uploadingChunk: false, subtitle: { version: 0, text: "", label: "", language: "", enabled: false, offsetSeconds: 0 } };
      localMediaSessions.set(id, media);
      return json(response, 201, { ...localMediaPublicStatus(media), chunkBytes: LOCAL_MEDIA_CHUNK_BYTES });
    } catch { return json(response, 400, { error: "Local media session could not be created." }); }
  }

  const subtitleUpdate = pathname.match(/^\/api\/local-media\/sessions\/([a-f0-9]{32})\/subtitle$/);
  if (subtitleUpdate && request.method === "PUT") {
    const media = localMediaSessions.get(subtitleUpdate[1]);
    const browser = sessionForCredential(request, "browser");
    if (!browser || !media || media.deviceId !== browser.deviceId || media.state !== "ready") return json(response, 404, { error: "Local media session expired." });
    try {
      const input = await localMediaBody(request);
      const text = typeof input.text === "string" ? input.text : "";
      const label = typeof input.label === "string" ? input.label.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 80) : "";
      const language = typeof input.language === "string" && /^[a-z]{2,3}$/i.test(input.language) ? input.language.toLowerCase() : "und";
      const offsetSeconds = Number(input.offsetSeconds);
      const enabled = input.enabled === true;
      if (text.length > 1_900_000 || (text && !/^(?:\uFEFF)?(?:WEBVTT(?:\s|$)|(?:\d+\s*\r?\n)?\d{1,2}:\d{2}(?::\d{2})?[,.]\d{3}\s*-->)/i.test(text.trimStart()))
        || !Number.isFinite(offsetSeconds) || Math.abs(offsetSeconds) > 30) return json(response, 400, { error: "Local subtitle data is invalid." });
      media.subtitle = { version: (media.subtitle?.version || 0) + 1, text, label, language, enabled: Boolean(text) && enabled, offsetSeconds };
      media.lastActivityAt = Date.now();
      return json(response, 200, { protocolVersion: COMPANION_PROTOCOL_VERSION, version: media.subtitle.version });
    } catch { return json(response, 400, { error: "Local subtitle data is invalid." }); }
  }
  const localSubtitle = pathname.match(/^\/api\/local-media\/([a-f0-9]{32})\/subtitle$/);
  if (localSubtitle && request.method === "GET") {
    const media = localMediaSessions.get(localSubtitle[1]);
    const ticket = url.searchParams.get("ticket") || "";
    const pairedTv = media ? sessions.get(media.deviceId) : null;
    if (!media || media.state !== "ready" || !media.ticket || ticket !== media.ticket.value || Date.now() >= media.ticket.expiresAt || media.ticket.deviceId !== media.deviceId || !pairedTv?.pairingRedeemed) return json(response, 404, { error: "Local playback ticket expired." });
    return json(response, 200, { protocolVersion: COMPANION_PROTOCOL_VERSION, ...media.subtitle });
  }

  const upload = pathname.match(/^\/api\/local-media\/sessions\/([a-f0-9]{32})\/(chunks|status|finalize|lease|state)$/);
  if (upload) {
    const [, id, operation] = upload;
    const media = localMediaSessions.get(id);
    if (operation === "lease" && request.method === "POST") {
      const tv = sessionForCredential(request, "tv");
      if (!tv || !media || !tv.pairingRedeemed || tv.deviceId !== media.deviceId || !media.ticket) return json(response, 404, { error: "Local playback session expired." });
      media.ticket.expiresAt = Date.now() + LOCAL_MEDIA_LEASE_MS;
      media.lastLeaseAt = Date.now();
      return json(response, 200, { protocolVersion: COMPANION_PROTOCOL_VERSION, expiresAt: media.ticket.expiresAt });
    }
    if (operation === "state" && request.method === "POST") {
      const tv = sessionForCredential(request, "tv");
      if (!tv || !media || !tv.pairingRedeemed || tv.deviceId !== media.deviceId || !media.ticket || media.ticket.deviceId !== tv.deviceId) return json(response, 404, { error: "Local playback session expired." });
      try {
        const input = await body(request);
        if (!supportsCompanionProtocolVersion(input.protocolVersion) || !["preparing", "playing", "paused", "ended", "failed", "stopped"].includes(input.state)) return json(response, 400, { error: "Local playback state was invalid." });
        media.playbackState = input.state;
        media.lastLeaseAt = Date.now();
        if (input.state === "stopped") void deleteLocalMedia(media);
        return json(response, 200, { protocolVersion: COMPANION_PROTOCOL_VERSION, state: media.playbackState });
      } catch { return json(response, 400, { error: "Local playback state was invalid." }); }
    }
    const browser = sessionForCredential(request, "browser");
    if (!browser || !media || media.deviceId !== browser.deviceId) return json(response, 404, { error: "Local media session expired." });
    if (operation === "status" && request.method === "GET") return json(response, 200, localMediaPublicStatus(media));
    if (operation === "chunks" && request.method === "PUT" && media.state === "uploading") {
      if (media.uploadingChunk || media.deletePending) return json(response, 409, { error: "Another upload or cleanup is in progress." });
      const offset = Number(url.searchParams.get("offset"));
      if (!Number.isSafeInteger(offset) || offset !== media.uploadOffset) return json(response, 409, { error: "Upload offset changed.", uploadOffset: media.uploadOffset });
      const declared = Number(request.headers?.["content-length"]);
      if (!Number.isSafeInteger(declared) || declared < 1 || declared > LOCAL_MEDIA_CHUNK_BYTES || offset + declared > media.expectedSize) return json(response, 413, { error: "Upload chunk is outside the allowed size." });
      let received = 0;
      let handle;
      let chunkStatus = 200;
      let chunkResult;
      media.uploadingChunk = true;
      try {
        handle = await open(media.path, offset === 0 ? "w" : "r+");
        for await (const value of request) {
          const bytes = Buffer.isBuffer(value) ? value : Buffer.from(String(value));
          if (received + bytes.byteLength > declared) throw new Error("Chunk exceeded declared length.");
          let written = 0;
          while (written < bytes.byteLength) {
            const result = await handle.write(bytes, written, bytes.byteLength - written, offset + received + written);
            written += result.bytesWritten;
          }
          received += bytes.byteLength;
        }
        if (received !== declared) throw new Error("Chunk ended early.");
        media.uploadOffset += received;
        media.lastActivityAt = Date.now();
        media.lastLeaseAt = media.lastActivityAt;
        chunkResult = { uploadOffset: media.uploadOffset };
      } catch {
        try { await truncate(media.path, offset); } catch { /* Retry will report its safe current offset. */ }
        chunkStatus = 400;
        chunkResult = { error: "Upload chunk was incomplete. Retry from the reported offset." };
      } finally {
        await handle?.close().catch(() => {});
        media.uploadingChunk = false;
        if (media.deletePending) void deleteLocalMedia(media);
      }
      // Release the upload lock before replying: the next chunk/finalize
      // request may arrive as soon as the browser sees the response.
      return json(response, chunkStatus, chunkResult);
    }
    if (operation === "finalize" && request.method === "POST") {
      if (media.uploadingChunk || media.preparationController || media.deletePending) return json(response, 409, { error: "Upload or cleanup is in progress." });
      if (media.uploadOffset !== media.expectedSize) return json(response, 409, { error: "Local media upload is incomplete.", uploadOffset: media.uploadOffset });
      try {
        const info = await stat(media.path);
        if (!info.isFile() || info.size !== media.expectedSize) return json(response, 409, { error: "Uploaded media size could not be verified." });
        const input = await body(request);
        if (input.tvCompatibility === true && !media.playbackPath) {
          const otherBytes = [...localMediaSessions.values()].filter((item) => item !== media).reduce((sum, item) => sum + (item.reservedBytes || item.expectedSize), 0);
          const availableBytes = LOCAL_MEDIA_MAX_BYTES - otherBytes - media.expectedSize;
          if (availableBytes < 1) return json(response, 413, { error: "No space is available for a TV-compatible copy." });
          media.reservedBytes = media.expectedSize + availableBytes;
          media.preparationController = new AbortController();
          const onClose = () => { if (!response.writableFinished) media.preparationController?.abort(); };
          response.once?.("close", onClose);
          try {
            const prepared = await prepareLocalTvMedia(media.path, media.path + ".mp4", { maxBytes: availableBytes, signal: media.preparationController.signal });
            media.playbackPath = prepared.path;
            media.playbackSize = prepared.size;
            media.mediaType = prepared.mediaType;
            media.reservedBytes = media.expectedSize + (prepared.path === media.path ? 0 : prepared.size);
          } finally {
            response.removeListener?.("close", onClose);
            media.preparationController = null;
            if (media.deletePending) void deleteLocalMedia(media);
          }
          if (media.deletePending) return json(response, 409, { error: "Local TV preparation was cancelled." });
        }
        media.state = "ready";
        media.lastLeaseAt = Date.now();
        media.lastActivityAt = media.lastLeaseAt;
        return json(response, 200, localMediaPublicStatus(media));
      } catch { await deleteLocalMedia(media); return json(response, 400, { error: "TV preparation failed. Install ffmpeg and ffprobe on the computer and check the video file." }); }
    }
    if (operation === "lease") return json(response, 405, { error: "Method not allowed." });
    if (request.method === "DELETE" && (operation === "status" || operation === "chunks" || operation === "finalize")) {
      media.ticket = null;
      if (media.uploadingChunk) { media.deletePending = true; return json(response, 202, { stopped: true, pendingUpload: true }); }
      const removed = await deleteLocalMedia(media);
      return json(response, removed ? 200 : 202, { stopped: true, pendingReaders: !removed });
    }
    return json(response, 405, { error: "Method not allowed." });
  }

  const playback = pathname.match(/^\/api\/local-media\/([a-f0-9]{32})$/);
  if (!playback || (request.method !== "GET" && request.method !== "HEAD")) return false;
  const media = localMediaSessions.get(playback[1]);
  const ticket = url.searchParams.get("ticket") || "";
  const pairedTv = media ? sessions.get(media.deviceId) : null;
  if (!media || media.state !== "ready" || !media.ticket || ticket !== media.ticket.value || Date.now() >= media.ticket.expiresAt || media.ticket.deviceId !== media.deviceId || !pairedTv?.pairingRedeemed) return json(response, 404, { error: "Local playback ticket expired." });
  const size = media.playbackSize || media.expectedSize;
  let range = null;
  if (request.method === "GET" && request.headers?.range !== undefined) {
    range = parseSingleByteRange(request.headers.range, size);
    if (!range) {
      response.writeHead(416, { "content-range": `bytes */${size}`, "content-length": 0, "cache-control": "no-store", "access-control-allow-origin": "*" });
      response.end(); return true;
    }
  }
  const start = range?.start ?? 0;
  const end = range?.end ?? size - 1;
  const headers = { "content-type": media.mediaType, "content-length": String(end - start + 1), "accept-ranges": "bytes", "cache-control": "no-store", "access-control-allow-origin": "*", ...(range ? { "content-range": `bytes ${start}-${end}/${size}` } : {}) };
  response.writeHead(range ? 206 : 200, headers);
  if (request.method === "HEAD") { response.end(); return true; }
  media.activeReaders += 1;
  media.lastLeaseAt = Date.now();
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    media.activeReaders = Math.max(0, media.activeReaders - 1);
    media.readerStreams?.delete(stream);
    if (media.deletePending && media.activeReaders === 0) void deleteLocalMedia(media);
  };
  const stream = createReadStream(media.playbackPath || media.path, { start, end, highWaterMark: 1024 * 1024 });
  media.readerStreams.add(stream);
  stream.once("error", () => {
    release();
    if (!response.destroyed) {
      if (!response.headersSent) json(response, 404, { error: "Local media is unavailable." });
      else response.destroy();
    }
  });
  request.once?.("aborted", () => stream.destroy());
  response.once?.("close", () => { stream.destroy(); release(); });
  stream.once("close", release);
  stream.pipe(response);
  return true;
}

export async function route(request, response, url) {
  // Log only fixed outcomes and primitive negotiation flags, never request data,
  // origins, device identities, pairing codes, credentials, or provider details.
  if (request.method === "POST" && url.pathname === "/api/connect") {
    response.companionConnectDiagnostic = {};
  }
  const origin = request.headers?.origin;
  // Packaged TVs use file/opaque origins. Limit their CORS exception to TV
  // routes; all session and playback credential checks still apply below.
  const originAllowed = allowedOrigin(origin) || allowedPackagedTvRequest(request, url);
  if (originAllowed) response.corsOrigin = origin;
  if (request.method === "OPTIONS") {
    if (!originAllowed) return json(response, 403, { error: "Request origin is not allowed." });
    response.writeHead(204, { "access-control-allow-origin": origin, "access-control-allow-methods": "GET,HEAD,POST,PUT,DELETE,OPTIONS", "access-control-allow-headers": "content-type, authorization", vary: "Origin" });
    response.end();
    return;
  }
  if (["POST", "PUT", "PATCH", "DELETE"].includes(request.method) && origin && !originAllowed) return json(response, 403, { error: "Request origin is not allowed." });
  if (url.pathname.startsWith("/api/local-media/")) { const handled = await localMediaRoute(request, response, url); if (handled !== false) return; }
  if (url.pathname.startsWith("/api/media/")) { const handled = await mediaRoute(request, response, url); if (handled !== false) return; }
  if (request.method === "GET" && url.pathname === "/api/nordic-epg") return nordicEpg(response);
  if (request.method === "POST" && url.pathname === "/api/connect") {
    try {
      const input = await body(request);
      response.companionConnectDiagnostic = {
        tvProtocol: Number.isSafeInteger(input?.protocolVersion) && input.protocolVersion >= 0 && input.protocolVersion <= 100 ? input.protocolVersion : null,
        localMedia: input?.capabilities?.localMedia === true,
        hasSavedCredential: Boolean(request.headers?.authorization),
      };
      if (!supportsCompanionProtocolVersion(input.protocolVersion)) return json(response, 400, { error: "Companion protocol version is unsupported." });
      const sourceFingerprint = String(input.sourceFingerprint || "");
      if (input.capabilities?.localMedia !== true) return json(response, 400, { error: "Local media capability negotiation is required." });
      const deviceId = String(input.deviceId || "").toLowerCase();
      const deviceName = String(input.deviceName || "").replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 40);
      if (sourceFingerprint && !/^vod_[a-z0-9]{1,8}$/.test(sourceFingerprint)) return json(response, 400, { error: "Provider source fingerprint is invalid." });
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
        session.capabilities = { localMedia: true };
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
          tvCredential: randomBytes(32).toString("hex"), browserCredential: "", capabilities: { localMedia: true },
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
  if (request.method === "POST" && url.pathname === "/api/pair/play-local") {
    try {
      const input = await body(request);
      const browser = sessionForCredential(request, "browser");
      const media = localMediaSessions.get(String(input.sessionId || ""));
      if (!supportsCompanionProtocolVersion(input.protocolVersion)) return json(response, 400, { error: "Local playback protocol version is unsupported." });
      if (!browser || !browser.pairingRedeemed || !media || media.state !== "ready" || media.deviceId !== browser.deviceId) return json(response, 400, { error: "Local media session is unavailable or TV pairing expired." });
      const metadata = input.metadata && typeof input.metadata === "object" ? input.metadata : {};
      const title = typeof metadata.title === "string" ? metadata.title.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 240) : "";
      const searchTitle = typeof metadata.searchTitle === "string" ? metadata.searchTitle.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 240) : "";
      if (!title) return json(response, 400, { error: "Local playback metadata is invalid." });
      const ticket = randomBytes(32).toString("hex");
      media.ticket = { value: ticket, deviceId: browser.deviceId, expiresAt: Date.now() + LOCAL_MEDIA_LEASE_MS };
      media.lastLeaseAt = Date.now();
      const event = { sequence: browser.nextEvent++, action: "play-local", localMedia: {
        sessionId: media.id, ticket, title, searchTitle, year: Number.isSafeInteger(metadata.year) ? metadata.year : null,
        season: Number.isSafeInteger(metadata.season) ? metadata.season : null, episode: Number.isSafeInteger(metadata.episode) ? metadata.episode : null,
        contentType: ["movie", "series", "unknown"].includes(metadata.contentType) ? metadata.contentType : "unknown",
        mediaType: media.mediaType, size: media.playbackSize || media.expectedSize,
      } };
      browser.events.push(event);
      if (browser.events.length > MAX_QUEUED_EVENTS) {
        const removed = browser.events.splice(0, browser.events.length - MAX_QUEUED_EVENTS);
        browser.droppedThroughSequence = Math.max(browser.droppedThroughSequence, removed.at(-1).sequence);
      }
      wakeEventWaiters(browser);
      return json(response, 200, { protocolVersion: COMPANION_PROTOCOL_VERSION, accepted: true });
    } catch { return json(response, 400, { error: "Local playback command was invalid." }); }
  }
  if (request.method === "POST" && url.pathname === "/api/pair/stop-local") {
    try {
      const input = await body(request);
      const browser = sessionForCredential(request, "browser");
      const media = localMediaSessions.get(String(input.sessionId || ""));
      if (!supportsCompanionProtocolVersion(input.protocolVersion)) return json(response, 400, { error: "Local playback protocol version is unsupported." });
      if (!browser || !browser.pairingRedeemed || !media || media.deviceId !== browser.deviceId || !media.ticket) return json(response, 404, { error: "Local media session is unavailable." });
      browser.events.push({ sequence: browser.nextEvent++, action: "stop-local", sessionId: media.id });
      if (browser.events.length > MAX_QUEUED_EVENTS) {
        const removed = browser.events.splice(0, browser.events.length - MAX_QUEUED_EVENTS);
        browser.droppedThroughSequence = Math.max(browser.droppedThroughSequence, removed.at(-1).sequence);
      }
      wakeEventWaiters(browser);
      return json(response, 200, { protocolVersion: COMPANION_PROTOCOL_VERSION, accepted: true });
    } catch { return json(response, 400, { error: "Local stop command was invalid." }); }
  }
  if (request.method === "GET" && url.pathname === "/api/pair/events") {
    const session = sessionForCredential(request, "tv");
    if (!session) return json(response, 404, { error: "Companion connection expired." });
    session.createdAt = Date.now();
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
    for (const media of localMediaSessions.values()) {
      const now = Date.now();
      const abandonedUpload = media.state === "uploading" && !media.preparationController && now - (media.lastActivityAt || media.createdAt) > LOCAL_MEDIA_ABANDONED_MS;
      const expiredTicket = media.state === "ready" && media.ticket && now >= media.ticket.expiresAt;
      const idleReady = media.state === "ready" && !["playing", "paused", "preparing"].includes(media.playbackState) && now - (media.lastLeaseAt || media.createdAt) > LOCAL_MEDIA_IDLE_MS;
      const endedGrace = media.state === "ready" && ["ended", "failed", "stopped"].includes(media.playbackState) && now - (media.lastLeaseAt || media.createdAt) > 2 * 60 * 1000;
      if ((abandonedUpload || expiredTicket || idleReady || endedGrace) && !media.deletePending) void deleteLocalMedia(media);
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
    for (const media of localMediaSessions.values()) void deleteLocalMedia(media);
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
