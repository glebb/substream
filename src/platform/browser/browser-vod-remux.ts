import { VOD_REMUX_AUDIO_MIME_CODECS, VOD_REMUX_AUDIO_LABELS, type VodRemuxAudioCodec, type VodRemuxAudioLabel, VOD_REMUX_MAX_CHUNK_BYTES, type VodRemuxWorkerRequest, type VodRemuxWorkerResponse } from "./vod-remux-protocol.ts";
import type { AudioTrack } from "../media-player.ts";

const FORWARD_BUFFER_SECONDS = 30;
const BACK_BUFFER_SECONDS = 30;
const STARTUP_BUFFER_SECONDS = 3;
// WebKit initially budgets a buffer as audio-only until it parses the video
// initialization segment. A worker chunk may include that segment plus a large
// fragment, so feed the parser in smaller pieces even before metadata arrives.
const APPEND_CHUNK_BYTES = 512 * 1024;
const MIN_APPEND_CHUNK_BYTES = 16 * 1024;

type MediaSourceConstructor = typeof MediaSource;
type ManagedSource = MediaSource & { streaming?: boolean };
interface RemuxWorker {
  postMessage(message: VodRemuxWorkerRequest): void;
  addEventListener(type: "message" | "error", listener: EventListener): void;
  removeEventListener(type: "message" | "error", listener: EventListener): void;
  terminate(): void;
}
export type BrowserVodRemuxFailure = "cors-range" | "provider-redirect" | "provider-timeout" | "range-unsupported" | "range-metadata" | "range-invalid" | "unsupported-video" | "unsupported-audio" | "invalid-media" | "processing-failed" | "browser-unsupported" | "buffer-failed";
export interface BrowserVodRemuxOptions {
  onReady(): void;
  onError(reason: BrowserVodRemuxFailure, audioCodec?: VodRemuxAudioLabel): void;
  onAudioTracksChange?(tracks: AudioTrack[]): void;
  mediaSourceConstructor?: MediaSourceConstructor;
  workerFactory?: () => RemuxWorker;
}

function sourceConstructor(): MediaSourceConstructor | undefined {
  const scope = globalThis as typeof globalThis & { ManagedMediaSource?: MediaSourceConstructor };
  return scope.ManagedMediaSource ?? scope.MediaSource;
}

export function canRemuxBrowserVod(): boolean {
  return typeof Worker === "function" && !!sourceConstructor() && typeof URL.createObjectURL === "function";
}

/** Device-local worker output only; this class never sends a provider URL to a server. */
export class BrowserVodRemuxSession {
  private worker: RemuxWorker | undefined;
  private source: ManagedSource | undefined;
  private buffer: SourceBuffer | undefined;
  private objectUrl: string | undefined;
  private pendingChunk: ArrayBuffer | undefined;
  private queuedChunk: ArrayBuffer | undefined;
  private pendingChunkCredited = false;
  private workerPhase = "starting";
  private pendingOffset = 0;
  private appendChunkBytes = APPEND_CHUNK_BYTES;
  private awaitingAck = false;
  private removing = false;
  private ended = false;
  private failed = false;
  private wantsData = true;
  private readyReported = false;
  private audioProcessing = "pending";
  private generation = 0;
  private startSeconds = 0;
  private seekApplied = false;
  private callbacks: Array<() => void> = [];
  private previousRemotePlayback: boolean | undefined;
  private sourceUrl: string | undefined;
  private audioTrackId: number | undefined;
  private audioTracks: AudioTrack[] = [];
  private playbackCodecs: { videoCodec?: string; audioCodec?: string } = {};
  private bufferOperation = "buffer setup";
  private appendCount = 0;
  private failureDiagnostics = "";

  constructor(private readonly video: HTMLVideoElement, private readonly options: BrowserVodRemuxOptions) {}

  start(url: string, seconds = 0): void {
    this.release();
    this.sourceUrl = url;
    this.startSeconds = Number.isFinite(seconds) ? Math.max(0, seconds) : 0;
    this.seekApplied = this.startSeconds === 0;
    this.failed = false;
    this.ended = false;
    this.wantsData = true;
    this.readyReported = false;
    this.audioProcessing = "pending";
    this.bufferOperation = "buffer setup";
    this.appendCount = 0;
    this.appendChunkBytes = APPEND_CHUNK_BYTES;
    this.failureDiagnostics = "";
    this.workerPhase = "starting";
    const generation = ++this.generation;
    const Constructor = this.options.mediaSourceConstructor ?? sourceConstructor();
    if (!Constructor) { this.fail("browser-unsupported"); return; }
    try {
      this.previousRemotePlayback = this.video.disableRemotePlayback;
      // WebKit only opens ManagedMediaSource with an AirPlay alternative or
      // remote playback disabled. Keep this choice scoped to the remux session.
      this.video.disableRemotePlayback = true;
      const source = new Constructor();
      this.source = source;
      const listen = (target: EventTarget, type: string, handler: EventListener) => {
        target.addEventListener(type, handler);
        this.callbacks.push(() => target.removeEventListener(type, handler));
      };
      listen(source, "sourceopen", () => {
        if (generation !== this.generation || this.worker || this.failed) return;
        try {
          const worker = this.options.workerFactory?.() ?? new Worker(new URL("./vod-remux.worker.ts", import.meta.url), { type: "module" });
          this.worker = worker;
          const onMessage: EventListener = (event) => {
            if (generation !== this.generation || this.failed) return;
            this.receive((event as MessageEvent<VodRemuxWorkerResponse>).data, Constructor);
          };
          const onError: EventListener = () => { if (generation === this.generation) this.fail("processing-failed"); };
          worker.addEventListener("message", onMessage);
          worker.addEventListener("error", onError);
          this.callbacks.push(() => { worker.removeEventListener("message", onMessage); worker.removeEventListener("error", onError); });
          const supportedAudioCodecs = (Object.keys(VOD_REMUX_AUDIO_MIME_CODECS) as VodRemuxAudioCodec[]).filter((codec) => {
            try { return Constructor.isTypeSupported(`audio/mp4; codecs="${VOD_REMUX_AUDIO_MIME_CODECS[codec]}"`); } catch { return false; }
          });
          worker.postMessage({ type: "start", url, startSeconds: this.startSeconds, supportedAudioCodecs, ...(this.audioTrackId !== undefined ? { audioTrackId: this.audioTrackId } : {}) });
        } catch { this.fail("processing-failed"); }
      });
      listen(source, "startstreaming", () => { this.wantsData = true; this.pump(); });
      listen(source, "endstreaming", () => {
        this.wantsData = false;
        // ManagedMediaSource may choose a smaller startup buffer than ours.
        // Begin playback with what it retained rather than wait for another refill.
        this.reportReady(true);
        this.pump();
      });
      listen(this.video, "timeupdate", () => this.pump());
      listen(this.video, "playing", () => this.pump());
      listen(this.video, "waiting", () => this.pump());
      listen(this.video, "loadedmetadata", () => this.applySeek());
      this.objectUrl = URL.createObjectURL(source);
      this.video.src = this.objectUrl;
      this.video.load();
    } catch { this.fail("browser-unsupported"); }
  }

  seek(seconds: number): void {
    if (this.sourceUrl) this.start(this.sourceUrl, seconds);
  }

  getPlaybackCodecs() { return { ...this.playbackCodecs }; }

  getAudioTracks(): AudioTrack[] { return this.audioTracks.map((track) => ({ ...track })); }

  selectAudioTrack(id: string): boolean {
    if (!this.sourceUrl || !this.audioTracks.some((track) => track.id === id)) return false;
    this.audioTrackId = Number(id.replace(/^remux:/, ""));
    this.seek(this.video.currentTime);
    return true;
  }

  private receive(message: VodRemuxWorkerResponse, Constructor: MediaSourceConstructor): void {
    if (!message || typeof message !== "object") { this.fail("processing-failed"); return; }
    if (message.type === "error") {
      const safeReasons = ["cors-range", "provider-redirect", "provider-timeout", "range-unsupported", "range-metadata", "range-invalid", "unsupported-video", "unsupported-audio", "invalid-media", "processing-failed"] as const;
      this.fail(safeReasons.includes(message.reason) ? message.reason : "processing-failed", message.reason === "unsupported-audio" && VOD_REMUX_AUDIO_LABELS.includes(message.audioCodec!) ? message.audioCodec : undefined);
    } else if (message.type === "metadata") {
      this.workerPhase = "remuxing";
      if (this.buffer || !this.source || this.source.readyState !== "open"
        || typeof message.mimeType !== "string" || message.mimeType.length > 200
        || !/^video\/mp4; codecs="[a-zA-Z0-9., -]+"$/.test(message.mimeType)
        || !Constructor.isTypeSupported(message.mimeType)) { this.fail("browser-unsupported"); return; }
      try {
        const codecs = message.mimeType.match(/codecs="([^"]+)"/)?.[1]?.split(",").map((value) => value.trim()) ?? [];
        this.playbackCodecs = { ...(codecs[0] ? { videoCodec: codecs[0] } : {}), ...(codecs[1] ? { audioCodec: codecs[1] } : {}) };
        this.buffer = this.source.addSourceBuffer(message.mimeType);
        const onUpdate: EventListener = () => {
          if (this.failed) return;
          this.removing = false;
          this.applySeek();
          this.reportReady(!this.wantsData || this.ended);
          this.pump();
        };
        const onError: EventListener = () => this.failBuffer("asynchronous parser error");
        const buffer = this.buffer;
        buffer.addEventListener("updateend", onUpdate);
        buffer.addEventListener("error", onError);
        buffer.addEventListener("bufferedchange", onUpdate);
        this.callbacks.push(() => { buffer.removeEventListener("updateend", onUpdate); buffer.removeEventListener("error", onError); buffer.removeEventListener("bufferedchange", onUpdate); });
        this.bufferOperation = "duration setup";
        if (message.durationSeconds !== null && Number.isFinite(message.durationSeconds) && message.durationSeconds > 0) this.source.duration = message.durationSeconds;
        if (Array.isArray(message.audioTracks) && message.audioTracks.length <= 12) {
          this.audioTracks = message.audioTracks.filter((track) => Number.isSafeInteger(track.id)).map((track, index) => ({
            id: `remux:${track.id}`, label: `Audio ${index + 1}`,
            language: /^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8}){0,2}$/.test(track.language) ? track.language : "und",
            selected: track.id === message.selectedAudioTrackId,
          }));
          this.options.onAudioTracksChange?.(this.getAudioTracks());
        }
        this.audioProcessing = message.audioProcessing === "dolby-to-aac" ? "Dolby → AAC" : "copy";
        // Start only after a small playable cushion has been appended.
      } catch (error) { this.failBuffer("operation rejected", error); }
    } else if (message.type === "progress") {
      if (["downloading", "remuxing", "waiting"].includes(message.phase)) this.workerPhase = message.phase;
    } else if (message.type === "chunk") {
      if (!(message.buffer instanceof ArrayBuffer) || message.buffer.byteLength === 0
        || message.buffer.byteLength > VOD_REMUX_MAX_CHUNK_BYTES || (this.pendingChunk && (!this.pendingChunkCredited || this.queuedChunk)) || this.awaitingAck || !this.buffer) {
        this.bufferOperation = "worker chunk validation";
        this.failBuffer("invalid chunk"); return;
      }
      if (this.pendingChunk) this.queuedChunk = message.buffer;
      else this.pendingChunk = message.buffer;
      this.pump();
    } else if (message.type === "end") {
      this.workerPhase = "finished";
      this.ended = true;
      this.reportReady(true);
      this.pump();
    }
  }

  private bufferedAhead(): number {
    const playhead = this.seekApplied ? this.video.currentTime : this.startSeconds;
    const ranges = this.buffer?.buffered;
    if (!ranges) return 0;
    for (let index = 0; index < ranges.length; index++) {
      if (playhead >= ranges.start(index) - 0.05 && playhead <= ranges.end(index)) {
        return Math.max(0, ranges.end(index) - playhead);
      }
    }
    return 0;
  }

  private reportReady(allowShortBuffer = false): void {
    if (this.readyReported || this.failed || !this.buffer) return;
    const ahead = this.bufferedAhead();
    const remaining = this.source && Number.isFinite(this.source.duration)
      ? Math.max(0, this.source.duration - this.startSeconds) : STARTUP_BUFFER_SECONDS;
    if (ahead > 0 && (allowShortBuffer || ahead >= Math.min(STARTUP_BUFFER_SECONDS, remaining))) {
      this.readyReported = true;
      this.options.onReady();
    }
  }

  getBufferDiagnostics(): string {
    if (this.failureDiagnostics) return this.failureDiagnostics;
    return `Buffer: ${this.bufferedAhead().toFixed(1)}s · Refill: ${this.wantsData ? "active" : "managed pause"} · Audio: ${this.audioProcessing} · Pending: ${this.pendingChunk ? `${Math.ceil((this.pendingChunk.byteLength - this.pendingOffset + (this.queuedChunk?.byteLength ?? 0)) / 1024)} KiB` : "none"} · Appends: ${this.appendCount} · Worker: ${this.workerPhase}`;
  }

  private applySeek(): void {
    if (this.seekApplied || this.video.readyState < 1 || !this.buffer?.buffered.length) return;
    try {
      const ranges = this.buffer.buffered;
      for (let index = 0; index < ranges.length; index++) {
        if (this.startSeconds >= ranges.start(index) && this.startSeconds <= ranges.end(index)) {
          this.video.currentTime = this.startSeconds;
          this.seekApplied = true;
          break;
        }
      }
    } catch { /* Wait for more buffered data. */ }
  }

  private pump(): void {
    const buffer = this.buffer;
    const source = this.source;
    if (this.failed || !buffer || !source || source.readyState !== "open" || buffer.updating) return;
    try {
      const playhead = this.seekApplied ? this.video.currentTime : this.startSeconds;
      const ranges = buffer.buffered;
      if (!this.removing && ranges.length && ranges.start(0) < playhead - BACK_BUFFER_SECONDS - 1) {
        this.removing = true;
        this.bufferOperation = "back buffer removal";
        buffer.remove(0, Math.max(0, playhead - BACK_BUFFER_SECONDS));
        return;
      }
      // A managed pause can last most of a GOP. Let the worker prepare one
      // additional chunk while the first is held, instead of waiting until
      // refill resumes to start fetching it. At most two 8 MiB chunks are held;
      // partially appended chunks retain their original credit until complete.
      if (!this.wantsData && this.readyReported && this.pendingChunk
        && this.pendingOffset === 0 && !this.pendingChunkCredited && !this.awaitingAck
        && !this.queuedChunk && this.bufferedAhead() < FORWARD_BUFFER_SECONDS) {
        this.pendingChunkCredited = true;
        this.worker?.postMessage({ type: "ack" });
      }
      if (this.pendingChunk && (this.wantsData || !this.readyReported)) {
        const chunk = this.pendingChunk;
        // Commit the byte offset only when appendBuffer accepts the piece.
        // Quota rejection is synchronous; retry exactly those unconsumed bytes
        // with a smaller piece, never abort/reset the partially fed MP4 parser.
        for (;;) {
          const end = Math.min(chunk.byteLength, this.pendingOffset + this.appendChunkBytes);
          const piece = chunk.slice(this.pendingOffset, end);
          this.bufferOperation = this.appendCount === 0 ? "initial append" : "media append";
          this.appendCount++;
          try { buffer.appendBuffer(piece); }
          catch (error) {
            if (error && typeof error === "object" && "name" in error && error.name === "QuotaExceededError"
              && piece.byteLength > MIN_APPEND_CHUNK_BYTES) {
              this.appendChunkBytes = Math.max(MIN_APPEND_CHUNK_BYTES, Math.floor(piece.byteLength / 2));
              continue;
            }
            throw error;
          }
          this.pendingOffset = end;
          this.awaitingAck = !this.pendingChunkCredited;
          if (end === chunk.byteLength) {
            this.pendingChunk = this.queuedChunk;
            this.queuedChunk = undefined;
            this.pendingChunkCredited = false;
            this.pendingOffset = 0;
          }
          break;
        }
        return;
      }
      const ahead = this.bufferedAhead();
      // Release one credit after append even when managed streaming is paused.
      // The next bounded chunk is prepared in advance and held until the browser
      // requests data; no further credit is issued while that chunk is pending.
      if (this.awaitingAck && !this.pendingChunk && ahead < FORWARD_BUFFER_SECONDS) {
        this.awaitingAck = false;
        this.worker?.postMessage({ type: "ack" });
      }
      if (this.ended && !this.awaitingAck && !this.pendingChunk) {
        this.bufferOperation = "end of stream";
        source.endOfStream();
      }
    } catch (error) { this.failBuffer("operation rejected", error); }
  }

  private failBuffer(detail: string, error?: unknown): void {
    if (this.failed) return;
    // Never expose exception messages: browser errors can contain media URLs.
    const name = error && typeof error === "object" && "name" in error ? error.name : undefined;
    const safeName = typeof name === "string" && ["QuotaExceededError", "InvalidStateError", "NotSupportedError", "TypeError", "RangeError"].includes(name) ? name : undefined;
    const mediaError = ["none", "aborted", "network", "decode", "unsupported source"][this.video.error?.code ?? 0] ?? "unknown";
    let ahead = "unavailable";
    try { ahead = `${this.bufferedAhead().toFixed(1)}s`; } catch { /* A detached buffer may reject inspection too. */ }
    this.failureDiagnostics = `Buffer: ${ahead} · Refill: stopped · Audio: ${this.audioProcessing} · Failed: ${this.bufferOperation} (${detail}${safeName ? `; ${safeName}` : ""}; media ${mediaError}) · Appends: ${this.appendCount} · Codecs: ${this.playbackCodecs.videoCodec ?? "unknown"}, ${this.playbackCodecs.audioCodec ?? "unknown"}`;
    this.fail("buffer-failed");
  }

  private fail(reason: BrowserVodRemuxFailure, audioCodec?: VodRemuxAudioLabel): void {
    if (this.failed) return;
    this.failed = true;
    const codecs = this.playbackCodecs;
    this.release();
    this.playbackCodecs = codecs;
    this.options.onError(reason, audioCodec);
  }

  private release(): void {
    this.playbackCodecs = {};
    this.generation++;
    for (const remove of this.callbacks.splice(0)) remove();
    this.worker?.terminate();
    this.worker = undefined;
    this.buffer = undefined;
    this.source = undefined;
    this.pendingChunk = undefined;
    this.queuedChunk = undefined;
    this.pendingChunkCredited = false;
    this.pendingOffset = 0;
    this.awaitingAck = false;
    this.removing = false;
    if (this.objectUrl) {
      if (this.video.src === this.objectUrl) {
        this.video.pause();
        this.video.removeAttribute("src");
        this.video.load();
      }
      URL.revokeObjectURL(this.objectUrl);
      this.objectUrl = undefined;
    }
    if (this.previousRemotePlayback !== undefined) this.video.disableRemotePlayback = this.previousRemotePlayback;
    this.previousRemotePlayback = undefined;
  }

  stop(): void { this.release(); }
  dispose(): void { this.release(); this.sourceUrl = undefined; this.audioTracks = []; }
}
