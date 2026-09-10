export class HtmlVideoPlayer {
  private subtitleObjectUrl: string | undefined;

  constructor(private readonly video: HTMLVideoElement) {}

  load(streamUrl: string): void {
    this.video.src = streamUrl;
    this.video.load();
    void this.video.play().catch(() => {
      // Some browsers and TVs require an explicit user gesture before playback.
    });
  }

  destroy(): void {
    this.video.pause();
    this.video.removeAttribute("src");
    this.video.load();
    if (this.subtitleObjectUrl) URL.revokeObjectURL(this.subtitleObjectUrl);
  }

  setSubtitle(webVtt: string, label: string, language: string): void {
    if (this.subtitleObjectUrl) URL.revokeObjectURL(this.subtitleObjectUrl);
    this.video.querySelectorAll("track").forEach((track) => track.remove());
    this.subtitleObjectUrl = URL.createObjectURL(new Blob([webVtt], { type: "text/vtt" }));
    const track = document.createElement("track");
    track.default = true;
    track.kind = "subtitles";
    track.label = label;
    track.srclang = language;
    track.src = this.subtitleObjectUrl;
    this.video.append(track);
  }
}
