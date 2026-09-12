export interface SubtitleAttachment {
  enabled: boolean;
  /** Safe, user-facing reason when a platform cannot attach the subtitle. */
  reason?: string;
}

export type VideoDisplayMode = "auto" | "fit" | "fill";

export interface MediaPlayer {
  load(streamUrl: string): void;
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
}
