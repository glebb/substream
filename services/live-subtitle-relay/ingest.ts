import { lookup } from 'node:dns/promises';
import { request as httpRequest, type IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdir, readFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { LiveSubtitleSegmentProcessor } from './subtitles.ts';
import type { RelayCue as ProtocolCue, RelaySubtitleTrack } from '../../src/core/live-relay/protocol.ts';

export type RelayState = 'preparing' | 'ready' | 'failed' | 'stopped';
export type RelayFailureReason = 'upstream-idle-timeout' | 'upstream-error' | 'upstream-ended' | 'ffmpeg-error' | 'ffmpeg-exited' | 'segment-limit' | 'disk-limit';
export type RelayTrack = RelaySubtitleTrack;
export type RelayCue = ProtocolCue;
export interface CueBatch { cues: RelayCue[]; nextCursor: number; reset: boolean; active?: RelayCue | null; }
export interface RelayWorker {
  readonly state: RelayState;
  readonly failureReason?: RelayFailureReason | undefined;
  readonly inputIdleMs?: number | undefined;
  readonly timingOrigin: number | undefined;
  readonly videoPtsOrigin90k: number | undefined;
  readonly startupSequence: number | undefined;
  readonly startupTimingOrigin: number | undefined;
  readonly startupVideoPtsOrigin90k: number | undefined;
  tracks(): RelayTrack[];
  selectedTrack(): string | null;
  selectTrack(trackId: string | null): void;
  playlist(): Promise<string>;
  startupPlaylist(): Promise<string | undefined>;
  markPlaybackStarted(): void;
  segment(name: string): Promise<Uint8Array | undefined>;
  cues(afterSequence: number): CueBatch;
  image(imageId: string): Promise<Uint8Array | undefined>;
  stop(): Promise<void>;
  markFailed?(): Promise<void>;
}
export interface CreateWorkerOptions { sessionId: string; sessionDirectory: string; upstreamUrl: string; preferredLanguage?: string; allowedRedirectHosts?: readonly string[]; allowPublicRedirects?: boolean; }
export interface RelayWorkerFactory { create(options: CreateWorkerOptions): Promise<RelayWorker>; }
export type DnsResolver = (hostname: string) => Promise<Array<{ address: string; family: number }>>;

function ipv4(address: string): number[] | undefined {
  const parts = address.split('.');
  if (parts.length !== 4 || parts.some((part) => !/^\d{1,3}$/.test(part))) return undefined;
  const values = parts.map(Number);
  if (values.some((part) => part > 255)) return undefined;
  return values;
}

export function isPublicAddress(address: string): boolean {
  const v4 = ipv4(address);
  if (v4) {
    const a = v4[0] ?? 0; const b = v4[1] ?? 0;
    return !(a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) ||
      (a === 192 && (b === 0 || b === 2 || b === 88)) ||
      (a === 198 && (b === 18 || b === 19 || (b === 51 && (v4[2] ?? 0) === 100))) ||
      (a === 203 && b === 0 && (v4[2] ?? 0) === 113));
  }
  const normalized = address.toLowerCase().split('%')[0] ?? '';
  if (!normalized.includes(':')) return false;
  if (normalized.startsWith('::ffff:')) return isPublicAddress(normalized.slice(7));
  const first = Number.parseInt(normalized.split(':')[0] || '0', 16);
  return first >= 0x2000 && first <= 0x3fff && !normalized.startsWith('2001:db8:') && !normalized.startsWith('2001:10:');
}

async function defaultResolver(hostname: string): Promise<Array<{ address: string; family: number }>> {
  return lookup(hostname, { all: true, verbatim: true });
}

/** Resolve and pin a vetted public address; every redirect is validated independently. */
export async function openSafeUpstream(rawUrl: string, resolver: DnsResolver = defaultResolver, redirects = 4, allowedRedirectHosts?: readonly string[], allowPublicRedirects = false): Promise<IncomingMessage> {
  let url: URL;
  try { url = new URL(rawUrl); } catch { throw new Error('upstream_unavailable'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('upstream_unavailable');
  const allowedHosts = allowedRedirectHosts ?? [url.hostname.toLowerCase()];
  if (!allowedHosts.includes(url.hostname.toLowerCase()) && !allowPublicRedirects) throw new Error('upstream_unavailable');
  let addresses: Array<{ address: string; family: number }>;
  try { addresses = await resolver(url.hostname); } catch { throw new Error('upstream_unavailable'); }
  if (!addresses.length || addresses.some((entry) => !isPublicAddress(entry.address))) throw new Error('upstream_unavailable');
  const selected = addresses[0];
  if (!selected) throw new Error('upstream_unavailable');
  const response = await new Promise<IncomingMessage>((resolve, reject) => {
    let settled = false;
    let incomingResponse: IncomingMessage | undefined;
    const headerDeadline = setTimeout(() => {
      if (settled) return;
      settled = true;
      request.destroy(new Error('upstream_unavailable'));
      reject(new Error('upstream_unavailable'));
    }, 20_000);
    let request: ReturnType<typeof httpRequest>;
    try { request = (url.protocol === 'https:' ? httpsRequest : httpRequest)({
      protocol: url.protocol, hostname: url.hostname, port: url.port || undefined,
      path: url.pathname + url.search, method: 'GET',
      headers: { 'user-agent': 'LiveSubtitleRelay/1' },
      // Newer Node requests an address array for family autoselection. Both
      // callback forms must still return only the single vetted, pinned address.
      lookup: (_host, options, callback) => options.all
        ? callback(null, [selected])
        : callback(null, selected.address, selected.family),
    }, (incoming) => {
      if (settled) { incoming.destroy(); return; }
      settled = true;
      incomingResponse = incoming;
      clearTimeout(headerDeadline);
      // The header deadline protects connection setup and response headers.
      // Live TS providers can pause between chunks, so give the body a longer
      // inactivity window while still terminating a genuinely stalled stream.
      request.setTimeout(90_000);
      resolve(incoming);
    }); } catch {
      clearTimeout(headerDeadline);
      reject(new Error('upstream_unavailable'));
      return;
    }
    request.on('error', () => {
      clearTimeout(headerDeadline);
      if (settled) return;
      settled = true;
      reject(new Error('upstream_unavailable'));
    });
    request.on('timeout', () => {
      if (settled) {
        const error = new Error('upstream_idle_timeout');
        incomingResponse?.destroy(error);
        request.destroy();
      } else {
        request.destroy(new Error('upstream_unavailable'));
      }
    });
    try { request.end(); } catch {
      clearTimeout(headerDeadline);
      if (!settled) { settled = true; reject(new Error('upstream_unavailable')); }
    }
  });
  const status = response.statusCode ?? 500;
  if ([301, 302, 303, 307, 308].includes(status)) {
    const location = response.headers.location; response.destroy();
    if (!location || redirects <= 0) throw new Error('upstream_unavailable');
    let next: URL;
    try { next = new URL(location, url); } catch { throw new Error('upstream_unavailable'); }
    return openSafeUpstream(next.toString(), resolver, redirects - 1, allowedHosts, allowPublicRedirects);
  }
  if (status < 200 || status >= 300) { response.destroy(); throw new Error('upstream_unavailable'); }
  return response;
}

/** Stream-copy HLS worker; a processor can observe each finalized output segment. */
export class FfmpegRelayWorker implements RelayWorker {
  private currentState: RelayState = 'preparing';
  private failureReasonValue: RelayFailureReason | undefined;
  private lastInputAt: number | undefined;
  private inputIdleAtFailure: number | undefined;
  private child: ChildProcess | undefined;
  private childExit: Promise<void> | undefined;
  private upstream: IncomingMessage | undefined;
  private pump: Promise<void> | undefined;
  private poller: NodeJS.Timeout | undefined;
  private pollTask: Promise<void> | undefined;
  private lastPlaylist = '';
  private mediaStarts = new Map<number, number>();
  private mediaDurations = new Map<number, number>();
  private processed = new Set<string>();
  private tracksValue: RelayTrack[] = [];
  private selectedValue: string | null = null;
  private stopped = false;
  private stopping: Promise<void> | undefined;
  private readonly options: CreateWorkerOptions & { ffmpegPath?: string; maxDiskBytes?: number; segmentObserver?: (bytes: Uint8Array, name: string) => void | Promise<void>; openUpstream?: (url: string) => Promise<IncomingMessage> };
  private readonly processor: LiveSubtitleSegmentProcessor;
  private timingOriginValue: number | undefined;
  private videoPtsOrigin90kValue: number | undefined;
  private startupSequenceValue: number | undefined;
  private startupRowsValue: Array<{ seq: number; duration: number }> | undefined;
  private startupTimingOriginValue: number | undefined;
  private startupVideoPtsOrigin90kValue: number | undefined;
  private playbackStartedValue = false;
  constructor(options: CreateWorkerOptions & { ffmpegPath?: string; maxDiskBytes?: number; segmentObserver?: (bytes: Uint8Array, name: string) => void | Promise<void>; openUpstream?: (url: string) => Promise<IncomingMessage> }) {
    this.options = options;
    this.processor = new LiveSubtitleSegmentProcessor({ ...(options.preferredLanguage ? { preferredLanguage: options.preferredLanguage as 'fi' | 'en' } : {}) });
  }
  get state(): RelayState { return this.currentState; }
  get failureReason(): RelayFailureReason | undefined { return this.failureReasonValue; }
  get inputIdleMs(): number | undefined { return this.inputIdleAtFailure ?? (this.lastInputAt === undefined ? undefined : Math.max(0, Date.now() - this.lastInputAt)); }
  get timingOrigin(): number | undefined { return this.timingOriginValue; }
  get videoPtsOrigin90k(): number | undefined { return this.videoPtsOrigin90kValue; }
  get startupSequence(): number | undefined { return this.startupSequenceValue; }
  get startupTimingOrigin(): number | undefined { return this.startupTimingOriginValue; }
  get startupVideoPtsOrigin90k(): number | undefined { return this.startupVideoPtsOrigin90kValue; }
  tracks(): RelayTrack[] { return this.tracksValue.slice(); }
  selectedTrack(): string | null { return this.selectedValue; }
  selectTrack(trackId: string | null): void {
    if (!this.processor.selectTrack(trackId)) throw new Error('invalid_track');
    this.selectedValue = this.processor.getSelectedTrackId();
  }
  cues(afterSequence: number): CueBatch {
    return this.processor.getCueBatch(afterSequence);
  }
  async image(imageId: string): Promise<Uint8Array | undefined> { return this.processor.getImage(imageId)?.bytes; }
  async start(): Promise<void> {
    await mkdir(this.options.sessionDirectory, { recursive: true, mode: 0o700 });
    const upstream = this.options.openUpstream
      ? await this.options.openUpstream(this.options.upstreamUrl)
      : await openSafeUpstream(this.options.upstreamUrl, defaultResolver, 4, this.options.allowedRedirectHosts, this.options.allowPublicRedirects);
    this.upstream = upstream;
    this.lastInputAt = Date.now();
    upstream.on('data', () => { this.lastInputAt = Date.now(); });
    let child: ChildProcess;
    try {
      child = spawn(this.options.ffmpegPath ?? 'ffmpeg', relayFfmpegArgs(this.options.sessionDirectory), {
        stdio: ['pipe', 'ignore', 'ignore'],
      });
    } catch (error) { upstream.destroy(); throw error; }
    this.child = child;
    // Failed spawn emits error/close without exit. Waiting for close also
    // ensures stdio is released before session files are removed.
    this.childExit = new Promise<void>((resolve) => child.once('close', () => resolve()));
    this.pump = pipeline(upstream, child.stdin!).catch((error: unknown) => {
      if (!this.stopped) void this.fail(error instanceof Error && error.message === 'upstream_idle_timeout' ? 'upstream-idle-timeout' : 'upstream-error');
    });
    child.on('error', () => { if (!this.stopped) void this.fail('ffmpeg-error'); });
    child.on('exit', () => { if (!this.stopped) void this.fail(upstream.readableEnded ? 'upstream-ended' : 'ffmpeg-exited'); });
    this.poller = setInterval(() => { this.runPoll(); }, 250);
    this.poller.unref();
  }
  private async fail(reason: RelayFailureReason): Promise<void> {
    this.failureReasonValue ??= reason;
    this.inputIdleAtFailure ??= this.inputIdleMs;
    this.currentState = 'failed';
    await this.stop();
  }
  private runPoll(): void {
    if (this.stopped || this.pollTask) return;
    const task = this.pollOutput().finally(() => { if (this.pollTask === task) this.pollTask = undefined; });
    this.pollTask = task;
  }
  private async pollOutput(): Promise<void> {
    if (this.stopped) return;
    try {
      this.lastPlaylist = await readFile(join(this.options.sessionDirectory, 'index.m3u8'), 'utf8');
      if (this.stopped) return;
      this.updateMediaStarts(this.lastPlaylist);
      await this.inspectSegments();
    } catch { /* output may not exist during preparation */ }
  }
  private async inspectSegments(): Promise<void> {
    const names = (await readdir(this.options.sessionDirectory)).filter((name) => /^segment-\d{8}\.ts$/.test(name)).sort();
    if (this.stopped) return;
    let total = 0;
    for (const name of names) {
      const path = join(this.options.sessionDirectory, name);
      try {
        const info = await stat(path); total += info.size;
        if (this.stopped) return;
        if (info.size > 32 * 1024 * 1024) {
          void this.fail('segment-limit');
          return;
        }
        if (this.processed.has(name)) continue;
        if (!this.lastPlaylist.split(/\r?\n/).includes(name)) continue;
        const bytes = await readFile(path);
        if (this.stopped) return;
        const seq = Number(name.slice(8, 16));
        const mediaStartSeconds = this.mediaStarts.get(seq);
        const result = this.processor.processSegment(bytes, { sequence: seq, ...(mediaStartSeconds !== undefined ? { mediaStartSeconds } : {}) });
        this.tracksValue = result.tracks;
        this.selectedValue = result.selectedTrackId;
        this.timingOriginValue = result.timingOrigin;
        this.videoPtsOrigin90kValue = result.videoPtsOrigin90k;
        if (this.startupSequenceValue === undefined) {
          const firstSequence = this.playlistRows(this.lastPlaylist)[0];
          if (firstSequence?.seq === seq) {
            this.startupSequenceValue = seq;
            this.startupTimingOriginValue = result.timingOrigin;
            this.startupVideoPtsOrigin90kValue = result.videoPtsOrigin90k;
          }
        }
        if (this.options.segmentObserver) await this.options.segmentObserver(bytes, name);
        if (this.stopped) return;
        this.processed.add(name);
      } catch { this.processed.add(name); /* finalized segment failed; do not spin on it */ }
    }
    // Do not expose a startup manifest until media and subtitle processing
    // have both completed for a contiguous prebuffer of at least eight seconds.
    if (this.startupRowsValue === undefined && this.startupSequenceValue !== undefined) {
      const rows = this.playlistRows(this.lastPlaylist);
      const firstIndex = rows.findIndex((row) => row.seq === this.startupSequenceValue);
      const candidates = firstIndex < 0 ? [] : rows.slice(firstIndex, firstIndex + 3);
      const contiguous = candidates.length === 3 && candidates.every((row, index) => row.seq === this.startupSequenceValue! + index);
      const bufferedDuration = candidates.reduce((sum, row) => sum + row.duration, 0);
      const processed = contiguous && bufferedDuration >= 8 && candidates.every((row) => this.processed.has(`segment-${String(row.seq).padStart(8, '0')}.ts`));
      if (processed) {
        this.startupRowsValue = candidates;
        this.currentState = 'ready';
      }
    }
    for (const oldName of names.slice(0, -15)) {
      if (!this.playbackStartedValue && this.startupRowsValue?.some((row) => row.seq === Number(oldName.slice(8, 16)))) continue;
      await import('node:fs/promises').then(({ rm }) => rm(join(this.options.sessionDirectory, oldName), { force: true })).catch(() => undefined);
      this.processed.delete(oldName);
    }
    if (total > (this.options.maxDiskBytes ?? 128 * 1024 * 1024)) {
      void this.fail('disk-limit');
    }
  }
  private updateMediaStarts(playlist: string): void {
    const rows = this.playlistRows(playlist);
    if (!rows.length) return;
    const first = rows[0];
    if (!first) return;
    if (!this.mediaStarts.has(first.seq)) {
      const prevStart = this.mediaStarts.get(first.seq - 1);
      const prevDuration = this.mediaDurations.get(first.seq - 1);
      this.mediaStarts.set(first.seq, prevStart !== undefined && prevDuration !== undefined ? prevStart + prevDuration : first.seq === 0 ? 0 : first.seq * first.duration);
    }
    for (let index = 0; index < rows.length; index++) {
      const row = rows[index];
      if (!row || this.mediaStarts.has(row.seq)) continue;
      const previous = rows[index - 1];
      const previousStart = previous ? this.mediaStarts.get(previous.seq) : undefined;
      this.mediaStarts.set(row.seq, previous && previousStart !== undefined ? previousStart + previous.duration : row.seq * row.duration);
    }
    for (const row of rows) this.mediaDurations.set(row.seq, row.duration);
    for (const seq of this.mediaStarts.keys()) if (seq < first.seq - 1) this.mediaStarts.delete(seq);
    for (const seq of this.mediaDurations.keys()) if (seq < first.seq - 1) this.mediaDurations.delete(seq);
  }
  private playlistRows(playlist: string): Array<{ seq: number; duration: number }> {
    const rows: Array<{ seq: number; duration: number }> = [];
    let duration: number | undefined;
    for (const line of playlist.split(/\r?\n/)) {
      if (line.startsWith('#EXTINF:')) {
        const parsed = Number(line.slice(8).split(',', 1)[0]);
        duration = Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
      } else if (line && !line.startsWith('#')) {
        const name = line.trim().split(/[?#]/, 1)[0] ?? '';
        if (/^segment-\d{8}\.ts$/.test(name) && duration !== undefined) rows.push({ seq: Number(name.slice(8, 16)), duration });
        duration = undefined;
      }
    }
    return rows;
  }
  async playlist(): Promise<string> { return this.lastPlaylist; }
  async startupPlaylist(): Promise<string | undefined> {
    if (this.playbackStartedValue || !this.startupRowsValue) return undefined;
    const sequence = this.startupRowsValue[0]!.seq;
    const targetDuration = Math.max(1, ...this.startupRowsValue.map((row) => Math.ceil(row.duration)));
    const rows = this.startupRowsValue.map((row) => `#EXTINF:${row.duration.toFixed(3)},\nsegment-${String(row.seq).padStart(8, '0')}.ts`).join('\n');
    return `#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:${targetDuration}\n#EXT-X-MEDIA-SEQUENCE:${sequence}\n${rows}\n`;
  }
  markPlaybackStarted(): void { this.playbackStartedValue = true; }
  async segment(name: string): Promise<Uint8Array | undefined> {
    if (!/^segment-\d{8}\.ts$/.test(name)) return undefined;
    try { return await readFile(join(this.options.sessionDirectory, name)); } catch { return undefined; }
  }
  async stop(): Promise<void> {
    if (this.stopping) return this.stopping;
    this.stopped = true;
    if (this.currentState !== 'failed') this.currentState = 'stopped';
    if (this.poller) clearInterval(this.poller);
    this.stopping = (async () => {
      this.upstream?.destroy();
      if (this.child?.stdin && !this.child.stdin.destroyed) this.child.stdin.destroy();
      const child = this.child;
      if (child && child.exitCode === null && child.signalCode === null) {
        child.kill('SIGTERM');
        const exitedAfterTerm = await waitForChildExit(child, this.childExit, 2_000);
        if (!exitedAfterTerm) {
          child.kill('SIGKILL');
          if (!await waitForChildExit(child, this.childExit, 2_000)) throw new Error('worker_shutdown_timeout');
        }
      }
      await this.pump?.catch(() => undefined);
      await this.pollTask?.catch(() => undefined);
      this.processor.dispose();
    })();
    return this.stopping;
  }
  async markFailed(): Promise<void> { this.currentState = 'failed'; await this.stop(); this.currentState = 'failed'; }
}

function waitForChildExit(child: ChildProcess, exit: Promise<void> | undefined, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  if (!exit) return Promise.resolve(false);
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([exit.then(() => true), new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(false), timeoutMs); timer.unref(); })])
    .finally(() => { if (timer) clearTimeout(timer); });
}

/** Production stream-copy muxer arguments shared with the offline smoke test. */
export function relayFfmpegArgs(sessionDirectory: string): string[] {
  const playlistPath = join(sessionDirectory, 'index.m3u8');
  const segmentPath = join(sessionDirectory, 'segment-%08d.ts');
  return [
      '-hide_banner', '-loglevel', 'error', '-nostdin', '-i', 'pipe:0', '-map', '0', '-c', 'copy',
      // Sparse DVB packets must not hold video/audio in the muxer's default
      // ten-second interleave queue. Flush at one second without dropping streams.
      '-max_interleave_delta', '1000000',
      '-f', 'segment', '-segment_format', 'mpegts', '-segment_time', '4', '-segment_list_size', '15',
      '-segment_list_flags', '+live', '-segment_list_type', 'm3u8', '-segment_list', playlistPath, segmentPath,
  ];
}

export class FfmpegRelayWorkerFactory implements RelayWorkerFactory {
  private options: { ffmpegPath?: string; segmentObserver?: (bytes: Uint8Array, name: string) => void | Promise<void>; allowedRedirectHosts?: readonly string[]; openUpstream?: (url: string) => Promise<IncomingMessage> };
  constructor(options: { ffmpegPath?: string; segmentObserver?: (bytes: Uint8Array, name: string) => void | Promise<void>; allowedRedirectHosts?: readonly string[]; openUpstream?: (url: string) => Promise<IncomingMessage> } = {}) { this.options = options; }
  async create(options: CreateWorkerOptions): Promise<RelayWorker> {
    const worker = new FfmpegRelayWorker({ ...options, ...this.options });
    await worker.start();
    return worker;
  }
}
