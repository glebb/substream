import type { AudioTrack, EmbeddedSubtitleTrack, MediaPlayer, MediaPlayerEventHandlers, PlaybackState, SubtitleAttachment, VideoDisplayMode } from "../media-player.ts";
import { parseSrtCues, type SubtitleCue } from "../../core/subtitles/srt-cues.ts";
import { normalizeSubtitleOffsetSeconds } from "../../core/subtitles/timing.ts";
import { probeLiveTsAudioMetadata, type LiveTsAudioProbeResult } from "./live-ts-audio-metadata.ts";
import { TizenLiveDvbSubtitleFeed, type TizenDvbTrack } from "./live-dvb-subtitle-feed.ts";

interface AvPlayApi {
  open(url: string): void;
  prepareAsync(onSuccess: () => void, onError: (error: unknown) => void): void;
  play(): void;
  pause(): void;
  jumpForward(milliseconds: number, onSuccess?: () => void, onError?: (error: unknown) => void): void;
  jumpBackward(milliseconds: number, onSuccess?: () => void, onError?: (error: unknown) => void): void;
  stop(): void;
  close(): void;
  seekTo?(milliseconds: number, onSuccess?: () => void, onError?: (error: unknown) => void): void;
  getDuration?(): number;
  getCurrentStreamInfo?(): AvPlayStreamInfo[];
  getTotalTrackInfo?(): AvPlayStreamInfo[];
  setSelectTrack?(trackType: "AUDIO" | "TEXT", index: number): void;
  setSilentSubtitle?(silent: boolean): void;
  setStreamingProperty?(property: "USER_AGENT", value: string): void;
  setBufferingParam?(bufferingType: "PLAYER_BUFFER_FOR_PLAY" | "PLAYER_BUFFER_FOR_RESUME", parameter: "PLAYER_BUFFER_SIZE_IN_SECOND", value: number): void;
  setDisplayRect(left: number, top: number, width: number, height: number): void;
  setDisplayMethod(mode: "PLAYER_DISPLAY_MODE_LETTER_BOX" | "PLAYER_DISPLAY_MODE_FULL_SCREEN" | "PLAYER_DISPLAY_MODE_AUTO_ASPECT_RATIO"): void;
  setListener?(listener: {
    oncurrentplaytime?(milliseconds: number): void;
    onbufferingstart?(): void;
    onbufferingcomplete?(): void;
    onstreamcompleted?(): void;
    onerror?(error: unknown): void;
  }): void;
}

interface AvPlayStreamInfo {
  type?: string;
  index?: number | string;
  extra_info?: string;
}

interface WebApisGlobal {
  avplay?: AvPlayApi;
}

function avplay(): AvPlayApi | undefined {
  return (globalThis as typeof globalThis & { webapis?: WebApisGlobal }).webapis?.avplay;
}

export function isTizenAvPlayAvailable(): boolean {
  return avplay() !== undefined;
}

export interface TizenAvPlayPlayerOptions {
  /** Overrides the normal five second live/VOD buffer target. */
  bufferSeconds?: number;
}

/**
 * Tizen's AVPlay uses a hardware video plane, unlike an HTML video element.
 * Keep it isolated so browser development stays independent of Tizen globals.
 */
export class TizenAvPlayPlayer implements MediaPlayer {
  private opened = false;
  private displayMode: VideoDisplayMode = "auto";
  private subtitleCues: SubtitleCue[] = [];
  private visibleCue = "";
  private subtitleOffsetMilliseconds = 0;
  private subtitlesEnabled = true;
  private currentPlayheadMilliseconds = 0;
  private generation = 0;
  private paused = false;
  private jumpInFlight = false;
  private queuedJumpMilliseconds = 0;
  private isPrepared = false;
  private pendingSeekMilliseconds: number | null = null;
  private eventHandlers: MediaPlayerEventHandlers | null = null;
  private liveSubtitleMode = false;
  private liveSubtitleSilent: boolean | undefined;
  private embeddedSubtitleTracksSignature = "";
  private audioTracksSignature = "";
  private defaultAudioSelectionAttempted = false;
  private liveAudioMetadataUrl = "";
  private liveAudioMetadataPending = false;
  private liveAudioLanguages: string[] = [];
  private liveAudioMetadataStatus: LiveTsAudioProbeResult["status"] | "pending" | "not-started" = "not-started";
  private liveDvbSubtitleUrl = "";
  private liveDvbFeed: TizenLiveDvbSubtitleFeed | undefined;
  private liveDvbTracks: TizenDvbTrack[] = [];
  private liveDvbEnabled = false;

  constructor(
    private readonly container: HTMLElement,
    private readonly onSubtitleCue: (text: string) => void,
    private readonly options: TizenAvPlayPlayerOptions = {},
  ) {}

  setEventHandlers(handlers: MediaPlayerEventHandlers | null): void {
    this.eventHandlers = handlers;
  }

  setLiveSubtitleMode(enabled: boolean): void {
    this.liveSubtitleMode = enabled;
    if (enabled) this.setLiveAvPlaySubtitleSilent(true);
  }

  setLiveAudioMetadataUrl(url: string): void {
    this.liveAudioMetadataUrl = url;
  }

  setLiveDvbSubtitleUrl(url: string): void { this.liveDvbSubtitleUrl = url; }

  setLiveDvbSubtitleEnabled(enabled: boolean): void {
    this.liveDvbEnabled = enabled;
    if (!enabled) {
      this.liveDvbFeed?.setEnabled(false);
      return;
    }
    this.setLiveAvPlaySubtitleSilent(true);
    this.liveDvbFeed?.setEnabled(true);
    this.startLiveDvbFeed();
  }

  getLiveDvbSubtitleStatus(): string {
    if (!this.liveDvbSubtitleUrl) return "DVB subtitle feed not configured";
    if (!this.liveDvbEnabled && !this.liveDvbFeed) return "DVB subtitle scan not started";
    const status = this.liveDvbFeed?.getStatus() ?? "pending";
    if (status === "available") return "DVB subtitle tracks found";
    if (status === "unavailable") return "DVB subtitle stream unavailable";
    return "DVB subtitle stream pending";
  }

  getLiveDvbSubtitleDiagnostics(): string {
    return this.liveDvbFeed?.getDiagnostics() ?? "dvb p=na vp=na sp=na map=na d=na r=0 +0 -0";
  }

  isAudioTrackSelectionPending(): boolean {
    return this.liveAudioMetadataPending;
  }

  getLiveAudioMetadataStatus(): string {
    const labels: Record<typeof this.liveAudioMetadataStatus, string> = {
      pending: "TS probe pending",
      "not-started": "TS probe not started",
      ok: "TS language metadata found",
      "no-audio-metadata": "TS probe found no audio languages",
      "request-failed": "TS probe request failed",
      timeout: "TS probe timed out",
      unsupported: "TS probe unavailable",
    };
    return labels[this.liveAudioMetadataStatus];
  }

  load(streamUrl: string): void {
    const liveAudioMetadataUrl = this.liveAudioMetadataUrl;
    const liveDvbSubtitleUrl = this.liveDvbSubtitleUrl;
    this.destroy();
    this.liveAudioMetadataUrl = liveAudioMetadataUrl;
    this.liveDvbSubtitleUrl = liveDvbSubtitleUrl;
    const player = avplay();
    if (!player) {
      this.emit("error");
      return;
    }
    const generation = this.generation;
    this.liveAudioMetadataPending = this.liveSubtitleMode && Boolean(this.liveAudioMetadataUrl);
    this.liveAudioLanguages = [];
    this.liveAudioMetadataStatus = this.liveAudioMetadataPending ? "pending" : "not-started";
    this.emit("loading");
    try {
      player.open(streamUrl);
      this.opened = true;
      // Match the local browser media proxy: some providers reject requests
      // with no User-Agent. AVPlay properties must be set after open(), before
      // prepareAsync(), while the player is IDLE.
      try {
        player.setStreamingProperty?.("USER_AGENT", "Mozilla/5.0 (compatible; Substream/0.1)");
      } catch { /* Older firmware may reject an override; retain its native agent. */ }
      if (this.liveAudioMetadataPending) {
        void probeLiveTsAudioMetadata(this.liveAudioMetadataUrl).then((result) => {
          if (!this.isCurrent(generation)) return;
          this.liveAudioMetadataPending = false;
          this.liveAudioMetadataStatus = result.status;
          this.liveAudioLanguages = result.tracks.map((track) => track.language ?? "");
          this.audioTracksSignature = "";
          this.selectDefaultAudioTrack();
          this.emitAudioTracksIfChanged();
        });
      }
      this.paused = false;
      this.configureBuffering(player, /\/api\/local-media\/[a-f0-9]{32}(?:[?]|$)/.test(streamUrl));
      this.setDisplayRect(player);
      this.applyDisplayMode(player);
      player.setListener?.({
        oncurrentplaytime: (milliseconds) => {
          if (!this.isCurrent(generation)) return;
          this.currentPlayheadMilliseconds = milliseconds;
          this.liveDvbFeed?.setTime(milliseconds / 1_000);
          this.updateSubtitle(milliseconds);
          this.emitProgress(milliseconds, player);
          this.emitEmbeddedSubtitleTracksIfChanged();
          this.selectDefaultAudioTrack();
          this.emitAudioTracksIfChanged();
        },
        onbufferingstart: () => { if (this.isCurrent(generation)) this.emit("buffering"); },
        onbufferingcomplete: () => {
          if (!this.isCurrent(generation)) return;
          this.emitEmbeddedSubtitleTracksIfChanged();
          this.selectDefaultAudioTrack();
          this.emitAudioTracksIfChanged();
          if (!this.paused) this.emit("playing");
        },
        onstreamcompleted: () => { if (this.isCurrent(generation)) { this.paused = true; this.emit("ended"); } },
        onerror: () => { if (this.isCurrent(generation)) this.fail(generation); },
      });
      player.prepareAsync(
          () => {
            if (!this.isCurrent(generation)) return;
            this.isPrepared = true;
            this.setLiveAvPlaySubtitleSilent(true);
            this.startLiveDvbFeed();
          this.emitEmbeddedSubtitleTracksIfChanged();
          this.selectDefaultAudioTrack();
          this.emitAudioTracksIfChanged();
          const pendingSeek = this.pendingSeekMilliseconds;
          this.pendingSeekMilliseconds = null;
          if (pendingSeek !== null && pendingSeek > 0) {
            if (player.seekTo) {
              try {
                player.seekTo(pendingSeek, () => { if (this.isCurrent(generation)) this.play(); }, () => { if (this.isCurrent(generation)) this.play(); });
                return;
              } catch {
                // Fall back to a relative jump if this firmware rejects seeking before play.
              }
            }
            this.play();
            if (this.isCurrent(generation) && pendingSeek > this.currentPlayheadMilliseconds) {
              this.startJump(generation, pendingSeek - this.currentPlayheadMilliseconds);
            }
            return;
          }
          this.play();
        },
        () => this.fail(generation),
      );
    } catch {
      this.fail(generation);
    }
  }

  play(): void {
    if (!this.opened) return;
    try {
      const player = avplay();
      if (!player) throw new Error("AVPlay unavailable");
      player.play();
      this.paused = false;
      this.emit("playing");
      this.emitEmbeddedSubtitleTracksIfChanged();
      this.emitAudioTracksIfChanged();
    } catch {
      this.fail(this.generation);
    }
  }

  pause(): void {
    if (!this.opened) return;
    try {
      const player = avplay();
      if (!player) throw new Error("AVPlay unavailable");
      player.pause();
      this.paused = true;
      this.emit("paused");
    } catch {
      this.fail(this.generation);
    }
  }

  restart(): void {
    const player = avplay();
    if (!this.opened || !player) return;
    try {
      const generation = this.generation;
      this.isPrepared = false;
      this.pendingSeekMilliseconds = null;
      this.emit("loading");
      player.stop();
      this.setDisplayRect(player);
      player.prepareAsync(
        () => { if (this.isCurrent(generation)) this.play(); },
        () => this.fail(generation),
      );
    } catch {
      this.fail(this.generation);
    }
  }

  skip(seconds: number): void {
    if (!this.opened || !Number.isFinite(seconds) || seconds === 0) return;
    const deltaMilliseconds = seconds * 1_000;
    if (this.jumpInFlight) {
      this.queuedJumpMilliseconds += deltaMilliseconds;
      return;
    }
    this.startJump(this.generation, deltaMilliseconds);
  }

  seekTo(seconds: number): void {
    if (!Number.isFinite(seconds) || seconds <= 0) return;
    const targetMilliseconds = Math.round(seconds * 1_000);
    const player = avplay();
    if (!this.opened || !player || !this.isPrepared) {
      this.pendingSeekMilliseconds = targetMilliseconds;
      return;
    }
    try {
      if (player.seekTo) {
        player.seekTo(targetMilliseconds, () => undefined, () => undefined);
      } else {
        const delta = targetMilliseconds - this.currentPlayheadMilliseconds;
        if (delta > 0) this.startJump(this.generation, delta);
      }
    } catch {
      // Resume is best effort on firmware whose stream does not support seeking.
    }
  }

  getVideoResolution(): string | null {
    const player = avplay();
    if (!this.opened || !player?.getCurrentStreamInfo) return null;
    try {
      for (const stream of player.getCurrentStreamInfo()) {
        if (stream.type?.toLowerCase() !== "video" || !stream.extra_info) continue;
        let width: number;
        let height: number;
        try {
          const details: unknown = JSON.parse(stream.extra_info);
          if (!details || typeof details !== "object") continue;
          const values = details as Record<string, unknown>;
          width = Number(values.Width ?? values.width);
          height = Number(values.Height ?? values.height);
        } catch {
          // Some older firmware returns object-like text that is not strict JSON.
          const widthValue = stream.extra_info.match(/(?:"?Width"?)\s*:\s*"?(\d+)/i)?.[1];
          const heightValue = stream.extra_info.match(/(?:"?Height"?)\s*:\s*"?(\d+)/i)?.[1];
          width = Number(widthValue);
          height = Number(heightValue);
        }
        if (Number.isSafeInteger(width) && Number.isSafeInteger(height) && width > 0 && height > 0) {
          return `${width} × ${height}`;
        }
      }
    } catch {
      // Firmware can reject stream-info queries before a video track is ready.
    }
    return null;
  }

  getAudioTracks(): AudioTrack[] {
    const player = avplay();
    if (!this.opened || !player?.getTotalTrackInfo) return [];
    try {
      const selectedIndex = this.getSelectedTrackIndex(player, "AUDIO");
      const streams = player.getTotalTrackInfo()
        .filter((stream) => stream.type?.toUpperCase() === "AUDIO" && avPlayTrackIndex(stream.index) !== undefined);
      const canMapPmtLanguages = this.liveAudioLanguages.length === streams.length;
      return streams.map((stream, ordinal) => audioTrackFromAvPlay(
        stream,
        avPlayTrackIndex(stream.index) === selectedIndex,
        canMapPmtLanguages ? this.liveAudioLanguages[ordinal] : undefined,
      ));
    } catch {
      // AVPlay limits track queries to ready, playing, and paused states.
      return [];
    }
  }

  getTrackDiagnostics(): string {
    const player = avplay();
    if (!player?.getTotalTrackInfo) return "AVPlay track API missing";
    try {
      const tracks = player.getTotalTrackInfo();
      if (!Array.isArray(tracks)) return "AVPlay track list invalid";
      const count = (type: string) => tracks.filter((track) => track.type?.toUpperCase() === type).length;
      return `AVPlay tracks: ${count("AUDIO")} audio, ${count("TEXT")} subtitle, ${count("VIDEO")} video · ${this.getLiveAudioMetadataStatus()}`;
    } catch {
      return "AVPlay track query failed";
    }
  }

  selectAudioTrack(id: string): boolean {
    const index = Number(id);
    const player = avplay();
    if (!this.opened || !player?.setSelectTrack || !Number.isInteger(index) || index < 0) return false;
    try {
      player.setSelectTrack("AUDIO", index);
      this.defaultAudioSelectionAttempted = true;
      return true;
    } catch {
      return false;
    }
  }

  private selectDefaultAudioTrack(): void {
    if (this.defaultAudioSelectionAttempted) return;
    if (this.liveAudioMetadataPending) return;
    const tracks = this.getAudioTracks();
    if (tracks.length === 0) return;
    const preferred = tracks.find((track) => isFinnishLanguage(track.language))
      ?? tracks.find((track) => isEnglishLanguage(track.language));
    // AVPlay has already selected the stream default. Do not replace it with
    // the first listed track when neither preferred language is available.
    if (!preferred) { this.defaultAudioSelectionAttempted = true; return; }
    if (preferred.selected) { this.defaultAudioSelectionAttempted = true; return; }
    this.selectAudioTrack(preferred.id);
  }

  getEmbeddedSubtitleTracks(): EmbeddedSubtitleTrack[] {
    const player = avplay();
    if (!this.opened || !player?.getTotalTrackInfo) return [...this.liveDvbTracks];
    try {
      const selectedIndex = this.getSelectedTrackIndex(player, "TEXT");
      const native = player.getTotalTrackInfo()
        .filter((stream) => stream.type?.toUpperCase() === "TEXT" && avPlayTrackIndex(stream.index) !== undefined)
        .map((stream) => subtitleTrackFromAvPlay(stream, avPlayTrackIndex(stream.index) === selectedIndex));
      return [...this.liveDvbTracks, ...native];
    } catch {
      return [...this.liveDvbTracks];
    }
  }

  private getSelectedTrackIndex(player: AvPlayApi, type: "AUDIO" | "TEXT"): number | undefined {
    try {
      const selected = player.getCurrentStreamInfo?.()
        .find((stream) => stream.type?.toUpperCase() === type);
      return avPlayTrackIndex(selected?.index);
    } catch {
      // Older AVPlay versions can reject the current-stream query even while
      // the full track list is available. Selection state is optional.
      return undefined;
    }
  }

  selectEmbeddedSubtitleTrack(id: string): boolean {
    if (id.startsWith("dvb:")) {
      if (!this.liveSubtitleMode || !this.liveDvbFeed?.select(id)) return false;
      this.liveDvbEnabled = true;
      this.setLiveAvPlaySubtitleSilent(true);
      this.emitEmbeddedSubtitleTracksIfChanged();
      return true;
    }
    if (this.liveSubtitleMode && id === "off") {
      this.liveDvbEnabled = false;
      this.liveDvbFeed?.select(undefined);
      return this.setLiveAvPlaySubtitleSilent(true);
    }
    const index = Number(id);
    const player = avplay();
    if (!this.opened || !player?.setSelectTrack || !Number.isInteger(index) || index < 0) return false;
    try {
      player.setSelectTrack("TEXT", index);
      if (this.liveSubtitleMode && !this.setLiveAvPlaySubtitleSilent(false)) return false;
      return true;
    } catch {
      return false;
    }
  }

  setDisplayMode(mode: VideoDisplayMode): void {
    this.displayMode = mode;
    const player = avplay();
    if (!this.opened || !player) return;
    try { this.applyDisplayMode(player); } catch { this.fail(this.generation); }
  }

  resize(): void {
    const player = avplay();
    if (!this.opened || !player) return;
    try { this.setDisplayRect(player); } catch { /* The surface may be transitioning states. */ }
  }

  private setDisplayRect(player: AvPlayApi): void {
    const rect = this.container.getBoundingClientRect();
    // AVPlay always uses a 1920x1080 coordinate system, independently of the
    // app viewport. Its display area must be set while in the idle state.
    const viewportWidth = typeof document === "undefined"
      ? 1920
      : Math.max(1, document.documentElement.clientWidth || window.innerWidth || 1920);
    const ratio = 1920 / viewportWidth;
    player.setDisplayRect(
      Math.round(rect.left * ratio),
      Math.round(rect.top * ratio),
      Math.max(1, Math.round(rect.width * ratio)),
      Math.max(1, Math.round(rect.height * ratio)),
    );
  }

  private applyDisplayMode(player: AvPlayApi): void {
    const modeByName: Record<VideoDisplayMode, "PLAYER_DISPLAY_MODE_LETTER_BOX" | "PLAYER_DISPLAY_MODE_FULL_SCREEN" | "PLAYER_DISPLAY_MODE_AUTO_ASPECT_RATIO"> = {
      auto: "PLAYER_DISPLAY_MODE_AUTO_ASPECT_RATIO",
      fit: "PLAYER_DISPLAY_MODE_LETTER_BOX",
      fill: "PLAYER_DISPLAY_MODE_FULL_SCREEN",
    };
    player.setDisplayMethod(modeByName[this.displayMode]);
  }

  private configureBuffering(player: AvPlayApi, localMedia = false): void {
    if (!player.setBufferingParam) return;
    // AVPlay accepts these settings only in IDLE, after open() and before prepareAsync().
    // Local progressive files get ten seconds of headroom for Wi-Fi jitter.
    const configuredSeconds = this.options.bufferSeconds;
    const seconds = Number.isFinite(configuredSeconds) && configuredSeconds! >= 1 && configuredSeconds! <= 30
      ? Math.round(configuredSeconds!)
      : localMedia ? 10 : 5;
    // Use the same threshold for initial playback and rebuffering. A much
    // larger resume threshold makes AVPlay wait for a different amount of media
    // after a stall, which can amplify timestamp discontinuities on older TVs.
    try { player.setBufferingParam("PLAYER_BUFFER_FOR_PLAY", "PLAYER_BUFFER_SIZE_IN_SECOND", seconds); } catch { /* Older AVPlay versions may not support this setting. */ }
    try { player.setBufferingParam("PLAYER_BUFFER_FOR_RESUME", "PLAYER_BUFFER_SIZE_IN_SECOND", seconds); } catch { /* Buffer tuning must not prevent playback. */ }
  }

  async setSubtitle(subtitleText: string, _label: string, _language: string): Promise<SubtitleAttachment> {
    if (!this.opened) return { enabled: false, reason: "AVPlay is not ready." };
    this.subtitleCues = parseSrtCues(subtitleText);
    this.subtitlesEnabled = true;
    this.visibleCue = "";
    this.onSubtitleCue("");
    this.updateSubtitle(this.currentPlayheadMilliseconds);
    return this.subtitleCues.length > 0
      ? { enabled: true }
      : { enabled: false, reason: "The selected subtitle has no usable SRT cues." };
  }

  setSubtitleTimingOffset(offsetSeconds: number): void {
    this.subtitleOffsetMilliseconds = normalizeSubtitleOffsetSeconds(offsetSeconds) * 1_000;
    this.updateSubtitle(this.currentPlayheadMilliseconds);
  }

  setSubtitleEnabled(enabled: boolean): void {
    if (this.liveSubtitleMode) {
      this.liveDvbEnabled = enabled;
      this.liveDvbFeed?.setEnabled(enabled);
      this.setLiveAvPlaySubtitleSilent(true);
    }
    if (this.subtitleCues.length === 0) return;
    this.subtitlesEnabled = enabled;
    this.updateSubtitle(this.currentPlayheadMilliseconds);
  }

  private updateSubtitle(milliseconds: number): void {
    const cue = this.subtitlesEnabled
      ? this.subtitleCues.find((candidate) => milliseconds >= candidate.startMs + this.subtitleOffsetMilliseconds
        && milliseconds < candidate.endMs + this.subtitleOffsetMilliseconds)
      : undefined;
    const text = cue?.text ?? "";
    if (text === this.visibleCue) return;
    this.visibleCue = text;
    this.onSubtitleCue(text);
  }

  private isCurrent(generation: number): boolean {
    return this.opened && this.generation === generation;
  }

  private startJump(generation: number, deltaMilliseconds: number): void {
    if (!this.isCurrent(generation) || deltaMilliseconds === 0) return;
    const player = avplay();
    if (!player) return;
    this.jumpInFlight = true;
    const onComplete = (): void => {
      if (!this.isCurrent(generation)) return;
      this.jumpInFlight = false;
      const queued = this.queuedJumpMilliseconds;
      this.queuedJumpMilliseconds = 0;
      if (queued !== 0) this.startJump(generation, queued);
    };
    try {
      if (deltaMilliseconds > 0) player.jumpForward(deltaMilliseconds, onComplete, onComplete);
      else player.jumpBackward(Math.abs(deltaMilliseconds), onComplete, onComplete);
    } catch {
      // A rejected seek must not tear down an otherwise healthy playback session.
      onComplete();
    }
  }

  private emit(state: PlaybackState): void {
    this.eventHandlers?.onStateChange(state);
  }

  private setLiveAvPlaySubtitleSilent(silent: boolean): boolean {
    const player = avplay();
    if (!this.liveSubtitleMode || !player || !this.opened || !player.setSilentSubtitle) return false;
    if (this.liveSubtitleSilent === silent) return true;
    try { player.setSilentSubtitle(silent); this.liveSubtitleSilent = silent; return true; } catch { return false; }
  }

  private startLiveDvbFeed(): void {
    if (!this.liveSubtitleMode || !this.liveDvbEnabled || !this.liveDvbSubtitleUrl || this.liveDvbFeed) return;
    try {
      this.liveDvbFeed = new TizenLiveDvbSubtitleFeed(
        this.liveDvbSubtitleUrl,
        this.container,
        () => this.currentPlayheadMilliseconds / 1_000,
        (tracks) => {
          this.liveDvbTracks = tracks.map((track) => ({ id: track.id, label: track.label, language: track.language, selected: track.selected }));
          this.embeddedSubtitleTracksSignature = "";
          this.emitEmbeddedSubtitleTracksIfChanged();
        },
        () => { /* A sideband metadata failure must not interrupt AVPlay. */ },
      );
      this.liveDvbFeed.setEnabled(this.liveDvbEnabled);
      this.liveDvbFeed.start();
    } catch {
      this.liveDvbFeed?.dispose();
      this.liveDvbFeed = undefined;
    }
  }

  private emitEmbeddedSubtitleTracksIfChanged(): void {
    if (!this.liveSubtitleMode) return;
    const tracks = this.getEmbeddedSubtitleTracks();
    const signature = JSON.stringify(tracks);
    if (signature === this.embeddedSubtitleTracksSignature) return;
    this.embeddedSubtitleTracksSignature = signature;
    this.eventHandlers?.onEmbeddedSubtitleTracksChange?.(tracks);
  }

  private emitAudioTracksIfChanged(): void {
    if (!this.liveSubtitleMode) return;
    const tracks = this.getAudioTracks();
    const signature = JSON.stringify(tracks);
    if (signature === this.audioTracksSignature) return;
    this.audioTracksSignature = signature;
    this.eventHandlers?.onAudioTracksChange?.(tracks);
  }

  private emitProgress(currentTimeMilliseconds: number, player: AvPlayApi): void {
    if (!Number.isFinite(currentTimeMilliseconds)) return;
    if (!player.getDuration) {
      if (this.liveSubtitleMode) this.eventHandlers?.onProgress?.({ currentTimeSeconds: Math.max(0, currentTimeMilliseconds / 1_000), durationSeconds: 0 });
      return;
    }
    try {
      const durationMilliseconds = player.getDuration();
      if (!Number.isFinite(durationMilliseconds) || durationMilliseconds <= 0) {
        if (this.liveSubtitleMode) this.eventHandlers?.onProgress?.({ currentTimeSeconds: Math.max(0, currentTimeMilliseconds / 1_000), durationSeconds: 0 });
        return;
      }
      this.eventHandlers?.onProgress?.({
        currentTimeSeconds: Math.max(0, currentTimeMilliseconds / 1_000),
        durationSeconds: durationMilliseconds / 1_000,
      });
    } catch {
      // Duration may be unavailable while AVPlay is preparing the stream.
      if (this.liveSubtitleMode) this.eventHandlers?.onProgress?.({ currentTimeSeconds: Math.max(0, currentTimeMilliseconds / 1_000), durationSeconds: 0 });
    }
  }

  private fail(generation: number): void {
    if (generation !== this.generation) return;
    this.destroy();
    this.emit("error");
  }

  destroy(): void {
    this.generation += 1;
    this.jumpInFlight = false;
    this.queuedJumpMilliseconds = 0;
    this.onSubtitleCue("");
    this.subtitleCues = [];
    this.visibleCue = "";
    this.subtitleOffsetMilliseconds = 0;
    this.subtitlesEnabled = true;
    this.liveSubtitleSilent = undefined;
    this.currentPlayheadMilliseconds = 0;
    this.paused = false;
    this.isPrepared = false;
    this.pendingSeekMilliseconds = null;
    this.embeddedSubtitleTracksSignature = "";
    this.audioTracksSignature = "";
    this.defaultAudioSelectionAttempted = false;
    this.liveAudioMetadataPending = false;
    this.liveDvbFeed?.dispose();
    this.liveDvbFeed = undefined;
    this.liveDvbTracks = [];
    this.liveAudioLanguages = [];
    this.liveAudioMetadataStatus = "not-started";
    this.liveAudioMetadataUrl = "";
    this.liveDvbSubtitleUrl = "";
    if (!this.opened) return;
    const player = avplay();
    this.opened = false;
    if (!player) return;
    try { player.stop(); } catch { /* AVPlay can already be stopped. */ }
    try { player.close(); } catch { /* Closing an errored AVPlay session can fail. */ }
  }
}

function audioTrackFromAvPlay(stream: AvPlayStreamInfo, selected: boolean, inferredLanguage?: string): AudioTrack {
  const details = parseStreamDetails(stream.extra_info);
  const language = readStreamText(details, "language", "track_lang", "lang") ?? inferredLanguage;
  const codec = readStreamText(details, "codec", "fourCC", "fourcc");
  const channels = readStreamText(details, "channels", "channel");
  const label = [language, codec, channels].filter(Boolean).join(" · ") || `Audio ${(avPlayTrackIndex(stream.index) ?? 0) + 1}`;
  return { id: String(stream.index), label, ...(language ? { language } : {}), ...(codec ? { codec } : {}), selected };
}

function isFinnishLanguage(language: string | undefined): boolean {
  const code = language?.trim().toLowerCase().split(/[-_]/, 1)[0];
  return code === "fi" || code === "fin" || code === "finnish";
}

function isEnglishLanguage(language: string | undefined): boolean {
  const code = language?.trim().toLowerCase().split(/[-_]/, 1)[0];
  return code === "en" || code === "eng" || code === "english";
}

function subtitleTrackFromAvPlay(stream: AvPlayStreamInfo, selected: boolean): EmbeddedSubtitleTrack {
  const details = parseStreamDetails(stream.extra_info);
  const language = readStreamText(details, "language", "track_lang", "lang");
  const codec = readStreamText(details, "codec", "fourCC", "fourcc", "format");
  const label = [language, codec].filter(Boolean).join(" · ") || `Subtitle ${(avPlayTrackIndex(stream.index) ?? 0) + 1}`;
  return { id: String(stream.index), label, ...(language ? { language } : {}), selected };
}

function avPlayTrackIndex(index: number | string | undefined): number | undefined {
  if (typeof index === "number") return Number.isSafeInteger(index) && index >= 0 ? index : undefined;
  if (typeof index === "string" && /^\d+$/.test(index)) {
    const parsed = Number(index);
    return Number.isSafeInteger(parsed) ? parsed : undefined;
  }
  return undefined;
}

function parseStreamDetails(extraInfo: string | undefined): Record<string, unknown> {
  if (!extraInfo) return {};
  try {
    const parsed: unknown = JSON.parse(extraInfo);
    return parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function readStreamText(details: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = details[key];
    if (typeof value !== "string" && typeof value !== "number") continue;
    const cleaned = String(value).replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 80);
    if (cleaned) return cleaned;
  }
  return undefined;
}
