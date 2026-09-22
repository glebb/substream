import { createServer } from "node:http";
import { randomBytes, randomInt } from "node:crypto";
import { readFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { fetchXtreamAction, loadXtreamCatalogue, searchCatalogue, xtreamConnectionFromPlaylist } from "./companion-service.mjs";

const port = Number(process.env.COMPANION_PORT || 8787);
const host = process.env.COMPANION_HOST || "0.0.0.0";
const publicDir = join(fileURLToPath(new URL("../public/", import.meta.url)));
const sessions = new Map();
const SESSION_TTL_MS = 30 * 60 * 1000;

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
    return null;
  }
  return session;
}

function publicSession(session) {
  return { sessionId: session.id, code: session.code, expiresAt: session.createdAt + SESSION_TTL_MS };
}

function randomCode() {
  let code = "";
  do code = String(randomInt(100000, 1000000)); while ([...sessions.values()].some((session) => session.code === code));
  return code;
}

function validateSelection(value) {
  if (!value || !/^(movie|series)$/.test(value.kind) || !/^\d{1,20}$/.test(String(value.id ?? ""))) return null;
  const title = typeof value.title === "string" ? value.title.trim().slice(0, 240) : "";
  if (!title) return null;
  return {
    kind: value.kind,
    id: String(value.id),
    title,
    year: Number.isSafeInteger(value.year) ? value.year : null,
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

async function route(request, response, url) {
  if (request.method === "OPTIONS") { response.writeHead(204, { "access-control-allow-origin": "*", "access-control-allow-methods": "GET,POST,OPTIONS", "access-control-allow-headers": "content-type" }); response.end(); return; }
  if (request.method === "POST" && url.pathname === "/api/pair/create") {
    try {
      const input = await body(request);
      const connection = xtreamConnectionFromPlaylist(String(input.playlistUrl || ""));
      if (!connection) return json(response, 400, { error: "Only Xtream provider URLs can be paired during development." });
      const session = { id: randomBytes(18).toString("hex"), code: randomCode(), createdAt: Date.now(), connection, records: null, events: [], nextEvent: 1 };
      sessions.set(session.id, session);
      return json(response, 200, publicSession(session));
    } catch { return json(response, 400, { error: "Pairing request was invalid." }); }
  }
  if (request.method === "POST" && url.pathname === "/api/pair/join") {
    try {
      const input = await body(request);
      const session = [...sessions.values()].find((candidate) => candidate.code === String(input.code || "").trim());
      return session ? json(response, 200, { sessionId: session.id, expiresAt: session.createdAt + SESSION_TTL_MS }) : json(response, 404, { error: "Pairing code expired or not found." });
    } catch { return json(response, 400, { error: "Pairing request was invalid." }); }
  }
  if (request.method === "GET" && url.pathname === "/api/search") {
    const session = sessionFor(url.searchParams.get("sessionId"));
    const query = url.searchParams.get("q") || "";
    if (!session) return json(response, 404, { error: "Pairing session expired." });
    if (query.trim().length < 2) return json(response, 200, { results: [] });
    try {
      return json(response, 200, { results: searchCatalogue(await catalogueFor(session), query) });
    } catch { return json(response, 502, { error: "Provider catalogue is unavailable." }); }
  }
  if (request.method === "GET" && url.pathname === "/api/catalogue") {
    const session = sessionFor(url.searchParams.get("sessionId"));
    if (!session) return json(response, 404, { error: "Pairing session expired." });
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
      if (!session || !selection || selection.sourceFingerprint !== session.connection.sourceFingerprint) return json(response, 400, { error: "Selection is invalid or pairing expired." });
      const event = { sequence: session.nextEvent++, selection };
      session.events.push(event);
      session.events = session.events.slice(-20);
      return json(response, 200, { accepted: true });
    } catch { return json(response, 400, { error: "Selection request was invalid." }); }
  }
  if (request.method === "GET" && url.pathname === "/api/pair/events") {
    const session = sessionFor(url.searchParams.get("sessionId"));
    if (!session) return json(response, 404, { error: "Pairing session expired." });
    const after = Number(url.searchParams.get("after") || 0);
    return json(response, 200, { events: session.events.filter((event) => event.sequence > after) });
  }
  return serveStatic(url.pathname, response);
}

async function serveStatic(pathname, response) {
  const relative = pathname === "/" ? "companion.html" : pathname.replace(/^\/+/, "");
  if (relative.includes("..")) return json(response, 404, { error: "Not found" });
  try {
    const file = await readFile(join(publicDir, relative));
    const extension = extname(relative);
    const contentType = extension === ".html" ? "text/html; charset=utf-8" : extension === ".js" ? "text/javascript; charset=utf-8" : "application/octet-stream";
    response.writeHead(200, { "content-type": contentType, "cache-control": "no-store" });
    response.end(file);
  } catch { json(response, 404, { error: "Not found" }); }
}

const server = createServer((request, response) => {
  const url = new URL(request.url || "/", `http://${request.headers.host || "localhost"}`);
  void route(request, response, url);
});
server.listen(port, host, () => console.log(`Companion service listening on http://localhost:${port}`));

setInterval(() => {
  for (const [id, session] of sessions) if (Date.now() - session.createdAt > SESSION_TTL_MS) sessions.delete(id);
}, 60_000).unref();
