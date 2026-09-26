export interface SubtitleAttachment {
  enabled: boolean;
  /** Safe, user-facing reason when a platform cannot attach the subtitle. */
  reason?: string;
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
  selected: boolean;
}

export interface MediaPlayerEventHandlers {
  onStateChange(state: PlaybackState): void;
  onProgress?(progress: PlaybackProgress): void;
  onLiveBufferWindowChange?(window: LiveBufferWindow | null): void;
  /** Fires when selectable embedded live subtitle renditions become available or change. */
  onEmbeddedSubtitleTracksChange?(tracks: EmbeddedSubtitleTrack[]): void;
}

export interface MediaPlayer {
  setEventHandlers(handlers: MediaPlayerEventHandlers | null): void;
  /** Enables automatic Finnish/English selection for embedded live subtitles. */
  setLiveSubtitleMode?(enabled: boolean): void;
  load(streamUrl: string): void;
  /** Seeks to an absolute playhead position, including while the stream is preparing. */
  seekTo?(seconds: number): void;
  /** Returns the provider's currently seekable live/DVR window, if it exposes one. */
  getLiveBufferWindow?(): LiveBufferWindow | null;
  /** Seeks within the reported live/DVR window. */
  seekLiveBuffer?(seconds: number): void;
  /** Returns playback to the newest available point of a live/DVR window. */
  goLive?(): void;
  /** Returns source dimensions only; adapters must not expose stream metadata or URLs. */
  getVideoResolution?(): string | null;
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
  setSubtitle(subtitleText: string, label: string, language: string): Promise<SubtitleAttachment>;
  /** Enables or hides the currently attached subtitle without replacing its data. */
  setSubtitleEnabled(enabled: boolean): void;
  /** Shifts attached subtitle cues; positive values display later and negative values earlier. */
  setSubtitleTimingOffset?(offsetSeconds: number): void;
}
