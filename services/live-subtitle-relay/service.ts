import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { chmod, lstat, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { RelayConfig } from './config.ts';
import { FfmpegRelayWorkerFactory, type RelayWorker, type RelayWorkerFactory, type RelayFailureReason } from './ingest.ts';

interface Session {
  id: string;
  capability: string;
  channelId: string;
  worker: RelayWorker;
  directory: string;
  expiresAt: number;
  timer?: NodeJS.Timeout;
  prepareTimer?: NodeJS.Timeout;
  startupTimer?: NodeJS.Timeout;
  startupDeadlineAt: number;
  playbackStarted: boolean;
  preparationFailed?: boolean;
  deleting?: Promise<void>;
}

export interface RelayServerOptions {
  workerFactory?: RelayWorkerFactory;
  /** Receives fixed, credential-free relay lifecycle diagnostics. Callback errors are ignored. */
  onDiagnostic?: (event: RelayDiagnosticEvent) => void;
  now?: () => number;
  randomToken?: () => string;
  cleanupStaleSessions?: boolean;
  /** Override the bounded startup pin for deterministic tests. */
  startupAckTimeoutMs?: number;
}
export type RelayDiagnosticName = 'options-accepted' | 'options-rejected' | 'session-auth-failed' | 'invalid-channel' | 'session-created' | 'preparer-state' | 'media-playlist-requested' | 'playback-acknowledged' | 'session-deleted';
export type RelayDiagnosticState = 'preparing' | 'ready' | 'failed' | 'stopped';
export interface RelayDiagnosticEvent {
  event: RelayDiagnosticName;
  status?: number;
  state?: RelayDiagnosticState;
  originKind?: 'absent' | 'http' | 'opaque';
  reason?: RelayFailureReason;
  inputIdleMs?: number;
}
export interface RelayHttpServer extends Server {
  shutdown(): Promise<void>;
  /** Direct request entrypoint, useful for embedding and deterministic tests. */
  dispatch(request: IncomingMessage, response: ServerResponse): Promise<void>;
}

const JSON_TYPE = 'application/json; charset=utf-8';
const SESSION_ID = /^[a-f0-9]{32,64}$/;
const IMAGE_ID = /^[a-zA-Z0-9_-]{1,96}$/;
const SEGMENT = /^segment-\d{8}\.ts$/;
const STARTUP_ACK_TIMEOUT_MS = 60_000;

/** Create the HTTP server. This function does not bind a port or print request data. */
export async function createRelayServer(config: RelayConfig, options: RelayServerOptions = {}): Promise<RelayHttpServer> {
  const sessions = new Map<string, Session>();
  const workerFactory = options.workerFactory ?? new FfmpegRelayWorkerFactory({ allowedRedirectHosts: config.allowedRedirectHosts });
  const now = options.now ?? Date.now;
  const tokenFactory = options.randomToken ?? (() => randomBytes(32).toString('hex'));
  const startupAckTimeoutMs = Math.min(options.startupAckTimeoutMs ?? STARTUP_ACK_TIMEOUT_MS, STARTUP_ACK_TIMEOUT_MS);
  const diagnostic = (event: RelayDiagnosticEvent): void => { try { options.onDiagnostic?.(event); } catch { /* diagnostics must not affect serving */ } };
  let creatingSessions = 0;
  let closing = false;
  const pendingCreations = new Set<Promise<void>>();
  const rateWindows = new Map<string, { startedAt: number; count: number }>();
  let closeCleanup = Promise.resolve();
  let shutdownTask: Promise<void> | undefined;
  await mkdir(config.sessionRoot, { recursive: true, mode: 0o700 });
  try {
    if ((await lstat(config.sessionRoot)).isSymbolicLink()) throw new Error();
    await chmod(config.sessionRoot, 0o700);
  } catch { throw new Error('storage_unavailable'); }
  if (options.cleanupStaleSessions !== false) {
    try {
      const { readdir } = await import('node:fs/promises');
      const entries = await readdir(config.sessionRoot, { withFileTypes: true });
      const stale = entries.filter((entry) => entry.isDirectory() && /^[a-f0-9]{32}$/.test(entry.name));
      await Promise.all(stale.map(async (entry) => {
        const path = join(config.sessionRoot, entry.name);
        const info = await lstat(path);
        if (info.isDirectory() && !info.isSymbolicLink()) await rm(path, { recursive: true, force: true });
      }));
    } catch { throw new Error('storage_unavailable'); }
  }

  const server = createServer((request, response) => {
    void handle(request, response).catch(() => sendError(response, 500, 'internal_error'));
  }) as RelayHttpServer;
  server.headersTimeout = 10_000;
  server.requestTimeout = 30_000;
  server.maxHeadersCount = 64;

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const origin = req.headers.origin;
    const originKind = origin === undefined ? 'absent' : origin === 'null' ? 'opaque' : 'http';
    if (origin && config.allowedOrigins.includes(origin)) {
      res.setHeader('access-control-allow-origin', origin);
      res.setHeader('vary', 'Origin');
      res.setHeader('access-control-allow-headers', 'authorization,content-type');
      res.setHeader('access-control-allow-methods', 'GET,POST,PUT,DELETE,OPTIONS');
    }
    if (req.method === 'OPTIONS') {
      const accepted = !!origin && config.allowedOrigins.includes(origin);
      const status = accepted ? 204 : 403;
      diagnostic({ event: accepted ? 'options-accepted' : 'options-rejected', status, originKind });
      res.writeHead(status).end(); return;
    }
    const url = safeRequestUrl(req.url);
    if (!url) { sendError(res, 400, 'invalid_request'); return; }
    if (req.method === 'GET' && url.pathname === '/healthz') {
      sendJson(res, 200, { status: 'ok' }); return;
    }
    if (closing) { sendError(res, 503, 'service_stopping'); return; }
    if (!rateLimit(req, now, rateWindows, config.maxSessions)) { sendError(res, 429, 'rate_limited'); return; }

    const authOk = bearerMatches(req.headers.authorization, config.apiToken);
    if (url.pathname === '/v1/sessions' && req.method === 'POST') {
      if (!authOk) { diagnostic({ event: 'session-auth-failed', status: 401, originKind }); sendError(res, 401, 'unauthorized'); return; }
      const body = await readBody(req, config.maxBodyBytes);
      if (body === undefined) { sendError(res, 413, 'body_too_large'); return; }
      let input: unknown;
      try { input = JSON.parse(body); } catch { sendError(res, 400, 'invalid_request'); return; }
      if (!input || typeof input !== 'object' || Array.isArray(input)) { sendError(res, 400, 'invalid_request'); return; }
      const fields = input as Record<string, unknown>;
      const channelId = fields.channelId;
      const preferredLanguage = fields.preferredLanguage;
      if (typeof channelId !== 'string' || !Object.hasOwn(config.channels, channelId) ||
          (preferredLanguage !== undefined && preferredLanguage !== 'fi' && preferredLanguage !== 'en')) {
        diagnostic({ event: 'invalid-channel', status: 400, originKind });
        sendError(res, 400, 'invalid_channel'); return;
      }
      if (sessions.size + creatingSessions >= config.maxSessions) { sendError(res, 429, 'session_limit'); return; }
      creatingSessions++;
      const creation = createSession(channelId, typeof preferredLanguage === 'string' ? preferredLanguage : undefined, res);
      pendingCreations.add(creation);
      try { await creation; }
      finally { pendingCreations.delete(creation); creatingSessions--; }
      return;
    }
    const parts = url.pathname.split('/').filter(Boolean);
    if (parts[0] !== 'v1' || parts[1] !== 'sessions' || !parts[2] || !SESSION_ID.test(parts[2])) {
      sendError(res, 404, 'not_found'); return;
    }
    const session = sessions.get(parts[2]);
    if (!session || session.expiresAt <= now()) { if (session) void removeSession(session); sendError(res, 404, 'session_expired'); return; }

    if (parts[3] === 'hls' || parts[3] === 'images') {
      if (!capabilityMatches(url.searchParams.get('cap'), session.capability)) { sendError(res, 401, 'unauthorized'); return; }
      if (parts[3] === 'hls' && parts[4] === 'index.m3u8' && req.method === 'GET') {
        diagnostic({ event: 'media-playlist-requested', status: 200, state: session.preparationFailed ? 'failed' : session.worker.state, originKind });
        if (!session.playbackStarted && now() >= session.startupDeadlineAt) {
          await failStartup(session);
          sendError(res, 410, 'playback_start_timeout'); return;
        }
        const playlist = session.playbackStarted ? await session.worker.playlist() : await session.worker.startupPlaylist();
        if (!playlist) { sendError(res, 425, 'preparing'); return; }
        sendText(res, 200, rewritePlaylist(playlist, session.id, session.capability), 'application/vnd.apple.mpegurl'); return;
      }
      if (parts[3] === 'hls' && parts[4] && SEGMENT.test(parts[4]) && req.method === 'GET') {
        const bytes = await session.worker.segment(parts[4]);
        if (!bytes) { sendError(res, 404, 'segment_expired'); return; }
        res.writeHead(200, { 'content-type': 'video/mp2t', 'content-length': bytes.byteLength, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' }).end(bytes); return;
      }
      if (parts[3] === 'images' && parts[4] && IMAGE_ID.test(parts[4]) && req.method === 'GET') {
        const bytes = await session.worker.image(parts[4]);
        if (!bytes || bytes.byteLength > 2 * 1024 * 1024) { sendError(res, 404, 'image_expired'); return; }
        res.writeHead(200, { 'content-type': 'image/png', 'content-length': bytes.byteLength, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' }).end(bytes); return;
      }
      sendError(res, 404, 'not_found'); return;
    }
    if (!authOk) { diagnostic({ event: 'session-auth-failed', status: 401, originKind }); sendError(res, 401, 'unauthorized'); return; }
    if (parts[3] === 'playback-started' && req.method === 'POST') {
      if (now() >= session.startupDeadlineAt && !session.playbackStarted) {
        await failStartup(session);
        sendError(res, 410, 'playback_start_timeout'); return;
      }
      if (!session.playbackStarted) {
        session.playbackStarted = true;
        if (session.startupTimer) clearTimeout(session.startupTimer);
        session.worker.markPlaybackStarted();
      }
      diagnostic({ event: 'playback-acknowledged', status: 200, state: session.worker.state, originKind });
      sendJson(res, 200, { playbackStarted: true }); return;
    }
    if (parts[3] === 'status' && req.method === 'GET') {
      const inputIdleMs = session.worker.inputIdleMs;
      const inputDiagnostics = { ...(session.worker.failureReason ? { reason: session.worker.failureReason } : {}), ...(inputIdleMs !== undefined && Number.isFinite(inputIdleMs) ? { inputIdleMs: Math.max(0, Math.round(inputIdleMs)) } : {}) };
      diagnostic({ event: 'preparer-state', status: 200, state: session.preparationFailed ? 'failed' : session.worker.state, originKind, ...inputDiagnostics });
      sendJson(res, 200, { sessionId: session.id, state: session.preparationFailed ? 'failed' : session.worker.state === 'stopped' ? 'failed' : session.worker.state, ...inputDiagnostics, tracks: session.worker.tracks(), selectedTrackId: session.worker.selectedTrack(), ...(session.worker.timingOrigin !== undefined ? { timingOrigin: session.worker.timingOrigin } : {}), ...(session.worker.videoPtsOrigin90k !== undefined ? { videoPtsOrigin90k: session.worker.videoPtsOrigin90k } : {}), startupSequence: session.worker.startupSequence ?? null, startupDeadlineAt: session.startupDeadlineAt, playbackStarted: session.playbackStarted, ...(session.worker.startupTimingOrigin !== undefined ? { startupTimingOrigin: session.worker.startupTimingOrigin } : {}), ...(session.worker.startupVideoPtsOrigin90k !== undefined ? { startupVideoPtsOrigin90k: session.worker.startupVideoPtsOrigin90k } : {}), leaseExpiresAt: session.expiresAt }); return;
    }
    if (parts[3] === 'cues' && req.method === 'GET') {
      const cursorRaw = url.searchParams.get('afterSequence') ?? url.searchParams.get('after') ?? '0';
      const cursor = Number(cursorRaw);
      if (!Number.isSafeInteger(cursor) || cursor < 0) { sendError(res, 400, 'invalid_cursor'); return; }
      sendJson(res, 200, session.worker.cues(cursor)); return;
    }
    if (parts[3] === 'subtitle-track' && req.method === 'PUT') {
      const body = await readBody(req, config.maxBodyBytes);
      if (body === undefined) { sendError(res, 413, 'body_too_large'); return; }
      let input: unknown;
      try { input = JSON.parse(body); } catch { sendError(res, 400, 'invalid_request'); return; }
      if (!input || typeof input !== 'object' || Array.isArray(input)) { sendError(res, 400, 'invalid_request'); return; }
      const trackId = (input as Record<string, unknown>).trackId;
      if (!(trackId === null || (typeof trackId === 'string' && trackId.length <= 96))) { sendError(res, 400, 'invalid_track'); return; }
      try { session.worker.selectTrack(trackId); } catch { sendError(res, 400, 'invalid_track'); return; }
      sendJson(res, 200, { selectedTrackId: trackId }); return;
    }
    if (parts[3] === 'heartbeat' && req.method === 'POST') {
      session.expiresAt = now() + config.sessionLeaseMs;
      armExpiry(session);
      sendJson(res, 200, { leaseExpiresAt: session.expiresAt }); return;
    }
    if (parts.length === 3 && req.method === 'DELETE') {
      await removeSession(session);
      res.writeHead(204).end(); return;
    }
    sendError(res, 404, 'not_found');
  }

  async function createSession(channelId: string, preferredLanguage: string | undefined, res: ServerResponse): Promise<void> {
    const id = tokenFactory().slice(0, 32);
    const capability = tokenFactory().slice(0, 64);
    if (!SESSION_ID.test(id) || sessions.has(id)) { sendError(res, 500, 'session_create_failed'); return; }
    const directory = join(config.sessionRoot, id);
    try {
      await mkdir(directory, { recursive: false, mode: 0o700 });
      const upstreamUrl = config.channels[channelId];
      if (!upstreamUrl) throw new Error('invalid_config');
      const worker = await workerFactory.create({ sessionId: id, sessionDirectory: directory, upstreamUrl, allowedRedirectHosts: config.allowedRedirectHosts, allowPublicRedirects: config.allowPublicRedirects === true, ...(preferredLanguage ? { preferredLanguage } : {}) });
      if (closing) {
        await worker.stop();
        await rm(directory, { recursive: true, force: true });
        sendError(res, 503, 'service_stopping');
        return;
      }
      const session: Session = { id, capability, channelId, worker, directory, expiresAt: now() + config.sessionLeaseMs, startupDeadlineAt: now() + startupAckTimeoutMs, playbackStarted: false };
      sessions.set(id, session);
      diagnostic({ event: 'session-created', status: 201, state: worker.state });
      if (worker.state === 'ready' || worker.state === 'failed') diagnostic({ event: 'preparer-state', status: 201, state: worker.state });
      armExpiry(session);
      session.startupTimer = setTimeout(() => { void failStartup(session); }, startupAckTimeoutMs);
      session.startupTimer.unref();
      session.prepareTimer = setTimeout(() => {
        if (session.worker.state === 'preparing') {
          session.preparationFailed = true;
          diagnostic({ event: 'preparer-state', status: 504, state: 'failed' });
          void session.worker.markFailed?.();
        }
      }, config.prepareTimeoutMs);
      session.prepareTimer.unref();
      const base = '/v1/sessions/' + id;
      const mediaUrl = base + '/hls/index.m3u8?cap=' + capability;
      sendJson(res, 201, {
        protocolVersion: 1, sessionId: id, capability, state: worker.state === 'ready' ? 'ready' : 'preparing', mediaUrl,
        statusUrl: base + '/status', cueUrl: base + '/cues', trackUrl: base + '/subtitle-track',
        playbackStartedUrl: base + '/playback-started',
        heartbeatUrl: base + '/heartbeat', deleteUrl: base,
        leaseExpiresAt: session.expiresAt,
      });
    } catch {
      await rm(directory, { recursive: true, force: true }).catch(() => undefined);
      sendError(res, 502, 'upstream_unavailable');
    }
  }

  function armExpiry(session: Session): void {
    if (session.timer) clearTimeout(session.timer);
    session.timer = setTimeout(() => { void removeSession(session); }, Math.max(1, session.expiresAt - now()));
    session.timer.unref();
  }
  async function failStartup(session: Session): Promise<void> {
    if (session.playbackStarted || session.preparationFailed || session.deleting) return;
    session.preparationFailed = true;
    diagnostic({ event: 'preparer-state', status: 410, state: 'failed' });
    if (session.startupTimer) clearTimeout(session.startupTimer);
    await session.worker.markFailed?.().catch(() => undefined);
  }
  async function removeSession(session: Session): Promise<void> {
    if (session.deleting) return session.deleting;
    session.deleting = (async () => {
      sessions.delete(session.id);
      if (session.timer) clearTimeout(session.timer);
      if (session.prepareTimer) clearTimeout(session.prepareTimer);
      if (session.startupTimer) clearTimeout(session.startupTimer);
      await session.worker.stop().catch(() => undefined);
      await rm(session.directory, { recursive: true, force: true }).catch(() => undefined);
      diagnostic({ event: 'session-deleted', status: 204, state: 'stopped' });
    })();
    return session.deleting;
  }
  server.dispatch = handle;
  server.on('close', () => {
    closeCleanup = Promise.all(Array.from(sessions.values(), (session) => removeSession(session))).then(() => undefined);
  });
  server.shutdown = async () => {
    if (shutdownTask) return shutdownTask;
    closing = true;
    shutdownTask = (async () => {
      if (server.listening) await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      await Promise.all(Array.from(pendingCreations));
      if (!server.listening) closeCleanup = Promise.all(Array.from(sessions.values(), (session) => removeSession(session))).then(() => undefined);
      await closeCleanup;
    })();
    return shutdownTask;
  };
  return server;
}

function rateLimit(req: IncomingMessage, now: () => number, windows: Map<string, { startedAt: number; count: number }>, sessionLimit: number): boolean {
  const raw = req.socket.remoteAddress ?? 'unknown';
  const address = raw.startsWith('::ffff:') ? raw.slice(7) : raw;
  const at = now();
  let window = windows.get(address);
  if (!window || at - window.startedAt >= 60_000) {
    if (windows.size >= 2048) {
      for (const [key, value] of windows) if (at - value.startedAt >= 60_000) windows.delete(key);
      while (windows.size >= 2048) {
        const oldest = windows.keys().next().value as string | undefined;
        if (oldest === undefined) break;
        windows.delete(oldest);
      }
    }
    window = { startedAt: at, count: 0 };
    windows.set(address, window);
  }
  window.count++;
  return window.count <= 300 + sessionLimit * 200;
}

function safeRequestUrl(raw: string | undefined): URL | undefined {
  if (!raw || raw.length > 4096 || !raw.startsWith('/')) return undefined;
  try { return new URL(raw, 'http://relay.invalid'); } catch { return undefined; }
}
function bearerMatches(header: string | undefined, expected: string): boolean {
  if (!header?.startsWith('Bearer ')) return false;
  const supplied = Buffer.from(header.slice(7)); const target = Buffer.from(expected);
  return supplied.byteLength === target.byteLength && timingSafeEqual(supplied, target);
}
function capabilityMatches(supplied: string | null, expected: string): boolean {
  if (!supplied) return false;
  const a = Buffer.from(supplied); const b = Buffer.from(expected);
  return a.byteLength === b.byteLength && timingSafeEqual(a, b);
}
async function readBody(req: IncomingMessage, maxBytes: number): Promise<string | undefined> {
  const lengthHeader = req.headers['content-length'];
  if (lengthHeader && Number(lengthHeader) > maxBytes) { req.resume(); return undefined; }
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of req) {
    const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += data.byteLength;
    if (size > maxBytes) { req.resume(); return undefined; }
    chunks.push(data);
  }
  return Buffer.concat(chunks).toString('utf8');
}
function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const data = Buffer.from(JSON.stringify(body));
  res.writeHead(status, { 'content-type': JSON_TYPE, 'content-length': data.byteLength, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' }).end(data);
}
function sendText(res: ServerResponse, status: number, text: string, type: string): void {
  const data = Buffer.from(text);
  res.writeHead(status, { 'content-type': type, 'content-length': data.byteLength, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' }).end(data);
}
function sendError(res: ServerResponse, status: number, code: string): void { sendJson(res, status, { error: code }); }
function rewritePlaylist(playlist: string, sessionId: string, capability: string): string {
  const base = '/v1/sessions/' + sessionId + '/hls/';
  return playlist.split(/\r?\n/).map((line) => {
    if (!line || line.startsWith('#')) return line;
    const name = line.trim().split(/[?#]/, 1)[0] ?? '';
    if (!SEGMENT.test(name)) return '';
    return base + name + '?cap=' + capability;
  }).join('\n');
}
