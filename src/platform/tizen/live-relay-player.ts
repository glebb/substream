import type { AudioTrack, EmbeddedSubtitleTrack, MediaPlayer, MediaPlayerEventHandlers, PlaybackProgress, PlaybackState, SubtitleAttachment, VideoDisplayMode } from "../media-player.ts";
import { RelayCueScheduler } from "../../core/live-relay/scheduler.ts";
import type { RelayCue, RelayCueBatch, RelaySessionStatus, RelaySubtitleLanguage } from "../../core/live-relay/protocol.ts";
import { createLiveRelaySession, type LiveRelaySession } from "../live-relay/client.ts";
import type { LiveRelayConfig } from "../live-relay/config.ts";
import { TizenAvPlayPlayer } from "./avplay-player.ts";

const READY_TIMEOUT_MS = 30_000;
const STATUS_INTERVAL_MS = 2_000;
const HEARTBEAT_INTERVAL_MS = 20_000;
const MAX_IMAGES = 32;
const MAX_DECODED_IMAGE_BYTES = 4 * 1024 * 1024;
const MAX_IMAGE_DIMENSION = 1920;
const MAX_IMAGE_REQUESTS = 2;
const MAX_QUEUED_IMAGES = 32;
const IMAGE_LOAD_TIMEOUT_MS = 5_000;
const RELAY_BUFFER_SECONDS = 8;

export interface TizenLiveRelayPlayerOptions {
  preferredLanguage?: RelaySubtitleLanguage;
  /**
   * Experimental media-timeline minus AVPlay-playhead offset, in milliseconds.
   * Defaults to zero as a provisional value; this is not a measured mapping.
   */
  mediaToPlayheadOffsetMs?: number;
  prepareTimeoutMs?: number;
  cuePollIntervalMs?: number;
  imageLoadTimeoutMs?: number;
  onSubtitleCue?: (text: string) => void;
}

interface CachedImage { image: HTMLImageElement; decodedBytes: number; }
interface PendingImage { image: HTMLImageElement; timer: ReturnType<typeof setTimeout>; cancel(): void; }
interface CancelToken { cancelled: boolean; listeners: Set<() => void>; }

/** Tizen 3 adapter that composes hosted relay HLS with a PNG sideband overlay. */
export class TizenLiveRelayPlayer implements MediaPlayer {
  private readonly inner: TizenAvPlayPlayer;
  private readonly scheduler = new RelayCueScheduler();
  private readonly overlay: HTMLDivElement;
  private readonly images = new Map<string, CachedImage>();
  private readonly pendingImages = new Map<string, PendingImage>();
  private readonly queuedImages = new Map<string, RelayCue>();
  private offsetMs: number;
  private readonly readyTimeoutMs: number;
  private readonly cuePollIntervalMs: number;
  private readonly imageLoadTimeoutMs: number;
  private readonly onSubtitleCue: (text: string) => void;
  private handlers: MediaPlayerEventHandlers | null = null;
  private session: LiveRelaySession | undefined;
  private started = false;
  private disposed = false;
  private generation = 0;
  private statusTimer: ReturnType<typeof setTimeout> | undefined;
  private heartbeatTimer: ReturnType<typeof setTimeout> | undefined;
  private currentPlayheadMs = 0;
  private bufferEvents = 0;
  private activeCue: RelayCue | null = null;
  private imagesDecodedBytes = 0;
  private enabled = true;
  private selectedRelayTrackId: string | null = null;
  private serverSelectedRelayTrackId: string | null = null;
  private manuallyDisabled = false;
  private offRequestSent = false;
  private selectionVersion = 0;
  private selectionPending: { trackId: string | null; promise: Promise<boolean> } | undefined;
  private selectionChain: Promise<void> = Promise.resolve();
  private controlChain: Promise<void> = Promise.resolve();
  private activeControlCancelToken: CancelToken | undefined;
  private autoSelectionAttempted = false;
  private relayTracks: EmbeddedSubtitleTrack[] = [];
  private lastStatus: RelaySessionStatus | undefined;
  private starting: Promise<void> | undefined;
  private closing: Promise<void> | undefined;
  private sessionDisposal: Promise<void> | undefined;
  private playbackStarted = false;
  private playbackStartedAck: "idle" | "pending" | "confirmed" | "failed" = "idle";
  private playbackStartedAckAttempts = 0;
  private playbackStartedAckTimer: ReturnType<typeof setTimeout> | undefined;
  private pendingStartupEpoch: number | undefined;
  private timingInvalidated = false;
  private cueGeneration = 0;
  private readonly overlayReposition = () => this.positionOverlay();

  constructor(
    container: HTMLElement,
    private readonly relayConfig: LiveRelayConfig,
    private readonly channelId: string,
    private readonly options: TizenLiveRelayPlayerOptions = {},
  ) {
    this.offsetMs = options.mediaToPlayheadOffsetMs ?? 0;
    if (!Number.isFinite(this.offsetMs) || Math.abs(this.offsetMs) > 24 * 60 * 60 * 1000) throw new Error("Live subtitle timing offset is invalid.");
    this.readyTimeoutMs = boundedInteger(options.prepareTimeoutMs ?? READY_TIMEOUT_MS, 1_000, READY_TIMEOUT_MS);
    this.cuePollIntervalMs = boundedInteger(options.cuePollIntervalMs ?? 500, 250, 5_000);
    this.imageLoadTimeoutMs = boundedInteger(options.imageLoadTimeoutMs ?? IMAGE_LOAD_TIMEOUT_MS, 250, 15_000);
    this.onSubtitleCue = options.onSubtitleCue ?? (() => {});
    this.overlay = document.createElement("div");
    this.overlay.setAttribute("aria-hidden", "true");
    Object.assign(this.overlay.style, {
      position: "fixed", top: "0", left: "0", width: "0", height: "0", overflow: "hidden",
      pointerEvents: "none", zIndex: "2147483000", margin: "0", padding: "0", border: "0", display: "none",
    });
    document.body.appendChild(this.overlay);
    window.addEventListener("resize", this.overlayReposition);
    window.addEventListener("scroll", this.overlayReposition, true);
    this.overlayAnchor = container;
    this.positionOverlay();
    this.inner = new TizenAvPlayPlayer(container, this.onSubtitleCue, { bufferSeconds: RELAY_BUFFER_SECONDS });
    this.inner.setEventHandlers({
      onStateChange: (state) => {
        if (state === "buffering") this.bufferEvents++;
        this.handlers?.onStateChange(state);
      },
      onProgress: (progress) => this.handleProgress(progress),
      onLiveBufferWindowChange: (window) => this.handlers?.onLiveBufferWindowChange?.(window),
      onAudioTracksChange: (tracks) => this.handlers?.onAudioTracksChange?.(tracks),
      onEmbeddedSubtitleTracksChange: () => this.emitTracks(),
    });
  }
  private readonly overlayAnchor: HTMLElement;

  /** Creates a relay session, waits for bounded preparation, then opens AVPlay. */
  start(): Promise<void> {
    if (this.starting) return this.starting;
    if (this.disposed) throw new Error("Live subtitle relay player is closed.");
    if (this.started) return Promise.resolve();
    this.started = true;
    const generation = ++this.generation;
    this.starting = this.startSession(generation);
    return this.starting;
  }

  private async startSession(generation: number): Promise<void> {
    try {
      const session = await createLiveRelaySession(this.relayConfig, this.channelId, this.options.preferredLanguage);
      if (!this.isCurrent(generation)) {
        this.session = session;
        await this.disposeSession();
        return;
      }
      this.session = session;
      const deadline = Date.now() + this.readyTimeoutMs;
      let status = await session.status();
      while (status.state === "preparing" && Date.now() < deadline) {
        await delay(Math.min(500, Math.max(0, deadline - Date.now())));
        if (!this.isCurrent(generation)) return;
        status = await session.status();
      }
      if (!this.isCurrent(generation)) return;
      if (status.state !== "ready") throw new Error("Live subtitle relay did not become ready.");
      await this.applyStatus(status, generation);
      if (!this.isCurrent(generation)) return;
      this.inner.setLiveSubtitleMode(true);
      this.inner.load(session.mediaUrl);
      session.startCuePolling((batch) => {
        if (!this.isCurrent(generation)) return;
        this.acceptCueBatch(batch);
      }, () => undefined, this.cuePollIntervalMs);
      this.scheduleStatus(generation, STATUS_INTERVAL_MS);
      this.scheduleHeartbeat(generation, HEARTBEAT_INTERVAL_MS);
    } catch (error) {
      if (this.isCurrent(generation)) {
        this.handlers?.onStateChange("error");
        await this.disposeSession();
      }
      throw error instanceof Error ? sanitizeError(error) : new Error("Could not start live subtitle relay playback.");
    }
  }

  private isCurrent(generation: number): boolean { return !this.disposed && generation === this.generation; }

  private async applyStatus(status: RelaySessionStatus, generation: number): Promise<void> {
    this.lastStatus = status;
    const previousServerSelection = this.serverSelectedRelayTrackId;
    const serverSelectionChanged = previousServerSelection !== status.selectedTrackId;
    this.serverSelectedRelayTrackId = status.selectedTrackId;
    if (this.manuallyDisabled) this.selectedRelayTrackId = null;
    else if (!this.selectionPending) this.selectedRelayTrackId = status.selectedTrackId;
    this.relayTracks = status.tracks.map((track) => ({
      id: `relay:${track.id}`, label: `${track.label} · Relay`, language: track.language,
      selected: !this.manuallyDisabled && (this.selectionPending?.trackId ?? this.selectedRelayTrackId) === track.id,
    }));
    if (!this.manuallyDisabled && !this.selectionPending && serverSelectionChanged) this.resetCueState(true);
    this.emitTracks();
    if (this.selectedRelayTrackId !== null && this.serverSelectedRelayTrackId !== this.selectedRelayTrackId) return;
    if (this.manuallyDisabled) {
      if (status.selectedTrackId !== null && !this.selectionPending && !this.offRequestSent) await this.selectRelayTrack(null, generation, true);
      return;
    }
    if (this.autoSelectionAttempted) return;
    const preferredLanguage = this.options.preferredLanguage ?? "fi";
    const fallbackLanguage = preferredLanguage === "fi" ? "en" : "fi";
    const preferred = this.relayTracks.find((track) => isLanguage(track.language, preferredLanguage))
      ?? this.relayTracks.find((track) => isLanguage(track.language, fallbackLanguage));
    if (!preferred || status.selectedTrackId === preferred.id.slice("relay:".length)) { this.autoSelectionAttempted = this.relayTracks.length > 0; return; }
    this.autoSelectionAttempted = true;
    await this.selectRelayTrack(preferred.id.slice("relay:".length), generation);
  }

  private scheduleStatus(generation: number, interval: number): void {
    this.statusTimer = setTimeout(async () => {
      const session = this.session;
      if (!session || !this.isCurrent(generation)) return;
      try {
        const status = await this.runControlRequest(generation, (cancelToken) => session.status({ cancelToken }));
        if (!this.isCurrent(generation)) return;
        if (status) {
          if (status.state === "failed") { this.clearOverlay(); this.handlers?.onStateChange("error"); return; }
          await this.applyStatus(status, generation);
        }
      } catch { /* Relay captions are optional; keep AVPlay video running. */ }
      if (this.isCurrent(generation)) this.scheduleStatus(generation, interval);
    }, interval);
  }

  private scheduleHeartbeat(generation: number, interval: number): void {
    this.heartbeatTimer = setTimeout(async () => {
      const session = this.session;
      if (!session || !this.isCurrent(generation)) return;
      try { await this.runControlRequest(generation, (cancelToken) => session.heartbeat({ cancelToken })); }
      catch { /* Lease errors do not interrupt active video. */ }
      if (this.isCurrent(generation)) this.scheduleHeartbeat(generation, interval);
    }, interval);
  }

  private runControlRequest<T>(generation: number, request: (cancelToken: CancelToken) => Promise<T>): Promise<T | undefined> {
    const cancelToken: CancelToken = { cancelled: false, listeners: new Set() };
    const operation = this.controlChain.catch(() => undefined).then(async () => {
      if (!this.isCurrent(generation) || cancelToken.cancelled) return undefined;
      this.activeControlCancelToken = cancelToken;
      try { return await request(cancelToken); }
      finally { if (this.activeControlCancelToken === cancelToken) this.activeControlCancelToken = undefined; }
    });
    this.controlChain = operation.then(() => undefined, () => undefined);
    return operation;
  }

  private ensureAnchor(epoch: number): void {
    if (!Number.isSafeInteger(epoch) || epoch < 1 || this.timingInvalidated) return;
    if (this.schedulerEpoch !== undefined && epoch !== this.schedulerEpoch) {
      this.invalidateTiming();
      return;
    }
    if (this.schedulerEpoch === epoch) return;
    this.schedulerEpoch = epoch;
    this.scheduler.setAnchor({ epoch, mediaMs: this.currentPlayheadMs - this.offsetMs, playheadMs: this.currentPlayheadMs });
    this.activeCue = null;
    this.clearOverlay();
  }
  private schedulerEpoch: number | undefined;

  private handleProgress(progress: PlaybackProgress): void {
    this.currentPlayheadMs = Number.isFinite(progress.currentTimeSeconds) ? progress.currentTimeSeconds * 1_000 : this.currentPlayheadMs;
    if (!this.playbackStarted && Number.isFinite(progress.currentTimeSeconds) && progress.currentTimeSeconds >= 0) {
      this.playbackStarted = true;
      const generation = this.generation;
      this.playbackStartedAck = "pending";
      this.sendPlaybackStartedAck(generation);
      if (this.pendingStartupEpoch !== undefined) this.ensureAnchor(this.pendingStartupEpoch);
    }
    this.handlers?.onProgress?.(progress);
    this.renderAtPlayhead();
  }

  private sendPlaybackStartedAck(generation: number): void {
    const session = this.session;
    if (!session || !this.isCurrent(generation) || this.playbackStartedAck === "confirmed") return;
    this.playbackStartedAckAttempts++;
    void session.markPlaybackStarted().then(() => {
      if (!this.isCurrent(generation)) return;
      this.playbackStartedAck = "confirmed";
      if (this.playbackStartedAckTimer !== undefined) clearTimeout(this.playbackStartedAckTimer);
      this.playbackStartedAckTimer = undefined;
    }).catch(() => {
      if (!this.isCurrent(generation)) return;
      if (this.playbackStartedAckAttempts >= 4) {
        this.playbackStartedAck = "failed";
        return;
      }
      const delays = [500, 1_500, 3_000];
      this.playbackStartedAckTimer = setTimeout(() => {
        this.playbackStartedAckTimer = undefined;
        this.sendPlaybackStartedAck(generation);
      }, delays[this.playbackStartedAckAttempts - 1] ?? 3_000);
    });
  }

  private acceptCueBatch(batch: RelayCueBatch): void {
    if (this.timingInvalidated) return;
    const trackId = this.selectedRelayTrackId;
    if (!trackId || this.manuallyDisabled) return;
    const incoming = batch.cues.filter((cue) => cue.trackId === trackId);
    const active = batch.active && batch.active.trackId === trackId ? batch.active : null;
    const epochs = new Set(incoming.map((cue) => cue.epoch));
    if (active) epochs.add(active.epoch);
    if (epochs.size > 1) {
      this.invalidateTiming();
      return;
    }
    const epoch = incoming[0]?.epoch ?? active?.epoch;
    if (epoch !== undefined) {
      if (this.playbackStarted) this.ensureAnchor(epoch);
      else if (this.pendingStartupEpoch === undefined) this.pendingStartupEpoch = epoch;
      else if (this.pendingStartupEpoch !== epoch) this.invalidateTiming();
    }
    if (this.timingInvalidated) return;
    const filtered = { ...batch, cues: incoming, ...(batch.reset ? { active } : {}) };
    this.scheduler.accept(filtered);
    this.prefetchImages(incoming);
    if (active && !incoming.some((cue) => cue.seq === active.seq)) this.prefetchImages([active]);
    this.renderAtPlayhead();
  }

  private renderAtPlayhead(): void {
    const cue = this.enabled && !this.manuallyDisabled && !this.timingInvalidated ? this.scheduler.current(this.currentPlayheadMs) : null;
    if (!cue) { this.activeCue = null; this.clearOverlay(); return; }
    if (this.activeCue?.seq === cue.seq) return;
    this.activeCue = cue;
    if (!cue.imageId) { this.clearOverlay(); return; }
    const image = this.getCachedImage(cue.imageId);
    if (image) this.placeImage(image, cue);
    else { this.clearOverlay(); this.enqueueImage(cue, true); this.pumpImages(); }
  }

  private prefetchImages(cues: RelayCue[]): void {
    for (const cue of cues) this.enqueueImage(cue, false);
    this.pumpImages();
  }

  private enqueueImage(cue: RelayCue, highestPriority: boolean): void {
    const imageId = cue.imageId;
    if (!imageId || this.images.has(imageId) || this.pendingImages.has(imageId) || this.queuedImages.has(imageId)) return;
    if (this.queuedImages.size >= MAX_QUEUED_IMAGES) this.queuedImages.delete(this.queuedImages.keys().next().value as string);
    if (highestPriority) {
      const queued = Array.from(this.queuedImages.entries());
      this.queuedImages.clear();
      this.queuedImages.set(imageId, cue);
      for (const [queuedId, queuedCue] of queued) this.queuedImages.set(queuedId, queuedCue);
    }
    else this.queuedImages.set(imageId, cue);
  }

  private pumpImages(): void {
    while (!this.disposed && this.session && this.pendingImages.size < MAX_IMAGE_REQUESTS && this.queuedImages.size) {
      const first = this.queuedImages.entries().next().value as [string, RelayCue] | undefined;
      if (!first) return;
      const [imageId, cue] = first;
      this.queuedImages.delete(imageId);
      const image = new Image();
      let settled = false;
      let rejectLoad!: (error: Error) => void;
      const timeoutError = new Error("image-timeout");
      const timer = setTimeout(() => finish(timeoutError), this.imageLoadTimeoutMs);
      const pending: PendingImage = {
        image, timer,
        cancel: () => finish(new Error("image-cancelled")),
      };
      this.pendingImages.set(imageId, pending);
      const generation = this.generation;
      const cueGeneration = this.cueGeneration;
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        image.onload = null;
        image.onerror = null;
        if (this.pendingImages.get(imageId) === pending) this.pendingImages.delete(imageId);
        if (error) {
          image.src = "";
          rejectLoad(error);
          this.pumpImages();
          return;
        }
        const width = image.naturalWidth;
        const height = image.naturalHeight;
        const bytes = width * height * 4;
        if (!this.isCurrent(generation) || cueGeneration !== this.cueGeneration
          || !Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width !== cue.width || height !== cue.height
          || width < 1 || height < 1 || width > MAX_IMAGE_DIMENSION || height > MAX_IMAGE_DIMENSION
          || !Number.isSafeInteger(bytes) || bytes > MAX_DECODED_IMAGE_BYTES || !this.makeImageRoom(bytes)) {
          image.src = "";
          this.pumpImages();
          return;
        }
        this.images.set(imageId, { image, decodedBytes: bytes });
        this.imagesDecodedBytes += bytes;
        if (this.activeCue?.imageId === imageId) this.placeImage(image, this.activeCue);
        this.pumpImages();
      };
      const loaded = new Promise<void>((resolve, reject) => {
        rejectLoad = reject;
        image.onload = () => { finish(); resolve(); };
        image.onerror = () => { finish(new Error("image")); };
      });
      loaded.catch(() => undefined);
      try { image.src = this.session.cueImageUrl(imageId); }
      catch { finish(new Error("image-url")); }
    }
  }

  private makeImageRoom(bytes: number): boolean {
    while (this.images.size >= MAX_IMAGES || this.imagesDecodedBytes + bytes > MAX_DECODED_IMAGE_BYTES) {
      const protectedId = this.activeCue?.imageId;
      const evict = Array.from(this.images.keys()).find((imageId) => imageId !== protectedId);
      if (!evict) return false;
      const old = this.images.get(evict)!;
      old.image.src = "";
      this.images.delete(evict);
      this.imagesDecodedBytes -= old.decodedBytes;
    }
    return true;
  }

  private getCachedImage(imageId: string): HTMLImageElement | undefined {
    const cached = this.images.get(imageId);
    if (!cached) return undefined;
    this.images.delete(imageId);
    this.images.set(imageId, cached);
    return cached.image;
  }

  private cancelImages(): void {
    this.queuedImages.clear();
    for (const pending of this.pendingImages.values()) pending.cancel();
    this.pendingImages.clear();
  }

  private resetCueState(keepEpoch: boolean): void {
    this.cueGeneration++;
    this.cancelImages();
    this.activeCue = null;
    this.clearOverlay();
    this.scheduler.reset();
    this.pendingStartupEpoch = undefined;
    if (!keepEpoch) this.schedulerEpoch = undefined;
    else if (this.playbackStarted && this.schedulerEpoch !== undefined && !this.timingInvalidated) {
      this.scheduler.setAnchor({ epoch: this.schedulerEpoch, mediaMs: this.currentPlayheadMs - this.offsetMs, playheadMs: this.currentPlayheadMs });
    }
  }

  private invalidateTiming(): void {
    this.timingInvalidated = true;
    this.scheduler.reset();
    this.cancelImages();
    this.activeCue = null;
    this.clearOverlay();
  }

  private placeImage(image: HTMLImageElement, cue: RelayCue): void {
    this.overlay.textContent = "";
    Object.assign(image.style, {
      position: "absolute", left: `${cue.x / cue.screenWidth * 100}%`, top: `${cue.y / cue.screenHeight * 100}%`,
      width: `${cue.width / cue.screenWidth * 100}%`, height: `${cue.height / cue.screenHeight * 100}%`,
      maxWidth: "100%", maxHeight: "100%",
    });
    this.overlay.appendChild(image);
    this.overlay.style.display = "block";
    this.positionOverlay();
  }

  private positionOverlay(): void {
    if (this.disposed) return;
    try {
      const rect = this.overlayAnchor.getBoundingClientRect();
      Object.assign(this.overlay.style, { left: `${rect.left}px`, top: `${rect.top}px`, width: `${rect.width}px`, height: `${rect.height}px` });
    } catch { this.clearOverlay(); }
  }

  private clearOverlay(): void { this.overlay.textContent = ""; this.overlay.style.display = "none"; }
  private emitTracks(): void { this.handlers?.onEmbeddedSubtitleTracksChange?.(this.getEmbeddedSubtitleTracks()); }

  private async selectRelayTrack(trackId: string | null, generation = this.generation, force = false): Promise<boolean> {
    const session = this.session;
    if (!session || !this.isCurrent(generation)) return false;
    if (trackId === this.selectedRelayTrackId && !this.selectionPending && !force) return true;
    if (this.selectionPending?.trackId === trackId) return this.selectionPending.promise;
    const version = ++this.selectionVersion;
    this.manuallyDisabled = trackId === null;
    this.offRequestSent = trackId === null;
    this.selectedRelayTrackId = trackId;
    this.serverSelectedRelayTrackId = this.manuallyDisabled ? null : this.serverSelectedRelayTrackId;
    this.resetCueState(true);
    this.scheduler.setEnabled(this.enabled && trackId !== null);
    this.relayTracks = this.relayTracks.map((track) => ({ ...track, selected: !this.manuallyDisabled && track.id === `relay:${trackId}` }));
    if (trackId !== null) this.inner.setLiveSubtitleMode(true);
    const operation = this.selectionChain.catch(() => undefined).then(async () => {
      await session.selectTrack(trackId);
      if (!this.isCurrent(generation) || version !== this.selectionVersion) return false;
      this.serverSelectedRelayTrackId = trackId;
      return true;
    }).catch(() => {
      if (this.isCurrent(generation) && version === this.selectionVersion) {
        this.selectedRelayTrackId = null;
        this.serverSelectedRelayTrackId = null;
        this.scheduler.setEnabled(false);
        this.resetCueState(true);
        this.emitTracks();
      }
      return false;
    });
    this.selectionChain = operation.then(() => undefined);
    const tracked = operation.finally(() => {
      if (this.selectionPending?.promise === tracked) this.selectionPending = undefined;
    });
    this.selectionPending = { trackId, promise: tracked };
    this.emitTracks();
    return tracked;
  }

  setEventHandlers(handlers: MediaPlayerEventHandlers | null): void { this.handlers = handlers; }
  setLiveSubtitleMode(enabled: boolean): void { this.inner.setLiveSubtitleMode(enabled); }
  setLiveAudioMetadataUrl(url: string): void { this.inner.setLiveAudioMetadataUrl(url); }
  setLiveDvbSubtitleUrl(url: string): void { this.inner.setLiveDvbSubtitleUrl(url); }
  setLiveDvbSubtitleEnabled(enabled: boolean): void { this.inner.setLiveDvbSubtitleEnabled(enabled); }
  getLiveDvbSubtitleStatus(): string { return this.inner.getLiveDvbSubtitleStatus(); }
  getLiveDvbSubtitleDiagnostics(): string { return this.inner.getLiveDvbSubtitleDiagnostics(); }
  isAudioTrackSelectionPending(): boolean { return this.inner.isAudioTrackSelectionPending(); }
  load(_streamUrl: string): void { void this.start(); }
  play(): void { this.inner.play(); }
  pause(): void { this.inner.pause(); }
  restart(): void {
    this.invalidateTiming();
    this.inner.restart();
  }
  skip(seconds: number): void { this.inner.skip(seconds); }
  setDisplayMode(mode: VideoDisplayMode): void { this.inner.setDisplayMode(mode); this.positionOverlay(); }
  resize(): void { this.inner.resize(); this.positionOverlay(); }
  getVideoResolution(): string | null { return this.inner.getVideoResolution(); }
  getStreamInformation() { return this.inner.getStreamInformation(); }
  getAudioTracks(): AudioTrack[] { return this.inner.getAudioTracks(); }
  selectAudioTrack(id: string): boolean { return this.inner.selectAudioTrack(id); }
  getEmbeddedSubtitleTracks(): EmbeddedSubtitleTrack[] {
    const native = this.inner.getEmbeddedSubtitleTracks();
    return [...this.relayTracks, ...native];
  }
  selectEmbeddedSubtitleTrack(id: string): boolean {
    if (id === "off") {
      if (this.manuallyDisabled && this.selectedRelayTrackId === null) return true;
      this.manuallyDisabled = true;
      this.selectedRelayTrackId = null;
      this.scheduler.setEnabled(false);
      this.resetCueState(true);
      this.relayTracks = this.relayTracks.map((track) => ({ ...track, selected: false }));
      this.emitTracks();
      void this.selectRelayTrack(null, this.generation, true);
      this.inner.selectEmbeddedSubtitleTrack(id);
      return true;
    }
    if (id.startsWith("relay:")) {
      const trackId = id.slice("relay:".length);
      if (!this.relayTracks.some((track) => track.id === id)) return false;
      if (trackId === this.selectedRelayTrackId && !this.selectionPending) return true;
      void this.selectRelayTrack(trackId);
      return true;
    }
    this.manuallyDisabled = true;
    this.selectedRelayTrackId = null;
    this.scheduler.setEnabled(false);
    this.resetCueState(true);
    this.relayTracks = this.relayTracks.map((track) => ({ ...track, selected: false }));
    this.emitTracks();
    void this.selectRelayTrack(null, this.generation, true);
    return this.inner.selectEmbeddedSubtitleTrack(id);
  }
  setSubtitle(_subtitleText: string, _label: string, _language: string): Promise<SubtitleAttachment> {
    return Promise.resolve({ enabled: false, reason: "External subtitles are unavailable for relay playback." });
  }
  setSubtitleEnabled(enabled: boolean): void { this.enabled = enabled; this.scheduler.setEnabled(enabled && this.selectedRelayTrackId !== null && !this.manuallyDisabled); if (!enabled) { this.activeCue = null; this.clearOverlay(); } else this.renderAtPlayhead(); }
  setSubtitleTimingOffset(seconds: number): void {
    if (!Number.isFinite(seconds) || Math.abs(seconds) > 86_400) return;
    // This user timing control shifts the experimental mapping while retaining its unverified status.
    this.offsetMs = seconds * 1_000;
    if (this.schedulerEpoch !== undefined && this.playbackStarted) this.scheduler.setAnchor({ epoch: this.schedulerEpoch, mediaMs: this.currentPlayheadMs - this.offsetMs, playheadMs: this.currentPlayheadMs });
    this.renderAtPlayhead();
  }

  getLiveRelayDiagnostics(): string {
    const origin = this.lastStatus?.startupVideoPtsOrigin90k ?? this.lastStatus?.videoPtsOrigin90k;
    const originText = Number.isSafeInteger(origin) ? String(origin) : "na";
    const clock = this.timingInvalidated ? "invalidated" : "unverified";
    return `relay timing=experimental-provisional clock=${clock} progress=${this.playbackStarted ? "local" : "pending"} ack=${this.playbackStartedAck} ackAttempts=${this.playbackStartedAckAttempts} offsetMs=${Math.round(this.offsetMs)} playheadMs=${Math.round(this.currentPlayheadMs)} bufferEvents=${this.bufferEvents} pts90k=${originText} images=${this.images.size} decodedBytes=${this.imagesDecodedBytes}`;
  }

  getRelayDiagnostics(): string { return this.getLiveRelayDiagnostics(); }
  getRelaySubtitleStatus(): string {
    if (this.disposed) return "relay closed";
    if (!this.session) return this.started ? "relay preparing" : "relay not started";
    const state = this.lastStatus?.state ?? "preparing";
    return `relay ${state} tracks=${this.relayTracks.length} selected=${this.selectedRelayTrackId ? 1 : 0} clock=${this.timingInvalidated ? "invalidated" : "unverified"} progress=${this.playbackStarted ? "local" : "pending"} ack=${this.playbackStartedAck}`;
  }

  getLiveSubtitleServiceStatus(): string { return this.getRelaySubtitleStatus(); }
  isSubtitleTimingTestPlayer(): boolean { return true; }

  close(): Promise<void> {
    if (this.closing) return this.closing;
    if (!this.disposed) {
      this.disposed = true;
      this.generation += 1;
      if (this.playbackStartedAckTimer !== undefined) clearTimeout(this.playbackStartedAckTimer);
      this.playbackStartedAckTimer = undefined;
      if (this.statusTimer !== undefined) clearTimeout(this.statusTimer);
      if (this.heartbeatTimer !== undefined) clearTimeout(this.heartbeatTimer);
      this.statusTimer = undefined;
      this.heartbeatTimer = undefined;
      if (this.activeControlCancelToken) {
        this.activeControlCancelToken.cancelled = true;
        for (const cancel of this.activeControlCancelToken.listeners) cancel();
      }
      this.session?.stopCuePolling();
      this.scheduler.reset();
      this.clearOverlay();
      for (const { image } of this.images.values()) image.src = "";
      this.cancelImages();
      this.images.clear();
      this.imagesDecodedBytes = 0;
      this.inner.destroy();
      window.removeEventListener("resize", this.overlayReposition);
      window.removeEventListener("scroll", this.overlayReposition, true);
      this.overlay.parentNode?.removeChild(this.overlay);
    }
    this.closing = (async () => {
      await this.starting?.catch(() => undefined);
      await this.controlChain;
      await this.disposeSession();
      await this.selectionChain;
    })();
    return this.closing;
  }

  destroy(): void {
    void this.close().catch(() => undefined);
  }

  private disposeSession(): Promise<void> {
    if (this.sessionDisposal) return this.sessionDisposal;
    const session = this.session;
    this.session = undefined;
    if (!session) return Promise.resolve();
    this.sessionDisposal = session.dispose();
    return this.sessionDisposal;
  }
}

function boundedInteger(value: number, minimum: number, maximum: number): number {
  if (!Number.isFinite(value)) throw new Error("Live subtitle relay setting is invalid.");
  return Math.max(minimum, Math.min(maximum, Math.floor(value)));
}
function delay(milliseconds: number): Promise<void> { return new Promise((resolve) => setTimeout(resolve, milliseconds)); }
function isLanguage(value: string | undefined, language: "fi" | "en"): boolean {
  const normalized = value?.toLowerCase().split(/[-_]/, 1)[0];
  return language === "fi" ? normalized === "fi" || normalized === "fin" || normalized === "finnish"
    : normalized === "en" || normalized === "eng" || normalized === "english";
}
function sanitizeError(error: Error): Error {
  if (/ready|closed|offset invalid|setting is invalid/i.test(error.message)) return error;
  return new Error("Could not start live subtitle relay playback.");
}
