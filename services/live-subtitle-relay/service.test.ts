import { mkdir, mkdtemp, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable, Writable } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import { validateRelayConfig } from './config.ts';
import { createRelayServer } from './service.ts';
import type { RelayWorker, RelayWorkerFactory } from './ingest.ts';

const TOKEN = 'f'.repeat(64);
const PNG = new Uint8Array([137, 80, 78, 71]);

class FakeWorker implements RelayWorker {
  state: 'ready' | 'failed' = 'ready';
  failureReason: import('./ingest.ts').RelayFailureReason | undefined;
  inputIdleMs: number | undefined;
  readonly timingOrigin = 0;
  readonly videoPtsOrigin90k = 90_000;
  readonly startupSequence = 0;
  readonly startupTimingOrigin = 0;
  readonly startupVideoPtsOrigin90k = 90_000;
  playbackStarted = false;
  currentPlaylist = '#EXTM3U\n#EXTINF:4.000,\nsegment-00000000.ts\n#EXTINF:4.000,\nsegment-00000001.ts\n#EXTINF:4.000,\nsegment-00000002.ts\n';
  stopped = false;
  tracks() { return [{ id: 'dvb:fi', language: 'fin', label: 'Finnish · DVB' }]; }
  selectedTrack() { return 'dvb:fi'; }
  selectTrack(id: string | null) { if (id !== null && id !== 'dvb:fi') throw new Error('invalid_track'); }
  async playlist() { return this.currentPlaylist; }
  async startupPlaylist() { return this.playbackStarted ? undefined : '#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:4\n#EXT-X-MEDIA-SEQUENCE:0\n#EXTINF:4.000,\nsegment-00000000.ts\n#EXTINF:4.000,\nsegment-00000001.ts\n#EXTINF:4.000,\nsegment-00000002.ts\n'; }
  markPlaybackStarted() { this.playbackStarted = true; }
  async segment(name: string) { return name === 'segment-00000000.ts' ? new Uint8Array([0x47, 0x47]) : undefined; }
  cues(afterSequence: number) { return { cues: [{ seq: 1, epoch: 1, trackId: 'dvb:fi', startMs: 1000, endMs: 2000, clear: false, imageId: 'frame-1', screenWidth: 1920, screenHeight: 1080, x: 10, y: 900, width: 100, height: 30 }].filter((cue) => cue.seq > afterSequence), nextCursor: 1, reset: false }; }
  async image(id: string) { return id === 'frame-1' ? PNG : undefined; }
  async stop() { this.stopped = true; }
  async markFailed() { this.state = 'failed'; await this.stop(); }
}

describe('live subtitle relay HTTP API', () => {
  let root: string | undefined;
  let server: Awaited<ReturnType<typeof createRelayServer>> | undefined;
  afterEach(async () => {
    if (server) await server.shutdown();
    if (root) await rm(root, { recursive: true, force: true });
    server = undefined; root = undefined;
  });

  async function start(maxSessions = 1, suppliedFactory?: RelayWorkerFactory, startupAckTimeoutMs?: number, onDiagnostic?: (event: import('./service.ts').RelayDiagnosticEvent) => void) {
    root = await mkdtemp(join(tmpdir(), 'relay-service-test-'));
    const workers: FakeWorker[] = [];
    const factory: RelayWorkerFactory = suppliedFactory ?? { async create() { const worker = new FakeWorker(); workers.push(worker); return worker; } };
    let token = 0;
    server = await createRelayServer(validateRelayConfig({
      apiToken: TOKEN, channels: { sky: 'https://provider.example/live?fixture=synthetic' },
      sessionRoot: join(root, 'sessions'), maxSessions,
    }), { workerFactory: factory, ...(onDiagnostic ? { onDiagnostic } : {}), randomToken: () => (++token).toString(16).padStart(32, '0') + '0'.repeat(32), ...(startupAckTimeoutMs !== undefined ? { startupAckTimeoutMs } : {}) });
    async function invoke(method: string, path: string, options: { body?: unknown; authorization?: string; origin?: string } = {}) {
      const payload = options.body === undefined ? undefined : Buffer.from(JSON.stringify(options.body));
      const request = Readable.from(payload ? [payload] : []) as Readable & Record<string, unknown>;
      Object.assign(request, {
        method, url: path,
        headers: {
          ...(options.authorization ? { authorization: options.authorization } : {}),
          ...(options.origin ? { origin: options.origin } : {}),
          ...(payload ? { 'content-length': String(payload.byteLength), 'content-type': 'application/json' } : {}),
        },
        socket: { remoteAddress: 'test-client' },
      });
      const response = new TestResponse();
      await server!.dispatch(request as never, response as never);
      return { status: response.statusCode, body: response.body, bodyBuffer: response.bodyBuffer };
    }
    return { invoke, workers };
  }

  it('emits fixed lifecycle diagnostics without recording raw origins or identifiers', async () => {
    const events: import('./service.ts').RelayDiagnosticEvent[] = [];
    const { invoke } = await start(1, undefined, undefined, (event) => events.push(event));
    expect((await invoke('OPTIONS', '/v1/sessions', { origin: 'null' })).status).toBe(403);
    expect((await invoke('POST', '/v1/sessions', { origin: 'https://not-allowed.example/path?secret=1' })).status).toBe(401);
    expect((await invoke('POST', '/v1/sessions', { authorization: 'Bearer ' + TOKEN, body: { channelId: 'missing' } })).status).toBe(400);
    const created = await invoke('POST', '/v1/sessions', { authorization: 'Bearer ' + TOKEN, body: { channelId: 'sky' } });
    const session = JSON.parse(created.body) as { mediaUrl: string; playbackStartedUrl: string; deleteUrl: string };
    await invoke('GET', session.mediaUrl);
    await invoke('POST', session.playbackStartedUrl, { authorization: 'Bearer ' + TOKEN });
    await invoke('DELETE', session.deleteUrl, { authorization: 'Bearer ' + TOKEN });
    expect(events.map(({ event }) => event)).toEqual([
      'options-rejected', 'session-auth-failed', 'invalid-channel', 'session-created', 'preparer-state',
      'media-playlist-requested', 'playback-acknowledged', 'session-deleted',
    ]);
    expect(events[0]).toMatchObject({ status: 403, originKind: 'opaque' });
    expect(events[1]).toMatchObject({ status: 401, originKind: 'http' });
    expect(JSON.stringify(events)).not.toContain('not-allowed.example');
    expect(JSON.stringify(events)).not.toContain('secret');
  });

  it('requires bearer auth, issues capability URLs, rewrites only safe segment paths, and serves cues/images', async () => {
    const { invoke, workers } = await start();
    expect((await invoke('GET', '/healthz')).status).toBe(200);
    expect((await invoke('POST', '/v1/sessions')).status).toBe(401);
    const created = await invoke('POST', '/v1/sessions', { authorization: 'Bearer ' + TOKEN, body: { channelId: 'sky', preferredLanguage: 'fi' } });
    expect(created.status).toBe(201);
    const session = JSON.parse(created.body) as { sessionId: string; capability: string; mediaUrl: string; cueUrl: string; statusUrl: string };
    expect(session.mediaUrl).toBe('/v1/sessions/' + session.sessionId + '/hls/index.m3u8?cap=' + session.capability);
    expect(session.sessionId).toMatch(/^[a-f0-9]{32}$/);
    const playlistReply = await invoke('GET', session.mediaUrl);
    expect(playlistReply.status).toBe(200);
    const playlist = playlistReply.body;
    expect(playlist).toContain('/v1/sessions/' + session.sessionId + '/hls/segment-00000000.ts?cap=');
    expect(playlist).not.toContain('provider.example');
    const status = await invoke('GET', session.statusUrl, { authorization: 'Bearer ' + TOKEN });
    expect(JSON.parse(status.body)).toMatchObject({ sessionId: session.sessionId, state: 'ready', selectedTrackId: 'dvb:fi' });
    const cues = await invoke('GET', session.cueUrl + '?afterSequence=0', { authorization: 'Bearer ' + TOKEN });
    expect(JSON.parse(cues.body)).toMatchObject({ nextCursor: 1, cues: [{ imageId: 'frame-1' }] });
    const image = await invoke('GET', '/v1/sessions/' + session.sessionId + '/images/frame-1?cap=' + session.capability);
    expect(image.bodyBuffer).toEqual(Buffer.from(PNG));
    const segment = await invoke('GET', '/v1/sessions/' + session.sessionId + '/hls/segment-00000000.ts?cap=' + session.capability);
    expect(segment.bodyBuffer).toEqual(Buffer.from([0x47, 0x47]));
    expect(workers).toHaveLength(1);
  });

  it('reports a fixed upstream failure reason and idle duration without exposing provider data', async () => {
    const events: import('./service.ts').RelayDiagnosticEvent[] = [];
    const { invoke, workers } = await start(1, undefined, undefined, (event) => events.push(event));
    const created = await invoke('POST', '/v1/sessions', { authorization: 'Bearer ' + TOKEN, body: { channelId: 'sky' } });
    const session = JSON.parse(created.body) as { statusUrl: string };
    workers[0]!.state = 'failed';
    workers[0]!.failureReason = 'upstream-idle-timeout';
    workers[0]!.inputIdleMs = 90_001;
    const status = await invoke('GET', session.statusUrl, { authorization: 'Bearer ' + TOKEN });
    expect(JSON.parse(status.body)).toMatchObject({ state: 'failed', reason: 'upstream-idle-timeout', inputIdleMs: 90_001 });
    expect(events.at(-1)).toMatchObject({ state: 'failed', reason: 'upstream-idle-timeout', inputIdleMs: 90_001 });
    expect(JSON.stringify(events)).not.toContain('provider.example');
    expect(JSON.stringify(events)).not.toContain(TOKEN);
  });

  it('pins repeat startup manifests until the authenticated playback acknowledgement, then follows live output', async () => {
    const { invoke, workers } = await start();
    const created = await invoke('POST', '/v1/sessions', { authorization: 'Bearer ' + TOKEN, body: { channelId: 'sky' } });
    const session = JSON.parse(created.body) as { sessionId: string; mediaUrl: string; playbackStartedUrl: string; statusUrl: string };
    const first = await invoke('GET', session.mediaUrl);
    expect(first.body).toContain('#EXT-X-MEDIA-SEQUENCE:0');
    expect(first.body.match(/#EXTINF:/g)).toHaveLength(3);
    expect(first.body).not.toContain('#EXT-X-ENDLIST');
    workers[0]!.currentPlaylist = '#EXTM3U\n#EXT-X-MEDIA-SEQUENCE:5\n#EXTINF:4.000,\nsegment-00000005.ts\n';
    const repeated = await invoke('GET', session.mediaUrl);
    expect(repeated.body).toContain('#EXT-X-MEDIA-SEQUENCE:0');
    expect(repeated.body).toContain('segment-00000000.ts?cap=');
    expect(repeated.body).toContain('segment-00000002.ts?cap=');
    expect(JSON.parse((await invoke('GET', session.statusUrl, { authorization: 'Bearer ' + TOKEN })).body)).toMatchObject({
      startupSequence: 0, startupTimingOrigin: 0, startupVideoPtsOrigin90k: 90_000, playbackStarted: false,
    });
    expect((await invoke('POST', session.playbackStartedUrl)).status).toBe(401);
    expect((await invoke('POST', session.playbackStartedUrl, { authorization: 'Bearer ' + TOKEN })).status).toBe(200);
    const live = await invoke('GET', session.mediaUrl);
    expect(live.body).toContain('#EXT-X-MEDIA-SEQUENCE:5');
    expect(live.body).toContain('segment-00000005.ts?cap=');
    expect(workers[0]?.playbackStarted).toBe(true);
  });

  it('fails closed when the player never acknowledges startup before the pin deadline', async () => {
    const { invoke, workers } = await start(1, undefined, 10);
    const created = await invoke('POST', '/v1/sessions', { authorization: 'Bearer ' + TOKEN, body: { channelId: 'sky' } });
    const session = JSON.parse(created.body) as { sessionId: string; mediaUrl: string; statusUrl: string };
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(JSON.parse((await invoke('GET', session.statusUrl, { authorization: 'Bearer ' + TOKEN })).body).state).toBe('failed');
    expect((await invoke('GET', session.mediaUrl)).status).toBe(410);
    expect(workers[0]?.stopped).toBe(true);
  });

  it('enforces the session limit, renews leases, and tears down media on delete', async () => {
    const { invoke, workers } = await start();
    const post = () => invoke('POST', '/v1/sessions', { authorization: 'Bearer ' + TOKEN, body: { channelId: 'sky' } });
    const first = await post();
    const info = JSON.parse(first.body) as { sessionId: string; heartbeatUrl: string; deleteUrl: string };
    expect((await post()).status).toBe(429);
    const heartbeat = await invoke('POST', info.heartbeatUrl, { authorization: 'Bearer ' + TOKEN });
    expect(heartbeat.status).toBe(200);
    expect((await invoke('DELETE', info.deleteUrl, { authorization: 'Bearer ' + TOKEN })).status).toBe(204);
    expect(workers[0]?.stopped).toBe(true);
    expect((await invoke('POST', info.heartbeatUrl, { authorization: 'Bearer ' + TOKEN })).status).toBe(404);
    await expect(rm(join(root!, 'sessions', info.sessionId))).rejects.toThrow();
  });

  it('removes only owned stale session directories at startup', async () => {
    root = await mkdtemp(join(tmpdir(), 'relay-stale-test-'));
    const storage = join(root, 'sessions');
    const staleId = 'a'.repeat(32);
    await mkdir(join(storage, staleId), { recursive: true });
    await writeFile(join(storage, staleId, 'old.ts'), 'synthetic stale data');
    await writeFile(join(storage, 'keep-me.txt'), 'unrelated file');
    await mkdir(join(storage, 'not-a-session'), { recursive: true });
    await symlink(join(storage, 'keep-me.txt'), join(storage, 'b'.repeat(32)));
    server = await createRelayServer(validateRelayConfig({ apiToken: TOKEN, channels: {}, sessionRoot: storage }), { cleanupStaleSessions: true });
    const entries = await readdir(storage);
    expect(entries).toContain('keep-me.txt');
    expect(entries).toContain('not-a-session');
    expect(entries).toContain('b'.repeat(32));
    expect(entries).not.toContain(staleId);
  });

  it('reserves concurrent capacity and drains a pending create before shutdown', async () => {
    let resolveWorker: ((worker: RelayWorker) => void) | undefined;
    let enteredFactory: (() => void) | undefined;
    const entered = new Promise<void>((resolve) => { enteredFactory = resolve; });
    const worker = new FakeWorker();
    const factory: RelayWorkerFactory = {
      create() {
        enteredFactory?.();
        return new Promise<RelayWorker>((resolve) => { resolveWorker = resolve; });
      },
    };
    const { invoke } = await start(1, factory);
    const request = invoke('POST', '/v1/sessions', { authorization: 'Bearer ' + TOKEN, body: { channelId: 'sky' } });
    await entered;
    expect((await invoke('POST', '/v1/sessions', { authorization: 'Bearer ' + TOKEN, body: { channelId: 'sky' } })).status).toBe(429);
    let shutdownComplete = false;
    const shutdown = server!.shutdown().then(() => { shutdownComplete = true; });
    await Promise.resolve();
    expect(shutdownComplete).toBe(false);
    resolveWorker?.(worker);
    const response = await request;
    await shutdown;
    expect(response.status).toBe(503);
    expect(worker.stopped).toBe(true);
    expect(await readdir(join(root!, 'sessions'))).toEqual([]);
  });

  it('allows concurrent Tizen cue polling from sessions behind one proxy IP', async () => {
    const { invoke } = await start(2);
    const create = () => invoke('POST', '/v1/sessions', { authorization: 'Bearer ' + TOKEN, body: { channelId: 'sky' } });
    const firstResponse = await create();
    const secondResponse = await create();
    expect(firstResponse.status).toBe(201);
    expect(secondResponse.status).toBe(201);
    const first = JSON.parse(firstResponse.body) as { cueUrl: string };
    const second = JSON.parse(secondResponse.body) as { cueUrl: string };
    for (let poll = 0; poll < 151; poll++) {
      expect((await invoke('GET', first.cueUrl, { authorization: 'Bearer ' + TOKEN })).status).toBe(200);
      expect((await invoke('GET', second.cueUrl, { authorization: 'Bearer ' + TOKEN })).status).toBe(200);
    }
  });
});

class TestResponse extends Writable {
  statusCode = 0;
  private chunks: Buffer[] = [];
  get body(): string { return Buffer.concat(this.chunks).toString('utf8'); }
  get bodyBuffer(): Buffer { return Buffer.concat(this.chunks); }
  writeHead(statusCode: number): this { this.statusCode = statusCode; return this; }
  _write(chunk: Buffer | string, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    this.chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    callback();
  }
}
