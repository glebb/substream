import type { MediaPlayer, MediaPlayerEventHandlers, PlaybackState, SubtitleAttachment, VideoDisplayMode } from "../media-player.ts";
import { srtToWebVtt } from "../../core/subtitles/srt-to-vtt.ts";

export class HtmlVideoPlayer implements MediaPlayer {
  private subtitleObjectUrl: string | undefined;
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
    if (this.subtitleObjectUrl) URL.revokeObjectURL(this.subtitleObjectUrl);
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
    if (this.subtitleObjectUrl) URL.revokeObjectURL(this.subtitleObjectUrl);
    this.video.querySelectorAll("track").forEach((track) => track.remove());
    this.subtitleObjectUrl = URL.createObjectURL(new Blob([srtToWebVtt(subtitleText)], { type: "text/vtt" }));
    const track = document.createElement("track");
    track.default = true;
    track.kind = "subtitles";
    track.label = label;
    track.srclang = language;
    track.src = this.subtitleObjectUrl;
    this.video.append(track);
    return { enabled: true };
  }
}
