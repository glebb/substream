import type { MediaPlayer, MediaPlayerEventHandlers, PlaybackState, SubtitleAttachment, VideoDisplayMode } from "../media-player.ts";
import { srtToWebVtt } from "../../core/subtitles/srt-to-vtt.ts";
import { shiftWebVttCues } from "../../core/subtitles/webvtt-timing.ts";
import { normalizeSubtitleOffsetSeconds } from "../../core/subtitles/timing.ts";

export class HtmlVideoPlayer implements MediaPlayer {
  private subtitleObjectUrl: string | undefined;
  private subtitleText: string | undefined;
  private subtitleLabel = "";
  private subtitleLanguage = "";
  private subtitleTimingOffsetSeconds = 0;
  private subtitleEnabled = true;
  private subtitleTrack: HTMLTrackElement | undefined;
  private eventHandlers: MediaPlayerEventHandlers | null = null;
  private readonly eventListeners: Array<[string, EventListener]>;

  constructor(private readonly video: HTMLVideoElement) {
    this.eventListeners = [
      ["loadstart", () => this.emit("loading")],
      ["playing", () => this.emit("playing")],
      ["waiting", () => this.emit("buffering")],
      ["pause", () => { if (!this.video.ended) this.emit("paused"); }],
      ["ended", () => this.emit("ended")],
      ["error", () => this.emit("error")],
      ["timeupdate", () => this.emitProgress()],
      ["durationchange", () => this.emitProgress()],
    ];
    for (const [type, listener] of this.eventListeners) this.video.addEventListener(type, listener);
  }

  setEventHandlers(handlers: MediaPlayerEventHandlers | null): void {
    this.eventHandlers = handlers;
  }

  load(streamUrl: string): void {
    this.emit("loading");
    try {
      this.video.src = streamUrl;
      this.video.load();
      void this.requestPlay();
    } catch {
      this.emit("error");
    }
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

  private emitProgress(): void {
    const durationSeconds = this.video.duration;
    const currentTimeSeconds = this.video.currentTime;
    if (!Number.isFinite(durationSeconds) || durationSeconds <= 0 || !Number.isFinite(currentTimeSeconds)) return;
    this.eventHandlers?.onProgress?.({ currentTimeSeconds, durationSeconds });
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
