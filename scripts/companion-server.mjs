import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { fetchXtreamAction, loadXtreamCatalogue, resolveXtreamEpisode, searchCatalogue, xtreamConnectionFromPlaylist } from "./companion-service.mjs";
import { readFile as readMediaFile } from "node:fs/promises";
import { randomBytes as randomToken } from "node:crypto";
import { prepareMedia } from "./media-compat.mjs";

const port = Number(process.env.COMPANION_PORT || 8787);
const host = process.env.COMPANION_HOST || "0.0.0.0";
const projectDir = fileURLToPath(new URL("../", import.meta.url));
const publicDir = join(projectDir, "public");
const distDir = join(projectDir, "dist");
const sessions = new Map();
let activeSessionId = "";
const SESSION_TTL_MS = 30 * 60 * 1000;
const mediaJobs = new Map();

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
    try {
      const input = await body(request);
      if (typeof input.streamUrl !== "string" || input.streamUrl.length > 8192) return json(response, 400, { error: "Media compatibility request was invalid." });
      const job = await prepareMedia(input.streamUrl, { supportsEac3: input.supportsEac3 === true, supportsAc3: input.supportsAc3 === true, supportsH264: input.supportsH264 === true, startSeconds: input.startSeconds });
      if (job.direct) return json(response, 200, { direct: true, audioConverted: false });
      const id = randomToken(18).toString("hex");
      const record = { ...job, id, createdAt: Date.now(), lastPlaylist: await readPlaylistWithRetry(job.playlist) };
      mediaJobs.set(id, record);
      record.process.once("close", () => { record.finishedAt = Date.now(); });
      const durationSeconds = Number.isFinite(job.plan.duration) && job.plan.duration > 0 ? job.plan.duration : null;
      return json(response, 200, { url: `/api/media/${id}/index.m3u8`, audioConverted: job.plan.convertAudio, durationSeconds, startSeconds: job.startSeconds || 0 });
    } catch {
      return json(response, 422, { error: "Media could not be prepared for browser playback." });
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
  try {
    const data = isPlaylist ? await readPlaylistWithRetry(filename) : await readMediaFile(filename);
    if (!data) throw new Error("Playlist is being updated.");
    if (isPlaylist) job.lastPlaylist = data;
    response.writeHead(200, { "content-type": isPlaylist ? "application/vnd.apple.mpegurl" : "video/mp2t", "content-length": data.byteLength, "cache-control": "no-store", ...(request.headers.origin ? { "access-control-allow-origin": request.headers.origin } : {}) });
    mediaDebug("served", { kind: routeKind, status: 200, bytes: data.byteLength });
    response.end(data);
  } catch {
    // FFmpeg atomically replaces EVENT playlists via temp_file. A concurrent
    // hls.js level reload can briefly see ENOENT during rename; return the last
    // complete manifest instead of a fatal 503 that stops playback.
    if (isPlaylist && job.lastPlaylist) {
      mediaDebug("served_cached", { kind: "playlist", status: 200, bytes: job.lastPlaylist.byteLength });
      response.writeHead(200, { "content-type": "application/vnd.apple.mpegurl", "content-length": job.lastPlaylist.byteLength, "cache-control": "no-store", ...(request.headers.origin ? { "access-control-allow-origin": request.headers.origin } : {}) });
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
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "access-control-allow-origin": "*" });
  response.end(body);
}

async function body(request) {
  let text = "";
  for await (const chunk of request) text += chunk;
  if (text.length > 128 * 1024) throw new Error("Request too large");
  return JSON.parse(text || "{}");
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
  return { sessionId: session.id, expiresAt: session.createdAt + SESSION_TTL_MS, sourceFingerprint: session.connection.sourceFingerprint };
}

function validateSelection(value) {
  if (!value || !/^(movie|series|episode)$/.test(value.kind) || !/^\d{1,20}$/.test(String(value.id ?? ""))) return null;
  const title = typeof value.title === "string" ? value.title.trim().slice(0, 240) : "";
  if (!title) return null;
  return {
    kind: value.kind,
    id: String(value.id),
    ...(value.kind === "episode" && /^\d{1,20}$/.test(String(value.seriesId ?? "")) ? { seriesId: String(value.seriesId) } : {}),
    title,
    year: Number.isSafeInteger(value.year) ? value.year : null,
    season: Number.isSafeInteger(value.season) && value.season > 0 ? value.season : null,
    episode: Number.isSafeInteger(value.episode) && value.episode > 0 ? value.episode : null,
    extension: /^[a-z0-9]{1,10}$/i.test(String(value.extension ?? "")) ? String(value.extension).toLowerCase() : "mp4",
    sourceFingerprint: typeof value.sourceFingerprint === "string" ? value.sourceFingerprint : "",
  };
}

async function catalogueFor(session, refresh = false) {
  if (refresh || !session.records) session.records = await loadXtreamCatalogue(session.connection);
  return session.records;
}

/** The browser cache must never receive provider credentials or stream URLs. */
function publicCatalogue(records) {
  return records.map(({ id, kind, title, year, extension, category, sourceFingerprint }) => ({ id, kind, title, year, extension, category, sourceFingerprint }));
}

export async function route(request, response, url) {
  if (request.method === "OPTIONS") { response.writeHead(204, { "access-control-allow-origin": request.headers?.origin || "null", "access-control-allow-methods": "GET,POST,OPTIONS", "access-control-allow-headers": "content-type" }); response.end(); return; }
  if (url.pathname.startsWith("/api/media/")) { const handled = await mediaRoute(request, response, url); if (handled !== false) return; }
  if (request.method === "POST" && url.pathname === "/api/connect") {
    try {
      const input = await body(request);
      const connection = xtreamConnectionFromPlaylist(String(input.playlistUrl || ""));
      if (!connection) return json(response, 400, { error: "Only Xtream provider URLs can be paired during development." });
      const session = { id: randomBytes(18).toString("hex"), createdAt: Date.now(), connection, records: null, events: [], nextEvent: 1 };
      sessions.clear();
      sessions.set(session.id, session);
      activeSessionId = session.id;
      return json(response, 200, publicSession(session));
    } catch { return json(response, 400, { error: "Companion connection request was invalid." }); }
  }
  if (request.method === "GET" && url.pathname === "/api/active") {
    const session = sessionFor(activeSessionId);
    return session ? json(response, 200, publicSession(session)) : json(response, 404, { error: "No TV is connected. Open Substream on the TV, then connect from Settings if needed." });
  }
  if (request.method === "GET" && url.pathname === "/api/search") {
    const session = sessionFor(url.searchParams.get("sessionId"));
    const query = url.searchParams.get("q") || "";
    if (!session) return json(response, 404, { error: "Companion connection expired." });
    if (query.trim().length < 2) return json(response, 200, { results: [] });
    try {
      return json(response, 200, { results: searchCatalogue(await catalogueFor(session), query) });
    } catch { return json(response, 502, { error: "Provider catalogue is unavailable." }); }
  }
  if (request.method === "GET" && url.pathname === "/api/catalogue") {
    const session = sessionFor(url.searchParams.get("sessionId"));
    if (!session) return json(response, 404, { error: "Companion connection expired." });
    try {
      const refresh = url.searchParams.get("refresh") === "1";
      return json(response, 200, { records: publicCatalogue(await catalogueFor(session, refresh)), refreshedAt: Date.now() });
    } catch { return json(response, 502, { error: "Provider catalogue is unavailable." }); }
  }
  if (request.method === "POST" && url.pathname === "/api/pair/select") {
    try {
      const input = await body(request);
      const session = sessionFor(String(input.sessionId || ""));
      const selection = validateSelection(input.selection);
      if (!session || !selection || selection.sourceFingerprint !== session.connection.sourceFingerprint) return json(response, 400, { error: "Selection is invalid or companion connection expired." });
      const event = { sequence: session.nextEvent++, selection };
      session.events.push(event);
      session.events = session.events.slice(-20);
      return json(response, 200, { accepted: true });
    } catch { return json(response, 400, { error: "Selection request was invalid." }); }
  }
  if (request.method === "POST" && url.pathname === "/api/pair/play") {
    try {
      const input = await body(request);
      const session = sessionFor(String(input.sessionId || ""));
      const selection = validateSelection(input.selection);
      if (!session || !selection || selection.sourceFingerprint !== session.connection.sourceFingerprint
        || !/^(movie|episode)$/.test(selection.kind)
        || (selection.kind === "episode" && !selection.seriesId)) return json(response, 400, { error: "Playback command is invalid or the TV connection expired." });
      if (selection.kind === "episode") {
        const resolved = await resolveXtreamEpisode(session.connection, selection.seriesId, selection.id);
        if (!resolved || resolved.sourceFingerprint !== selection.sourceFingerprint) return json(response, 400, { error: "Episode does not match the selected provider series." });
        selection.title = resolved.title;
        selection.extension = resolved.extension;
      }
      const event = { sequence: session.nextEvent++, action: "play", selection };
      session.events.push(event);
      session.events = session.events.slice(-20);
      return json(response, 200, { accepted: true });
    } catch { return json(response, 400, { error: "Playback command was invalid." }); }
  }
  if (request.method === "GET" && url.pathname === "/api/pair/events") {
    const session = sessionFor(url.searchParams.get("sessionId"));
    if (!session) return json(response, 404, { error: "Companion connection expired." });
    const after = Number(url.searchParams.get("after") || 0);
    return json(response, 200, { events: session.events.filter((event) => event.sequence > after) });
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
  server.listen(port, host, () => {
    const address = server.address();
    const listeningPort = address && typeof address === "object" ? address.port : port;
    console.log(`Companion service listening on http://127.0.0.1:${listeningPort}`);
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
