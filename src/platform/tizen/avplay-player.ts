import { positiveMetadataNumber, technicalToken } from "../stream-information.ts";
import { enrichEmbeddedSubtitleTracks } from "../../core/subtitles/embedded-metadata.ts";
import type { MatroskaSubtitleTrack } from "../../core/subtitles/matroska.ts";
import type { AudioTrack, EmbeddedSubtitleTrack, MediaPlayer, MediaPlayerEventHandlers, PlaybackState, StreamInformation, SubtitleAttachment, VideoDisplayMode } from "../media-player.ts";
import { parseSrtCues, type SubtitleCue } from "../../core/subtitles/srt-cues.ts";
import { normalizeSubtitleText } from "../../core/subtitles/normalize.ts";
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
  getCurrentTime?(): number;
  getCurrentStreamInfo?(): AvPlayStreamInfo[];
  getTotalTrackInfo?(): AvPlayStreamInfo[];
  setSelectTrack?(trackType: "AUDIO" | "TEXT", index: number): void;
  setSilentSubtitle?(silent: boolean): void;
  setSubtitlePosition?(milliseconds: number): void;
  setStreamingProperty?(property: "USER_AGENT", value: string): void;
  setBufferingParam?(bufferingType: "PLAYER_BUFFER_FOR_PLAY" | "PLAYER_BUFFER_FOR_RESUME", parameter: "PLAYER_BUFFER_SIZE_IN_SECOND", value: number): void;
  setDisplayRect(left: number, top: number, width: number, height: number): void;
  setDisplayMethod(mode: "PLAYER_DISPLAY_MODE_LETTER_BOX" | "PLAYER_DISPLAY_MODE_FULL_SCREEN" | "PLAYER_DISPLAY_MODE_AUTO_ASPECT_RATIO"): void;
  setListener?(listener: {
    oncurrentplaytime?(milliseconds: number): void;
    onbufferingstart?(): void;
    onbufferingcomplete?(): void;
    onstreamcompleted?(): void;
    onsubtitlechange?(durationMilliseconds: number | string, text: string, data3?: unknown, data4?: unknown): void;
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
  /** Native rendering avoids relying on silent-mode cue delivery on TV firmware. */
  embeddedSubtitleRendering?: "native" | "overlay";
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
  private nativeSubtitleTimingSupported: boolean | undefined;
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
  private vodSubtitleMode = false;
  private vodSubtitleMetadata: readonly MatroskaSubtitleTrack[] = [];
  private vodSubtitleDiscoveryComplete = false;
  private selectedVodSubtitleTrackId: string | undefined;
  private vodEmbeddedSubtitleEnabled = false;
  private subtitleCueTimer: ReturnType<typeof setTimeout> | undefined;
  private embeddedCueExpiresAtMilliseconds: number | undefined;
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

  setVodSubtitleMode(enabled: boolean): void {
    this.vodSubtitleMode = enabled;
    this.vodSubtitleDiscoveryComplete = false;
    if (enabled && this.isPrepared) this.setNativeSubtitleSilent(true);
    this.emitEmbeddedSubtitleTracksIfChanged();
  }

  isVodSubtitleDiscoveryComplete(): boolean { return this.vodSubtitleDiscoveryComplete; }

  setVodSubtitleMetadata(tracks: readonly MatroskaSubtitleTrack[]): void {
    this.vodSubtitleMetadata = [...tracks];
    this.emitEmbeddedSubtitleTracksIfChanged();
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
    this.vodSubtitleMetadata = [];
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
      // prepareAsync READY does not permit setSilentSubtitle on all firmware.
      // Configure callbacks while IDLE, then reassert after playback/selection.
      if (this.liveSubtitleMode || this.vodSubtitleMode) this.setNativeSubtitleSilent(true);
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
          this.expireEmbeddedSubtitleCue(milliseconds);
          this.liveDvbFeed?.setTime(milliseconds / 1_000);
          this.updateSubtitle(milliseconds);
          this.emitProgress(milliseconds, player);
          this.emitEmbeddedSubtitleTracksIfChanged();
          this.selectDefaultAudioTrack();
          this.emitAudioTracksIfChanged();
        },
        onsubtitlechange: (durationMilliseconds, text) => {
          if (!this.isCurrent(generation) || !this.vodSubtitleMode || this.liveSubtitleMode || !this.vodEmbeddedSubtitleEnabled || !this.selectedVodSubtitleTrackId || this.options.embeddedSubtitleRendering !== "overlay") return;
          if (typeof text !== "string") return;
          if (this.subtitleCueTimer) clearTimeout(this.subtitleCueTimer);
          const cue = normalizeSubtitleText(text).trim();
          this.onSubtitleCue(cue);
          // AVPlay declares duration as DOMString milliseconds; some firmware
          // returns a number instead. Validate after conversion, not before.
          const numericDuration = Number(durationMilliseconds);
          const duration = Number.isFinite(numericDuration) ? Math.max(0, Math.min(numericDuration, 60_000)) : 0;
          this.embeddedCueExpiresAtMilliseconds = this.subtitlePlayhead(player) + duration;
          this.subtitleCueTimer = setTimeout(() => {
            this.subtitleCueTimer = undefined;
            if (this.isCurrent(generation)) this.expireEmbeddedSubtitleCue(this.subtitlePlayhead(player));
          }, duration);
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
            if (this.liveSubtitleMode || this.vodSubtitleMode) this.setNativeSubtitleSilent(true);
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
      if (this.liveSubtitleMode || this.vodSubtitleMode) {
        const silent = this.selectedVodSubtitleTrackId
          ? !this.vodEmbeddedSubtitleEnabled || this.options.embeddedSubtitleRendering === "overlay"
          : this.liveSubtitleSilent ?? true;
        this.liveSubtitleSilent = undefined;
        this.setNativeSubtitleSilent(silent);
      }
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
    if (this.selectedVodSubtitleTrackId) this.clearSubtitleCue();
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
        if (this.selectedVodSubtitleTrackId) this.clearSubtitleCue();
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

  getStreamInformation(): StreamInformation {
    const info: StreamInformation = {};
    const player = avplay();
    if (!this.opened || !player) return info;
    try {
      const current = player.getCurrentStreamInfo?.() ?? [];
      const video = parseStreamDetails(current.find((track) => track.type?.toUpperCase() === "VIDEO")?.extra_info);
      const audio = parseStreamDetails(current.find((track) => track.type?.toUpperCase() === "AUDIO")?.extra_info);
      info.videoCodec = technicalToken(readStreamText(video, "codec", "fourCC", "fourcc"));
      info.audioCodec = technicalToken(readStreamText(audio, "codec", "fourCC", "fourcc"));
      info.frameRate = positiveMetadataNumber(video.frame_rate ?? video.framerate);
      info.videoBitrate = positiveMetadataNumber(video.bit_rate ?? video.bitrate);
      info.audioBitrate = positiveMetadataNumber(audio.bit_rate ?? audio.bitrate);
      info.audioChannels = positiveMetadataNumber(audio.channels);
      info.audioSampleRate = positiveMetadataNumber(audio.sample_rate);
      info.audioLanguage = technicalToken(readStreamText(audio, "language", "track_lang", "lang"));
    } catch { /* Firmware may not expose current metadata until prepared. */ }
    try {
      const tracks = player.getTotalTrackInfo?.();
      if (tracks) {
        info.audioTrackCount = tracks.filter((track) => track.type?.toUpperCase() === "AUDIO").length;
        info.subtitleTrackCount = tracks.filter((track) => track.type?.toUpperCase() === "TEXT").length + this.liveDvbTracks.length;
      }
      const audio = this.getAudioTracks().find((track) => track.selected);
      info.audioCodec ??= technicalToken(audio?.codec);
      info.audioLanguage ??= technicalToken(audio?.language);
      const subtitle = this.getEmbeddedSubtitleTracks().find((track) => track.selected);
      info.subtitleLanguage = technicalToken(subtitle?.language);
      info.subtitleCodec = technicalToken(subtitle?.codec);
    } catch { /* Track queries are state-dependent. */ }
    return info;
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

  getPlaybackDiagnostics(): string { return this.getTrackDiagnostics(); }
  getLiveAudioLanguageStatus(): string { return this.getLiveAudioMetadataStatus(); }

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
        .map((stream) => subtitleTrackFromAvPlay(stream, this.vodSubtitleMode
          ? this.selectedVodSubtitleTrackId === String(stream.index)
          : this.liveSubtitleSilent !== true && avPlayTrackIndex(stream.index) === selectedIndex));
      return [...this.liveDvbTracks, ...(this.vodSubtitleMode ? enrichEmbeddedSubtitleTracks(native, this.vodSubtitleMetadata) : native)];
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
    if ((this.liveSubtitleMode || this.vodSubtitleMode) && id === "off") {
      if (!this.setNativeSubtitleSilent(true)) return false;
      const turningOffEmbedded = this.selectedVodSubtitleTrackId !== undefined;
      this.selectedVodSubtitleTrackId = undefined;
      this.vodEmbeddedSubtitleEnabled = false;
      if (this.subtitleCues.length > 0) this.subtitlesEnabled = false;
      this.clearSubtitleCue();
      this.setNativeSubtitlePosition(0);
      if (turningOffEmbedded) this.subtitleOffsetMilliseconds = 0;
      this.liveDvbEnabled = false;
      this.liveDvbFeed?.select(undefined);
      return true;
    }
    const index = Number(id);
    const player = avplay();
    if (!this.opened || !player?.setSelectTrack || !Number.isInteger(index) || index < 0) return false;
    const previousIndex = this.getSelectedTrackIndex(player, "TEXT");
    try {
      player.setSelectTrack("TEXT", index);
      // Selecting TEXT can reset AVPlay's silent mode. Never let the cached
      // value prevent restoring callback delivery for the shared overlay.
      this.liveSubtitleSilent = undefined;
      if (this.vodSubtitleMode && !this.liveSubtitleMode) {
        if (!this.setNativeSubtitleSilent(this.options.embeddedSubtitleRendering === "overlay")) {
          if (previousIndex !== undefined) {
            try { player.setSelectTrack("TEXT", previousIndex); } catch { /* Preserve best effort if firmware rejects rollback. */ }
          }
          return false;
        }
        this.setNativeSubtitlePosition(0);
        this.subtitleCues = [];
        this.subtitlesEnabled = false;
        this.subtitleOffsetMilliseconds = 0;
        this.selectedVodSubtitleTrackId = id;
        this.vodEmbeddedSubtitleEnabled = true;
        this.clearSubtitleCue();
      } else if (this.liveSubtitleMode && !this.setNativeSubtitleSilent(false)) {
        if (previousIndex !== undefined) {
          try { player.setSelectTrack("TEXT", previousIndex); } catch { /* Preserve best effort if firmware rejects rollback. */ }
        }
        return false;
      }
      this.emitEmbeddedSubtitleTracksIfChanged();
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
    const cues = parseSrtCues(subtitleText);
    if (cues.length === 0) return { enabled: false, reason: "The selected subtitle has no usable SRT cues." };
    const switchingFromEmbedded = this.selectedVodSubtitleTrackId !== undefined;
    if ((this.liveSubtitleMode || this.vodSubtitleMode) && !this.setNativeSubtitleSilent(true)) {
      return { enabled: false, reason: "AVPlay could not hide its embedded subtitle track." };
    }
    this.setNativeSubtitlePosition(0);
    if (switchingFromEmbedded) this.subtitleOffsetMilliseconds = 0;
    this.selectedVodSubtitleTrackId = undefined;
    this.vodEmbeddedSubtitleEnabled = false;
    this.clearSubtitleCue();
    this.liveDvbEnabled = false;
    this.liveDvbFeed?.setEnabled(false);
    this.subtitleCues = cues;
    this.subtitlesEnabled = true;
    this.visibleCue = "";
    this.onSubtitleCue("");
    this.updateSubtitle(this.currentPlayheadMilliseconds);
    return { enabled: true };
  }

  setSubtitleTimingOffset(offsetSeconds: number): void {
    this.subtitleOffsetMilliseconds = normalizeSubtitleOffsetSeconds(offsetSeconds) * 1_000;
    if (this.selectedVodSubtitleTrackId) {
      this.setNativeSubtitlePosition(this.subtitleOffsetMilliseconds);
      return;
    }
    this.setNativeSubtitlePosition(0);
    this.updateSubtitle(this.currentPlayheadMilliseconds);
  }

  getSubtitleRenderingCapabilities(): { timingAdjustment: boolean; styling: boolean; sharedOverlay: boolean } {
    if (this.selectedVodSubtitleTrackId) return {
      timingAdjustment: this.nativeSubtitleTimingSupported === true,
      styling: this.options.embeddedSubtitleRendering === "overlay",
      sharedOverlay: this.options.embeddedSubtitleRendering === "overlay",
    };
    return this.subtitleCues.length > 0
      ? { timingAdjustment: true, styling: true, sharedOverlay: true }
      : { timingAdjustment: false, styling: false, sharedOverlay: false };
  }

  setSubtitleEnabled(enabled: boolean): void {
    if (this.liveSubtitleMode) {
      this.liveDvbEnabled = enabled;
      this.liveDvbFeed?.setEnabled(enabled);
      this.setLiveAvPlaySubtitleSilent(true);
    }
    if (this.selectedVodSubtitleTrackId) {
      this.vodEmbeddedSubtitleEnabled = enabled;
      this.setNativeSubtitleSilent(!enabled || this.options.embeddedSubtitleRendering === "overlay");
      if (!enabled) this.clearSubtitleCue();
    }
    if (this.vodSubtitleMode && this.subtitleCues.length > 0) this.setNativeSubtitleSilent(true);
    if (this.subtitleCues.length === 0) return;
    this.subtitlesEnabled = enabled;
    this.updateSubtitle(this.currentPlayheadMilliseconds);
  }

  private updateSubtitle(milliseconds: number): void {
    if (this.selectedVodSubtitleTrackId) return;
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
    if (this.selectedVodSubtitleTrackId) this.clearSubtitleCue();
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
    return this.setNativeSubtitleSilent(silent);
  }

  private setNativeSubtitleSilent(silent: boolean): boolean {
    const player = avplay();
    if ((!this.liveSubtitleMode && !this.vodSubtitleMode) || !player || !this.opened || !player.setSilentSubtitle) return false;
    if (this.liveSubtitleSilent === silent) return true;
    try { player.setSilentSubtitle(silent); this.liveSubtitleSilent = silent; return true; } catch { return false; }
  }

  private clearSubtitleCue(): void {
    if (this.subtitleCueTimer) clearTimeout(this.subtitleCueTimer);
    this.subtitleCueTimer = undefined;
    this.embeddedCueExpiresAtMilliseconds = undefined;
    this.visibleCue = "";
    this.onSubtitleCue("");
  }

  private subtitlePlayhead(player: AvPlayApi): number {
    try {
      const current = player.getCurrentTime?.();
      if (current !== undefined && Number.isFinite(current) && current >= 0) return current;
    } catch { /* Fall back to the latest playback-time callback. */ }
    return this.currentPlayheadMilliseconds;
  }

  private expireEmbeddedSubtitleCue(milliseconds: number): void {
    if (this.embeddedCueExpiresAtMilliseconds !== undefined && milliseconds >= this.embeddedCueExpiresAtMilliseconds) this.clearSubtitleCue();
  }

  private setNativeSubtitlePosition(milliseconds: number): void {
    const player = avplay();
    if (!player?.setSubtitlePosition || !this.opened) {
      this.nativeSubtitleTimingSupported = false;
      return;
    }
    try {
      player.setSubtitlePosition(milliseconds);
      this.nativeSubtitleTimingSupported = true;
    } catch {
      this.nativeSubtitleTimingSupported = false;
    }
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
    if (!this.liveSubtitleMode && !this.vodSubtitleMode) return;
    if (this.vodSubtitleMode && this.isPrepared) this.vodSubtitleDiscoveryComplete = true;
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
    this.clearSubtitleCue();
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
    this.selectedVodSubtitleTrackId = undefined;
    this.vodEmbeddedSubtitleEnabled = false;
    this.vodSubtitleDiscoveryComplete = false;
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
  const forced = readStreamBoolean(details, "forced", "is_forced");
  const hearingImpaired = readStreamBoolean(details, "hearing_impaired", "hearingImpaired", "sdh");
  const label = [language, codec].filter(Boolean).join(" · ") || `Subtitle ${(avPlayTrackIndex(stream.index) ?? 0) + 1}`;
  return {
    id: String(stream.index), label, ...(language ? { language } : {}), ...(codec ? { codec } : {}),
    ...(forced !== undefined ? { forced } : {}), ...(hearingImpaired !== undefined ? { hearingImpaired } : {}),
    playable: true, selected,
  };
}

function readStreamBoolean(details: Record<string, unknown>, ...keys: string[]): boolean | undefined {
  for (const key of keys) {
    const value = details[key];
    if (typeof value === "boolean") return value;
    if (typeof value === "number" && (value === 0 || value === 1)) return value === 1;
    if (typeof value === "string") {
      if (/^(true|yes|1)$/i.test(value.trim())) return true;
      if (/^(false|no|0)$/i.test(value.trim())) return false;
    }
  }
  return undefined;
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
