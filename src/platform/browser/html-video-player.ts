import type { MediaPlayer, SubtitleAttachment, VideoDisplayMode } from "../media-player.ts";
import { srtToWebVtt } from "../../core/subtitles/srt-to-vtt.ts";

export class HtmlVideoPlayer implements MediaPlayer {
  private subtitleObjectUrl: string | undefined;

  constructor(private readonly video: HTMLVideoElement) {}

  load(streamUrl: string): void {
    this.video.src = streamUrl;
    this.video.load();
    void this.video.play().catch(() => {
      // Some browsers and TVs require an explicit user gesture before playback.
    });
  }

  play(): void {
    void this.video.play().catch(() => {
      // A user gesture may be required before playback is allowed.
    });
  }

  pause(): void {
    this.video.pause();
  }

  restart(): void {
    this.video.currentTime = 0;
    this.play();
  }

  skip(seconds: number): void {
    if (!Number.isFinite(this.video.duration)) return;
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
    if (this.subtitleObjectUrl) URL.revokeObjectURL(this.subtitleObjectUrl);
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
