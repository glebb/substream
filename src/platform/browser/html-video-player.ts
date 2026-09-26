import type { AudioTrack, EmbeddedSubtitleTrack, LiveBufferWindow, MediaPlayer, MediaPlayerEventHandlers, PlaybackState, SubtitleAttachment, VideoDisplayMode } from "../media-player.ts";
import { srtToWebVtt } from "../../core/subtitles/srt-to-vtt.ts";
import { shiftWebVttCues } from "../../core/subtitles/webvtt-timing.ts";
import { normalizeSubtitleOffsetSeconds } from "../../core/subtitles/timing.ts";
import { createLiveDvbWorkerClient, LIVE_DVB_MAX_FRAGMENT_BYTES, type LiveDvbWorkerClient, type LiveDvbWorkerResponse, type LiveDvbWorkerTrack, type WorkerPort } from "./live-dvb-worker-protocol.ts";
import { LiveDvbOverlay } from "./live-dvb-overlay.ts";

const PLAYBACK_START_TIMEOUT_MS = 8_000;
const BUFFERING_GRACE_MS = 750;
const DVB_WORKER_WATCHDOG_MS = 8_000;
const TS_PACKET_BYTES = 188;
const DVB_MAX_CAPTURED_FRAGMENT_BYTES = 10 * 1024 * 1024;
const DVB_CAPTURE_WINDOW_BYTES = Math.floor(LIVE_DVB_MAX_FRAGMENT_BYTES / TS_PACKET_BYTES) * TS_PACKET_BYTES;

export class HtmlVideoPlayer implements MediaPlayer {
  private hls: HlsSubtitleController | undefined;
  private liveSubtitleMode = false;
  private liveDvbSubtitleTracks: LiveDvbWorkerTrack[] = [];
  private selectedDvbSubtitleId: string | undefined;
  private subtitlesDisabled = false;
  private dvbWorker: LiveDvbWorkerClient | undefined;
  private dvbOverlay: LiveDvbOverlay | undefined;
  private dvbHlsListeners: Array<[string, (event: string, data: Record<string, unknown>) => void]> = [];
  private dvbWatchdog: ReturnType<typeof setTimeout> | undefined;
  private dvbCaptureFragment: { payload: ArrayBuffer; startSeconds: number; nextOffset: number; byteLength: number } | undefined;
  private dvbSeenFragments = new WeakSet<object>();
  private selectedNativeSubtitleTrack: TextTrack | undefined;
  private loadGeneration = 0;
  private subtitleObjectUrl: string | undefined;
  private subtitleText: string | undefined;
  private subtitleLabel = "";
  private subtitleLanguage = "";
  private subtitleTimingOffsetSeconds = 0;
  private subtitleEnabled = true;
  private subtitleTrack: HTMLTrackElement | undefined;
  private eventHandlers: MediaPlayerEventHandlers | null = null;
  private pendingSeekSeconds: number | null = null;
  private playbackStartTimer: ReturnType<typeof setTimeout> | undefined;
  private bufferingTimer: ReturnType<typeof setTimeout> | undefined;
  private bufferingStartTime: number | undefined;
  private readonly eventListeners: Array<[string, EventListener]>;

  constructor(private readonly video: HTMLVideoElement, private readonly workerFactory?: () => WorkerPort) {
    this.eventListeners = [
      ["loadstart", () => this.emit("loading")],
      ["playing", () => { this.clearBufferingTimer(); this.emit("playing"); }],
      ["canplay", () => { this.clearBufferingTimer(); this.emitPlayingIfMediaIsAdvancing(); }],
      // hls.js can issue a short waiting event while it appends the next live
      // segment even though frames keep arriving. Do not flash "Connecting"
      // for that harmless transition.
      ["waiting", () => this.armBufferingTimer()],
      ["pause", () => { this.clearBufferingTimer(); if (!this.video.ended) this.emit("paused"); }],
      ["ended", () => { this.clearBufferingTimer(); this.emit("ended"); }],
      ["error", () => { this.clearPlaybackStartTimer(); this.clearBufferingTimer(); this.emit("error"); }],
      ["loadedmetadata", () => this.applyPendingSeek()],
      ["loadedmetadata", () => this.refreshEmbeddedSubtitleTracks()],
      ["playing", () => this.refreshEmbeddedSubtitleTracks()],
      ["timeupdate", () => {
        // A timeupdate is conclusive evidence that media is advancing, even
        // when Chromium briefly reports an older readyState during an HLS
        // append. It wins over a preceding transient waiting event.
        this.clearBufferingTimer();
        this.emit("playing");
        this.emitProgress(); this.emitLiveBufferWindow(); this.dvbWorker?.setTime(this.video.currentTime);
      }],
      ["durationchange", () => { this.emitProgress(); this.emitLiveBufferWindow(); }],
      ["progress", () => this.emitLiveBufferWindow()],
      ["loadedmetadata", () => this.emitLiveBufferWindow()],
    ];
    for (const [type, listener] of this.eventListeners) this.video.addEventListener(type, listener);
    const textTracks = this.video.textTracks;
    textTracks?.addEventListener?.("addtrack", this.onNativeSubtitleTracksChanged);
    textTracks?.addEventListener?.("removetrack", this.onNativeSubtitleTracksChanged);
  }

  setEventHandlers(handlers: MediaPlayerEventHandlers | null): void {
    this.eventHandlers = handlers;
  }

  setLiveSubtitleMode(enabled: boolean): void {
    this.liveSubtitleMode = enabled;
    this.subtitlesDisabled = false;
    if (enabled) this.suppressNativeSubtitleDefaults();
    else {
      this.disposeDvbSubtitlePath();
    }
    this.refreshEmbeddedSubtitleTracks();
  }

  load(streamUrl: string): void {
    const generation = ++this.loadGeneration;
    this.disposeDvbSubtitlePath();
    this.subtitlesDisabled = false;
    this.selectedNativeSubtitleTrack = undefined;
    this.hls?.destroy();
    this.hls = undefined;
    this.clearPlaybackStartTimer();
    this.emit("loading");
    this.armPlaybackStartTimer(generation);
    const isHlsStream = /\.m3u8(?:[?#]|$)/i.test(streamUrl);
    const supportsNativeHls = isHlsStream && !!this.video.canPlayType("application/vnd.apple.mpegurl");
    if (isHlsStream && (this.liveSubtitleMode || !supportsNativeHls)) {
      const loadNativeHls = () => {
        try {
          this.video.src = streamUrl;
          this.video.load();
          void this.requestPlay();
        } catch {
          this.emit("error");
        }
      };
      void import("hls.js").then(({ default: Hls }) => {
        if (generation !== this.loadGeneration) return;
        // Safari can play HLS itself even when hls.js cannot. Keep native
        // playback available; fragment-based DVB discovery requires hls.js.
        if (!Hls.isSupported()) {
          if (supportsNativeHls) loadNativeHls();
          else this.emit("error");
          return;
        }
        // Keep MPEG-TS demuxing off the UI thread so malformed or unusually
        // busy transport streams cannot make the controls unresponsive.
        const hls = new Hls({
          enableWorker: true,
          // Some provider streams advertise malformed subtitle renditions that
          // make hls.js's parser block browser playback. Browser embedded-track
          // support stays conservative; Tizen discovers its native tracks.
          lowLatencyMode: false,
          enableWebVTT: false,
          enableIMSC1: false,
          enableCEA708Captions: false,
          // Keep a modest live cushion so a short worker/UI task cannot turn a
          // transient append delay into a visible rebuffer.
          maxBufferLength: 60,
          maxMaxBufferLength: 120,
          backBufferLength: 30,
        });
        this.hls = hls;
        if (this.liveSubtitleMode) {
          const events = Hls.Events as unknown as Record<string, string>;
          this.initializeDvbSubtitlePath(hls, events);
        }
        hls.on(Hls.Events.ERROR, (_event, data) => { if (data.fatal) this.emit("error"); });
        hls.loadSource(streamUrl);
        hls.attachMedia(this.video);
        void this.requestPlay();
      }).catch(() => {
        if (generation !== this.loadGeneration) return;
        if (supportsNativeHls) loadNativeHls();
        else this.emit("error");
      });
      return;
    }
    try {
      this.video.src = streamUrl;
      this.video.load();
      void this.requestPlay();
    } catch {
      this.emit("error");
    }
  }

  seekTo(seconds: number): void {
    if (!Number.isFinite(seconds) || seconds <= 0) return;
    this.pendingSeekSeconds = seconds;
    this.applyPendingSeek();
  }

  getLiveBufferWindow(): LiveBufferWindow | null {
    const ranges = this.video.seekable;
    if (!ranges || ranges.length === 0) return null;
    try {
      // A live playlist can have discontinuities. The final range is the one
      // that contains the live edge and is therefore safe for a "Go live" UI.
      const index = ranges.length - 1;
      const startSeconds = ranges.start(index);
      const endSeconds = ranges.end(index);
      if (!Number.isFinite(startSeconds) || !Number.isFinite(endSeconds) || endSeconds - startSeconds < 2) return null;
      return {
        startSeconds,
        endSeconds,
        currentSeconds: Math.max(startSeconds, Math.min(endSeconds, this.video.currentTime)),
      };
    } catch {
      return null;
    }
  }

  seekLiveBuffer(seconds: number): void {
    const window = this.getLiveBufferWindow();
    if (!window || !Number.isFinite(seconds)) return;
    // Keep a tiny distance from the moving edge: some engines reject an exact
    // end-of-range seek while the manifest is refreshing.
    this.video.currentTime = Math.max(window.startSeconds, Math.min(window.endSeconds - 0.25, seconds));
    void this.requestPlay();
    this.emitLiveBufferWindow();
  }

  goLive(): void {
    const window = this.getLiveBufferWindow();
    if (window) this.seekLiveBuffer(window.endSeconds);
  }

  getVideoResolution(): string | null {
    return this.video.videoWidth > 0 && this.video.videoHeight > 0
      ? `${this.video.videoWidth} × ${this.video.videoHeight}`
      : null;
  }

  getAudioTracks(): AudioTrack[] {
    // audioTracks is deliberately non-standard. Chromium currently does not expose
    // it for ordinary <video> playback, but some browser engines do.
    const tracks = audioTrackList(this.video);
    if (!tracks) return [];
    const result: AudioTrack[] = [];
    for (let index = 0; index < tracks.length; index += 1) {
      const track = tracks[index];
      if (!track) continue;
      const language = cleanTrackText(track.language);
      const label = cleanTrackText(track.label) || language || `Audio ${index + 1}`;
      result.push({ id: String(index), label, ...(language ? { language } : {}), selected: track.enabled });
    }
    return result;
  }

  selectAudioTrack(id: string): boolean {
    const tracks = audioTrackList(this.video);
    const index = Number(id);
    if (!tracks || !Number.isInteger(index) || index < 0 || index >= tracks.length) return false;
    try {
      for (let candidate = 0; candidate < tracks.length; candidate += 1) {
        const track = tracks[candidate];
        if (track) track.enabled = candidate === index;
      }
      return tracks[index]?.enabled === true;
    } catch {
      return false;
    }
  }

  getEmbeddedSubtitleTracks(): EmbeddedSubtitleTrack[] {
    if (!this.liveSubtitleMode) return [];
    const native = nativeSubtitleTracks(this.video);
    return [...this.liveDvbSubtitleTracks.map((track) => ({ id: `dvb:${track.id}`, label: track.label, language: track.language, selected: this.selectedDvbSubtitleId === track.id })),
      ...native,
    ];
  }

  selectEmbeddedSubtitleTrack(id: string): boolean {
    if (!this.liveSubtitleMode) return false;
    if (id === "off") {
      if (this.subtitlesDisabled) return true;
      if (this.selectedDvbSubtitleId !== undefined) {
        this.selectedDvbSubtitleId = undefined;
        this.dvbWorker?.select("");
        this.dvbOverlay?.clear();
      }
      this.selectedNativeSubtitleTrack = undefined;
      this.disableOtherSubtitleRenderers();
      this.suppressNativeSubtitleDefaults();
      const hls = this.hls as HlsSubtitleController | undefined;
      if (hls && "subtitleTrack" in hls) {
        try { hls.subtitleTrack = -1; hls.subtitleDisplay = false; } catch { /* Older HLS builds may not expose these controls. */ }
      }
      this.subtitlesDisabled = true;
      return true;
    }
    if (id.startsWith("dvb:")) {
      const trackId = id.slice(4);
      if (!this.dvbWorker || !this.liveDvbSubtitleTracks.some((track) => track.id === trackId)) return false;
      // The live UI reconciles tracks on every timeupdate. Re-selecting the
      // current track resets the worker parser and discards every pending cue.
      if (this.selectedDvbSubtitleId === trackId) return true;
      this.selectedDvbSubtitleId = trackId;
      this.subtitlesDisabled = false;
      this.dvbWorker.select(trackId);
      this.dvbOverlay?.clear();
      this.disableNativeSubtitleTracks();
      const hls = this.hls as HlsSubtitleController | undefined;
      if (hls && "subtitleTrack" in hls) { try { hls.subtitleTrack = -1; hls.subtitleDisplay = false; } catch { /* Built-in HLS rendering stays disabled. */ } }
      this.refreshEmbeddedSubtitleTracks();
      return true;
    }
    if (id.startsWith("hls:")) {
      const trackId = Number(id.slice(4));
      const hls = this.hls as HlsSubtitleController | undefined;
      if (!Number.isInteger(trackId) || !hls || !("subtitleTrack" in hls)) return false;
      try {
        hls.subtitleTrack = trackId;
        hls.subtitleDisplay = true;
        this.disableNativeSubtitleTracks();
        const selected = hls.subtitleTrack === trackId;
        if (selected) this.subtitlesDisabled = false;
        return selected;
      } catch { return false; }
    }
    if (id.startsWith("text:")) {
      const tracks = this.video.textTracks;
      const index = Number(id.slice(5));
      if (!tracks || !Number.isInteger(index) || index < 0 || index >= tracks.length) return false;
      try {
        this.selectedNativeSubtitleTrack = tracks[index];
        const hls = this.hls as HlsSubtitleController | undefined;
        if (hls && "subtitleTrack" in hls) { hls.subtitleTrack = -1; hls.subtitleDisplay = false; }
        for (let candidate = 0; candidate < tracks.length; candidate += 1) {
          const track = tracks[candidate];
          if (track && isSubtitleKind(track.kind)) track.mode = candidate === index ? "showing" : "disabled";
        }
        const selected = tracks[index]?.mode === "showing";
        if (selected) this.subtitlesDisabled = false;
        return selected;
      } catch { return false; }
    }
    return false;
  }

  play(): void {
    void this.requestPlay();
  }

  pause(): void {
    this.video.pause();
  }

  restart(): void {
    try {
      this.video.currentTime = 0;
      this.play();
    } catch {
      this.emit("error");
    }
  }

  skip(seconds: number): void {
    if (!Number.isFinite(seconds) || !Number.isFinite(this.video.duration)) return;
    this.video.currentTime = Math.max(0, Math.min(this.video.duration, this.video.currentTime + seconds));
  }

  setDisplayMode(mode: VideoDisplayMode): void {
    this.video.style.objectFit = mode === "fill" ? "cover" : "contain";
  }

  resize(): void {
    // HTML video follows its CSS layout automatically.
  }

  destroy(): void {
    this.loadGeneration += 1;
    this.disposeDvbSubtitlePath();
    this.clearPlaybackStartTimer();
    this.clearBufferingTimer();
    this.hls?.destroy();
    this.hls = undefined;
    const textTracks = this.video.textTracks;
    textTracks?.removeEventListener?.("addtrack", this.onNativeSubtitleTracksChanged);
    textTracks?.removeEventListener?.("removetrack", this.onNativeSubtitleTracksChanged);
    this.selectedNativeSubtitleTrack = undefined;
    this.video.pause();
    this.video.removeAttribute("src");
    this.video.load();
    for (const [type, listener] of this.eventListeners) this.video.removeEventListener(type, listener);
    this.removeSubtitleTrack();
  }

  private async requestPlay(): Promise<void> {
    try {
      await this.video.play();
    } catch {
      // Autoplay restrictions require an explicit gesture; the video remains paused.
      this.emit(this.video.error ? "error" : "paused");
    }
  }

  private emit(state: PlaybackState): void {
    this.eventHandlers?.onStateChange(state);
  }

  private emitPlayingIfMediaIsAdvancing(): void {
    // MediaSource-backed live streams can dispatch a late loadstart after their
    // first playing event. A canplay event, or advancing playback time, is the
    // authoritative signal that the stream is no longer connecting.
    // HAVE_CURRENT_DATA is 2. Keep the numeric threshold so the platform-free
    // unit-test environment does not need a browser HTMLMediaElement global.
    if (!this.video.paused && this.video.readyState >= 2) {
      this.clearBufferingTimer();
      if (this.video.currentTime > 0) this.clearPlaybackStartTimer();
      this.emit("playing");
    }
  }

  private armPlaybackStartTimer(generation: number): void {
    this.clearPlaybackStartTimer();
    this.playbackStartTimer = setTimeout(() => {
      this.playbackStartTimer = undefined;
      if (generation !== this.loadGeneration
        || (!this.video.paused && this.video.readyState >= 2 && this.video.currentTime > 0)) return;
      this.hls?.destroy();
      this.hls = undefined;
      this.video.pause();
      this.emit("error");
    }, PLAYBACK_START_TIMEOUT_MS);
  }

  private clearPlaybackStartTimer(): void {
    if (this.playbackStartTimer === undefined) return;
    clearTimeout(this.playbackStartTimer);
    this.playbackStartTimer = undefined;
  }

  private armBufferingTimer(): void {
    if (this.bufferingTimer !== undefined) return;
    this.bufferingStartTime = this.video.currentTime;
    this.bufferingTimer = setTimeout(() => {
      this.bufferingTimer = undefined;
      // A canplay/playing/timeupdate event clears this first. If the stream is
      // still waiting after the grace window, expose a genuine buffer state.
      const progressed = this.bufferingStartTime !== undefined && this.video.currentTime > this.bufferingStartTime;
      this.bufferingStartTime = undefined;
      if (!progressed) this.emit("buffering");
    }, BUFFERING_GRACE_MS);
  }

  private clearBufferingTimer(): void {
    if (this.bufferingTimer === undefined) return;
    clearTimeout(this.bufferingTimer);
    this.bufferingTimer = undefined;
    this.bufferingStartTime = undefined;
  }

  private emitProgress(): void {
    const durationSeconds = this.video.duration;
    const currentTimeSeconds = this.video.currentTime;
    if (!Number.isFinite(durationSeconds) || durationSeconds <= 0 || !Number.isFinite(currentTimeSeconds)) return;
    this.eventHandlers?.onProgress?.({ currentTimeSeconds, durationSeconds });
  }

  private emitLiveBufferWindow(): void {
    this.eventHandlers?.onLiveBufferWindowChange?.(this.getLiveBufferWindow());
  }

  private readonly onNativeSubtitleTracksChanged: EventListener = () => {
    if (!this.liveSubtitleMode) return;
    this.suppressNativeSubtitleDefaults();
    this.refreshEmbeddedSubtitleTracks();
  };

  private suppressNativeSubtitleDefaults(): void {
    if (!this.liveSubtitleMode) return;
    const tracks = this.video.textTracks;
    if (!tracks) return;
    for (let index = 0; index < tracks.length; index += 1) {
      const track = tracks[index];
      if (track && track !== this.selectedNativeSubtitleTrack && isSubtitleKind(track.kind) && track.mode !== "disabled") {
        try { track.mode = "disabled"; } catch { /* The browser may not have initialized the track. */ }
      }
    }
  }

  private disableNativeSubtitleTracks(): void {
    const tracks = this.video.textTracks;
    if (!tracks) return;
    for (let index = 0; index < tracks.length; index += 1) {
      const track = tracks[index];
      if (track && isSubtitleKind(track.kind)) try { track.mode = "disabled"; } catch { /* The browser may not have initialized the track. */ }
    }
  }

  private disableOtherSubtitleRenderers(): void {
    const hls = this.hls as HlsSubtitleController | undefined;
    if (hls && "subtitleTrack" in hls) {
      try { hls.subtitleTrack = -1; hls.subtitleDisplay = false; } catch { /* Older HLS builds may not expose these controls. */ }
    }
    this.disableNativeSubtitleTracks();
  }

  private refreshEmbeddedSubtitleTracks(): void {
    if (!this.liveSubtitleMode) return;
    this.eventHandlers?.onEmbeddedSubtitleTracksChange?.(this.getEmbeddedSubtitleTracks());
  }

  private initializeDvbSubtitlePath(hls: HlsSubtitleController, events: Record<string, string>): void {
    if (this.dvbWorker || !hls.on || !events.FRAG_LOADED || !events.FRAG_DECRYPTED) return;
    try {
      this.dvbOverlay = new LiveDvbOverlay(this.video, () => {
        this.disposeDvbSubtitlePath();
        this.refreshEmbeddedSubtitleTracks();
      });
      this.dvbWorker = createLiveDvbWorkerClient((message) => this.onDvbWorkerMessage(message), this.workerFactory, () => this.onDvbWorkerAck());
      const onFragment = (_event: string, data: Record<string, unknown>) => {
        const fragment = data.frag as { type?: string; start?: number } | undefined;
        if (fragment?.type !== "main" || !(data.payload instanceof ArrayBuffer)) return;
        // Hls.js may surface the same media fragment through more than one
        // event. Fragment identity deduplicates those without assuming that
        // FRAG_DECRYPTED fires for main-media payloads.
        if (this.dvbSeenFragments.has(fragment)) return;
        this.dvbSeenFragments.add(fragment);
        if (this.dvbCaptureFragment) {
          return;
        }
        if (data.payload.byteLength > DVB_MAX_CAPTURED_FRAGMENT_BYTES) {
          return;
        }
        // Retain one fragment at a time and scan every packet-aligned window
        // in order. The cap bounds memory and total work for a single fragment.
        this.dvbCaptureFragment = {
          payload: data.payload,
          startSeconds: Number(fragment.start) || 0,
          nextOffset: 0,
          byteLength: data.payload.byteLength,
        };
        this.pumpDvbCaptureWindow();
      };
      hls.on(events.FRAG_LOADED, onFragment);
      hls.on(events.FRAG_DECRYPTED, onFragment);
      this.dvbHlsListeners = [[events.FRAG_LOADED, onFragment], [events.FRAG_DECRYPTED, onFragment]];
    } catch {
      this.disposeDvbSubtitlePath();
    }
  }

  private onDvbWorkerMessage(message: LiveDvbWorkerResponse): void {
    if (message.type === "tracks") {
      const previous = this.liveDvbSubtitleTracks.map((track) => `${track.id}:${track.language}`).join("|");
      this.liveDvbSubtitleTracks = message.tracks;
      if (previous !== message.tracks.map((track) => `${track.id}:${track.language}`).join("|")) {
        this.refreshEmbeddedSubtitleTracks();
      }
    } else if (message.type === "frame") {
      this.dvbOverlay?.present(message);
    }
    else if (message.type === "clear") this.dvbOverlay?.clear();
    else if (message.type === "error") {
      this.disposeDvbSubtitlePath();
      this.refreshEmbeddedSubtitleTracks();
    }
  }

  private onDvbWorkerAck(): void {
    if (this.dvbWorker?.pendingFragments) { this.armDvbWatchdog(); return; }
    if (this.dvbCaptureFragment && this.dvbCaptureFragment.nextOffset < this.dvbCaptureFragment.byteLength) {
      this.pumpDvbCaptureWindow();
    } else {
      this.dvbCaptureFragment = undefined;
      this.clearDvbWatchdog();
    }
  }

  private pumpDvbCaptureWindow(): void {
    const capture = this.dvbCaptureFragment;
    if (!capture || this.dvbWorker?.pendingFragments) return;
    const offset = capture.nextOffset;
    const captureBytes = Math.min(DVB_CAPTURE_WINDOW_BYTES, capture.byteLength - offset);
    const accepted = this.dvbWorker?.pushFragment(capture.payload, capture.startSeconds, captureBytes, offset) ?? false;
    if (!accepted) return;
    capture.nextOffset += captureBytes;
    this.armDvbWatchdog();
  }

  private armDvbWatchdog(): void {
    this.clearDvbWatchdog();
    this.dvbWatchdog = setTimeout(() => {
      this.dvbWatchdog = undefined;
      this.disposeDvbSubtitlePath();
      this.refreshEmbeddedSubtitleTracks();
    }, DVB_WORKER_WATCHDOG_MS);
  }

  private clearDvbWatchdog(): void {
    if (this.dvbWatchdog !== undefined) clearTimeout(this.dvbWatchdog);
    this.dvbWatchdog = undefined;
  }

  private disposeDvbSubtitlePath(): void {
    this.clearDvbWatchdog();
    this.dvbCaptureFragment = undefined;
    this.dvbSeenFragments = new WeakSet<object>();
    const hls = this.hls as HlsSubtitleController | undefined;
    for (const [event, listener] of this.dvbHlsListeners) {
      try { hls?.off?.(event, listener); } catch { /* Subtitle cleanup must not affect playback. */ }
    }
    this.dvbHlsListeners = [];
    this.dvbWorker?.dispose();
    this.dvbWorker = undefined;
    this.dvbOverlay?.dispose();
    this.dvbOverlay = undefined;
    this.liveDvbSubtitleTracks = [];
    this.selectedDvbSubtitleId = undefined;
  }

  private applyPendingSeek(): void {
    if (this.pendingSeekSeconds === null || this.video.readyState < 1) return;
    const seconds = this.pendingSeekSeconds;
    this.pendingSeekSeconds = null;
    try {
      this.video.currentTime = Math.min(seconds, Number.isFinite(this.video.duration) ? this.video.duration : seconds);
    } catch {
      // Some browser streams do not permit seeking until a seekable range exists.
    }
  }

  async setSubtitle(subtitleText: string, label: string, language: string): Promise<SubtitleAttachment> {
    const previousSubtitle = this.subtitleText;
    const previousLabel = this.subtitleLabel;
    const previousLanguage = this.subtitleLanguage;
    this.subtitleText = subtitleText;
    this.subtitleLabel = label;
    this.subtitleLanguage = language;
    this.subtitleEnabled = true;
    try {
      this.replaceSubtitleTrack();
      return { enabled: true };
    } catch {
      this.subtitleText = previousSubtitle;
      this.subtitleLabel = previousLabel;
      this.subtitleLanguage = previousLanguage;
      return { enabled: false, reason: "The browser could not attach the selected subtitle." };
    }
  }

  setSubtitleTimingOffset(offsetSeconds: number): void {
    this.subtitleTimingOffsetSeconds = normalizeSubtitleOffsetSeconds(offsetSeconds);
    if (this.subtitleText !== undefined) {
      try {
        this.replaceSubtitleTrack();
      } catch {
        // Keep the previously attached track if rebuilding its timed cues fails.
      }
    }
  }

  setSubtitleEnabled(enabled: boolean): void {
    if (!this.subtitleTrack) return;
    this.subtitleEnabled = enabled;
    this.applySubtitleEnabled();
  }

  private replaceSubtitleTrack(): void {
    const vtt = shiftWebVttCues(srtToWebVtt(this.subtitleText ?? ""), this.subtitleTimingOffsetSeconds);
    const objectUrl = URL.createObjectURL(new Blob([vtt], { type: "text/vtt" }));
    let track: HTMLTrackElement | null = null;
    try {
      track = document.createElement("track");
      track.default = true;
      track.kind = "subtitles";
      track.label = this.subtitleLabel;
      track.srclang = this.subtitleLanguage;
      track.src = objectUrl;
      this.video.append(track);
      this.subtitleTrack = track;
      this.applySubtitleEnabled();
      this.video.querySelectorAll("track").forEach((existing) => {
        if (existing !== track) existing.remove();
      });
      const previousObjectUrl = this.subtitleObjectUrl;
      this.subtitleObjectUrl = objectUrl;
      if (previousObjectUrl) URL.revokeObjectURL(previousObjectUrl);
    } catch (error) {
      track?.remove();
      URL.revokeObjectURL(objectUrl);
      throw error;
    }
  }

  private removeSubtitleTrack(): void {
    this.video.querySelectorAll("track").forEach((track) => track.remove());
    this.subtitleTrack = undefined;
    if (this.subtitleObjectUrl) {
      URL.revokeObjectURL(this.subtitleObjectUrl);
      this.subtitleObjectUrl = undefined;
    }
  }

  private applySubtitleEnabled(): void {
    if (!this.subtitleTrack) return;
    try {
      this.subtitleTrack.track.mode = this.subtitleEnabled ? "showing" : "disabled";
    } catch {
      // The browser may not have initialized the track yet; mode is applied again on replacement.
    }
  }
}

interface BrowserAudioTrack {
  enabled: boolean;
  label?: string;
  language?: string;
}

interface BrowserAudioTrackList {
  length: number;
  [index: number]: BrowserAudioTrack | undefined;
}

function audioTrackList(video: HTMLVideoElement): BrowserAudioTrackList | undefined {
  return (video as HTMLVideoElement & { audioTracks?: BrowserAudioTrackList }).audioTracks;
}

function cleanTrackText(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const cleaned = value.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 80);
  return cleaned || undefined;
}

interface HlsSubtitleController {
  destroy(): void;
  on?(event: string, callback: (event: string, data: Record<string, unknown>) => void): void;
  off?(event: string, callback: (event: string, data: Record<string, unknown>) => void): void;
  subtitleTracks?: Array<{ lang?: string; name?: string }>;
  subtitleTrack?: number;
  subtitleDisplay?: boolean;
}

function isSubtitleKind(kind: string): boolean {
  return kind === "subtitles" || kind === "captions";
}

function nativeSubtitleTracks(video: HTMLVideoElement): EmbeddedSubtitleTrack[] {
  const tracks = video.textTracks;
  if (!tracks) return [];
  const result: EmbeddedSubtitleTrack[] = [];
  for (let index = 0; index < tracks.length; index += 1) {
    const track = tracks[index];
    if (!track || !isSubtitleKind(track.kind)) continue;
    const language = cleanTrackText(track.language);
    const label = cleanTrackText(track.label) || language || `Subtitle ${index + 1}`;
    result.push({ id: `text:${index}`, label, ...(language ? { language } : {}), selected: track.mode === "showing" });
  }
  return result;
}
