import type { AudioTrack, EmbeddedSubtitleTrack, MediaPlayer, MediaPlayerEventHandlers, PlaybackState, SubtitleAttachment, VideoDisplayMode } from "../media-player.ts";
import { srtToWebVtt } from "../../core/subtitles/srt-to-vtt.ts";
import { shiftWebVttCues } from "../../core/subtitles/webvtt-timing.ts";
import { normalizeSubtitleOffsetSeconds } from "../../core/subtitles/timing.ts";

const PLAYBACK_START_TIMEOUT_MS = 8_000;

export class HtmlVideoPlayer implements MediaPlayer {
  private hls: { destroy(): void } | undefined;
  private liveSubtitleMode = false;
  private liveHlsSubtitleTracks: Array<{ id: number; label: string; language?: string; selected: boolean }> = [];
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
  private readonly eventListeners: Array<[string, EventListener]>;

  constructor(private readonly video: HTMLVideoElement) {
    this.eventListeners = [
      ["loadstart", () => this.emit("loading")],
      ["playing", () => this.emit("playing")],
      ["canplay", () => this.emitPlayingIfMediaIsAdvancing()],
      ["waiting", () => this.emit("buffering")],
      ["pause", () => { if (!this.video.ended) this.emit("paused"); }],
      ["ended", () => this.emit("ended")],
      ["error", () => { this.clearPlaybackStartTimer(); this.emit("error"); }],
      ["loadedmetadata", () => this.applyPendingSeek()],
      ["loadedmetadata", () => this.refreshEmbeddedSubtitleTracks()],
      ["playing", () => this.refreshEmbeddedSubtitleTracks()],
      ["timeupdate", () => { this.emitPlayingIfMediaIsAdvancing(); this.emitProgress(); }],
      ["durationchange", () => this.emitProgress()],
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
    if (enabled) this.suppressNativeSubtitleDefaults();
    else this.liveHlsSubtitleTracks = [];
    this.refreshEmbeddedSubtitleTracks();
  }

  load(streamUrl: string): void {
    const generation = ++this.loadGeneration;
    this.liveHlsSubtitleTracks = [];
    this.selectedNativeSubtitleTrack = undefined;
    this.hls?.destroy();
    this.hls = undefined;
    this.clearPlaybackStartTimer();
    this.emit("loading");
    this.armPlaybackStartTimer(generation);
    if (/\.m3u8(?:[?#]|$)/i.test(streamUrl)
      && (this.liveSubtitleMode || !this.video.canPlayType("application/vnd.apple.mpegurl"))) {
      void import("hls.js").then(({ default: Hls }) => {
        if (generation !== this.loadGeneration) return;
        if (!Hls.isSupported()) { this.emit("error"); return; }
        // Keep MPEG-TS demuxing off the UI thread so malformed or unusually
        // busy transport streams cannot make the controls unresponsive.
        const hls = new Hls({
          enableWorker: true,
          // Provider live streams can contain malformed auxiliary tracks or
          // advertise partial-segment behavior they do not implement safely.
          // The conservative profile keeps ordinary segment playback isolated
          // from those parsers and leaves external WebVTT subtitles unaffected.
          lowLatencyMode: false,
          enableWebVTT: false,
          enableIMSC1: false,
          enableCEA708Captions: false,
        });
        this.hls = hls;
        if (this.liveSubtitleMode) {
          // Keep browser playback isolated from MPEG-TS DVB subtitle parsing.
          // Some provider streams expose malformed or extremely busy private
          // subtitle PIDs; feeding those packets to a browser-side decoder can
          // monopolize the main thread and prevent both playback and the UI
          // timeout fallback from making progress. hls.js manifest subtitle
          // tracks remain available here, while Tizen continues to use AVPlay's
          // native embedded-track support.
          const events = Hls.Events as unknown as Record<string, string>;
          const updateTracks = () => { this.captureHlsSubtitleTracks(hls); this.refreshEmbeddedSubtitleTracks(); };
          const trackEvents = hls as unknown as { on(event: string, callback: () => void): void };
          if (events.SUBTITLE_TRACKS_UPDATED) trackEvents.on(events.SUBTITLE_TRACKS_UPDATED, updateTracks);
          if (events.SUBTITLE_TRACK_SWITCH) trackEvents.on(events.SUBTITLE_TRACK_SWITCH, updateTracks);
        }
        hls.on(Hls.Events.ERROR, (_event, data) => { if (data.fatal) this.emit("error"); });
        hls.loadSource(streamUrl);
        hls.attachMedia(this.video);
        void this.requestPlay();
      }).catch(() => this.emit("error"));
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
    return [...this.liveHlsSubtitleTracks.map((track) => ({ ...track, id: `hls:${track.id}` })),
      ...native,
    ];
  }

  selectEmbeddedSubtitleTrack(id: string): boolean {
    if (!this.liveSubtitleMode) return false;
    if (id === "off") {
      this.selectedNativeSubtitleTrack = undefined;
      this.disableOtherSubtitleRenderers();
      this.suppressNativeSubtitleDefaults();
      const hls = this.hls as HlsSubtitleController | undefined;
      if (hls && "subtitleTrack" in hls) {
        try { hls.subtitleTrack = -1; hls.subtitleDisplay = false; } catch { /* Older HLS builds may not expose these controls. */ }
      }
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
        return hls.subtitleTrack === trackId;
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
        return tracks[index]?.mode === "showing";
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
    this.clearPlaybackStartTimer();
    this.hls?.destroy();
    this.hls = undefined;
    this.liveHlsSubtitleTracks = [];
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

  private emitProgress(): void {
    const durationSeconds = this.video.duration;
    const currentTimeSeconds = this.video.currentTime;
    if (!Number.isFinite(durationSeconds) || durationSeconds <= 0 || !Number.isFinite(currentTimeSeconds)) return;
    this.eventHandlers?.onProgress?.({ currentTimeSeconds, durationSeconds });
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

  private captureHlsSubtitleTracks(hls: HlsSubtitleController): void {
    const source = hls.subtitleTracks;
    this.liveHlsSubtitleTracks = Array.isArray(source) ? source.flatMap((track, index) => {
      const language = cleanTrackText(track.lang);
      const label = cleanTrackText(track.name) || language || `Subtitle ${index + 1}`;
      return [{ id: index, label, ...(language ? { language } : {}), selected: hls.subtitleTrack === index }];
    }) : [];
  }

  private refreshEmbeddedSubtitleTracks(): void {
    if (!this.liveSubtitleMode) return;
    this.eventHandlers?.onEmbeddedSubtitleTracksChange?.(this.getEmbeddedSubtitleTracks());
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
