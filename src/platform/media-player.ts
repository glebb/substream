import type { MatroskaSubtitleTrack } from "../core/subtitles/matroska.ts";

export interface SubtitleAttachment {
  enabled: boolean;
  /** Safe, user-facing reason when a platform cannot attach the subtitle. */
  reason?: string;
}

/** Capabilities of the currently selected subtitle source, for honest UI controls. */
export interface SubtitleRenderingCapabilities {
  timingAdjustment: boolean;
  styling: boolean;
  sharedOverlay: boolean;
}

export type VideoDisplayMode = "auto" | "fit" | "fill";
export type PlaybackState = "loading" | "buffering" | "playing" | "paused" | "ended" | "error";

export type PlaybackRequest =
  | { kind: "vod"; streamUrl: string; titleId: string; resumeSeconds?: number }
  | { kind: "live"; streamUrl: string; channelId: string };

export type PlaybackCapabilities = {
  seek: boolean;
  restart: boolean;
  pause: boolean;
  tracks: boolean;
};

export function playbackCapabilities(request: PlaybackRequest): PlaybackCapabilities {
  return request.kind === "live"
    ? { seek: false, restart: false, pause: false, tracks: true }
    : { seek: true, restart: true, pause: true, tracks: true };
}

export interface PlaybackProgress {
  currentTimeSeconds: number;
  durationSeconds: number;
}

/**
 * A seekable, rolling portion of a live stream. It is present only when the
 * provider and playback engine expose DVR-style HLS segments; it is not an
 * estimate of how much data happens to be downloaded locally.
 */
export interface LiveBufferWindow {
  startSeconds: number;
  endSeconds: number;
  currentSeconds: number;
}

/** A user-selectable embedded audio rendition. Never contains a stream URL. */
export interface AudioTrack {
  /** Platform-specific, opaque identifier used only for selecting this track. */
  id: string;
  /** Short user-facing description, such as language and codec when available. */
  label: string;
  language?: string;
  codec?: string;
  selected: boolean;
}

/** An embedded subtitle rendition supplied with a live stream. */
export interface EmbeddedSubtitleTrack {
  /** Platform-specific, opaque identifier used only for selecting this track. */
  id: string;
  /** Short user-facing description, such as language and codec when available. */
  label: string;
  /** ISO 639 language code when the playback engine exposes one. */
  language?: string;
  forced?: boolean;
  hearingImpaired?: boolean;
  codec?: string;
  /** False when discovered but the active playback engine cannot render it. */
  playable?: boolean;
  selected: boolean;
}

/** Allowlisted technical values only; never URLs or raw provider metadata. */
export interface StreamInformation {
  videoCodec?: string | undefined;
  audioCodec?: string | undefined;
  frameRate?: number | undefined;
  videoBitrate?: number | undefined;
  streamBitrate?: number | undefined;
  audioBitrate?: number | undefined;
  audioChannels?: number | undefined;
  audioSampleRate?: number | undefined;
  audioTrackCount?: number | undefined;
  subtitleTrackCount?: number | undefined;
  audioLanguage?: string | undefined;
  subtitleLanguage?: string | undefined;
  subtitleCodec?: string | undefined;
  bufferedSeconds?: number | undefined;
  decodedFrames?: number | undefined;
  droppedFrames?: number | undefined;
}

export interface MediaPlayerEventHandlers {
  onStateChange(state: PlaybackState): void;
  onProgress?(progress: PlaybackProgress): void;
  onLiveBufferWindowChange?(window: LiveBufferWindow | null): void;
  /** Fires when selectable embedded audio renditions become available or change. */
  onAudioTracksChange?(tracks: AudioTrack[]): void;
  /** Fires when selectable embedded live subtitle renditions become available or change. */
  onEmbeddedSubtitleTracksChange?(tracks: EmbeddedSubtitleTrack[]): void;
}

export interface MediaPlayer {
  setEventHandlers(handlers: MediaPlayerEventHandlers | null): void;
  /** Enables automatic Finnish/English selection for embedded live subtitles. */
  setLiveSubtitleMode?(enabled: boolean): void;
  /** Enables discovery/selection of embedded VOD text tracks independently of live captions. */
  setVodSubtitleMode?(enabled: boolean): void;
  /** True once embedded VOD track discovery has completed for the current item. */
  isVodSubtitleDiscoveryComplete?(): boolean;
  /** Supplies file metadata to enrich native VOD tracks; never creates playable tracks. */
  setVodSubtitleMetadata?(tracks: readonly MatroskaSubtitleTrack[]): void;
  /** Supplies the direct transport-stream URL for bounded live track metadata probing. */
  setLiveAudioMetadataUrl?(url: string): void;
  /** Supplies a direct transport-stream URL for Tizen's standalone DVB sideband reader. */
  setLiveDvbSubtitleUrl?(url: string): void;
  /** Starts the higher-risk Tizen direct-TS caption scanner after explicit user opt-in. */
  setLiveDvbSubtitleEnabled?(enabled: boolean): void;
  /** Reports whether Tizen's standalone DVB subtitle feed is still discovering tracks. */
  getLiveDvbSubtitleStatus?(): string;
  /** Numeric-only, credential-safe timing and canvas counters for opted-in Tizen diagnostics. */
  getLiveDvbSubtitleDiagnostics?(): string;
  /** Indicates that a platform is still resolving live audio language defaults. */
  isAudioTrackSelectionPending?(): boolean;
  load(streamUrl: string): void;
  /** Seeks to an absolute playhead position, including while the stream is preparing. */
  seekTo?(seconds: number): void;
  /** Returns the provider's currently seekable live/DVR window, if it exposes one. */
  getLiveBufferWindow?(): LiveBufferWindow | null;
  /** Seeks within the reported live/DVR window. */
  seekLiveBuffer?(seconds: number): void;
  /** Returns playback to the newest available point of a live/DVR window. */
  goLive?(): void;
  /** Returns source dimensions only; never includes URLs. */
  getVideoResolution?(): string | null;
  /** Returns safe technical metadata exposed by the active playback engine. */
  getStreamInformation?(): StreamInformation;
  /** Safe player diagnostics for live audio/subtitle status UI. */
  getPlaybackDiagnostics?(): string;
  getLiveAudioLanguageStatus?(): string;
  getLiveDvbSubtitleStatus?(): string;
  getLiveSubtitleServiceStatus?(): string;
  getRelayDiagnostics?(): string;
  isSubtitleTimingTestPlayer?(): boolean;
  /** Lists embedded audio tracks when the playback engine makes them available. */
  getAudioTracks?(): AudioTrack[];
  /** Selects a previously listed audio track. Returns false when unsupported or rejected. */
  selectAudioTrack?(id: string): boolean;
  /** Lists subtitles embedded in the current stream. */
  getEmbeddedSubtitleTracks?(): EmbeddedSubtitleTrack[];
  /** Selects one embedded subtitle rendition. */
  selectEmbeddedSubtitleTrack?(id: string): boolean;
  play(): void;
  pause(): void;
  restart(): void;
  /** Moves playback by a signed number of seconds. */
  skip(seconds: number): void;
  /** Chooses whether video respects its source ratio, letterboxes, or fills. */
  setDisplayMode(mode: VideoDisplayMode): void;
  /** Repositions a platform video surface after its container changes size. */
  resize(): void;
  destroy(): void;
  /** Idempotently releases platform resources. Resolves only after exclusive playback is released. */
  dispose?(): Promise<void>;
  setSubtitle(subtitleText: string, label: string, language: string): Promise<SubtitleAttachment>;
  /** Enables or hides the currently attached subtitle without replacing its data. */
  setSubtitleEnabled(enabled: boolean): void;
  /** Shifts attached subtitle cues; positive values display later and negative values earlier. */
  setSubtitleTimingOffset?(offsetSeconds: number): void;
  /** Describes controls supported by the currently selected subtitle renderer. */
  getSubtitleRenderingCapabilities?(): SubtitleRenderingCapabilities;
}

/** Shared web UI request; the factory binds the available platform video surface. */
export interface DirectPlayerRequest {
  /** Browser video node, when the runtime uses HTML media playback. */
  videoElement?: HTMLVideoElement | null;
  /** Platform-owned video container, such as a Tizen AVPlay object element. */
  container?: HTMLElement | null;
  streamUrl: string;
  transportStreamMetadataUrl?: string;
  onSubtitleCue?: (text: string) => void;
}

export interface RelayPlayerRequest {
  container: HTMLElement;
  config: import("./live-relay/config.ts").LiveRelayConfig;
  channelId: string;
  preferredLanguage?: string;
  mediaToPlayheadOffsetMs?: number;
}

/** Marker contract for a relay-backed live player with asynchronous startup and close. */
export interface RelayMediaPlayer extends MediaPlayer {
  start(): Promise<void>;
  close(): Promise<void>;
  getRelayDiagnostics?(): string;
  getRelaySubtitleStatus?(): string;
}

/** Platform adapter chooses a player based on its native surface and capabilities. */
export interface PlaybackPlayerFactory {
  createDirect(request: DirectPlayerRequest): MediaPlayer | null;
  createRelay?(request: RelayPlayerRequest): RelayMediaPlayer | null;
}
