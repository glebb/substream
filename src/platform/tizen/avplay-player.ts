import type { MediaPlayer, SubtitleAttachment, VideoDisplayMode } from "../media-player.ts";
import { parseSrtCues, type SubtitleCue } from "../../core/subtitles/srt-cues.ts";

interface AvPlayApi {
  open(url: string): void;
  prepareAsync(onSuccess: () => void, onError: (error: unknown) => void): void;
  play(): void;
  pause(): void;
  jumpForward(milliseconds: number): void;
  jumpBackward(milliseconds: number): void;
  stop(): void;
  close(): void;
  setDisplayRect(left: number, top: number, width: number, height: number): void;
  setDisplayMethod(mode: "PLAYER_DISPLAY_MODE_LETTER_BOX" | "PLAYER_DISPLAY_MODE_FULL_SCREEN" | "PLAYER_DISPLAY_MODE_AUTO_ASPECT_RATIO"): void;
  setListener?(listener: { oncurrentplaytime?(milliseconds: number): void }): void;
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

/**
 * Tizen's AVPlay uses a hardware video plane, unlike an HTML video element.
 * Keep it isolated so browser development stays independent of Tizen globals.
 */
export class TizenAvPlayPlayer implements MediaPlayer {
  private opened = false;
  private displayMode: VideoDisplayMode = "auto";
  private subtitleCues: SubtitleCue[] = [];
  private visibleCue = "";

  constructor(
    private readonly container: HTMLElement,
    private readonly onPlaybackError: () => void,
    private readonly onSubtitleCue: (text: string) => void,
  ) {}

  load(streamUrl: string): void {
    const player = avplay();
    if (!player) throw new Error("Tizen AVPlay is unavailable");
    this.destroy();
    player.open(streamUrl);
    this.opened = true;
    this.setDisplayRect(player);
    this.applyDisplayMode(player);
    player.setListener?.({ oncurrentplaytime: (milliseconds) => this.updateSubtitle(milliseconds) });
    player.prepareAsync(
      () => {
        player.play();
      },
      () => {
        this.opened = false;
        this.onPlaybackError();
      },
    );
  }

  play(): void {
    if (!this.opened) return;
    try { avplay()?.play(); } catch { this.onPlaybackError(); }
  }

  pause(): void {
    if (!this.opened) return;
    try { avplay()?.pause(); } catch { this.onPlaybackError(); }
  }

  restart(): void {
    const player = avplay();
    if (!this.opened || !player) return;
    try {
      player.stop();
      this.setDisplayRect(player);
      player.prepareAsync(() => player.play(), () => this.onPlaybackError());
    } catch {
      this.onPlaybackError();
    }
  }

  skip(seconds: number): void {
    if (!this.opened || seconds === 0) return;
    try {
      const player = avplay();
      if (!player) return;
      if (seconds > 0) player.jumpForward(seconds * 1_000);
      else player.jumpBackward(Math.abs(seconds) * 1_000);
    } catch {
      this.onPlaybackError();
    }
  }

  setDisplayMode(mode: VideoDisplayMode): void {
    this.displayMode = mode;
    const player = avplay();
    if (!this.opened || !player) return;
    try { this.applyDisplayMode(player); } catch { this.onPlaybackError(); }
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

  async setSubtitle(subtitleText: string, _label: string, _language: string): Promise<SubtitleAttachment> {
    if (!this.opened) return { enabled: false, reason: "AVPlay is not ready." };
    this.subtitleCues = parseSrtCues(subtitleText);
    this.visibleCue = "";
    this.onSubtitleCue("");
    return this.subtitleCues.length > 0
      ? { enabled: true }
      : { enabled: false, reason: "The selected subtitle has no usable SRT cues." };
  }

  private updateSubtitle(milliseconds: number): void {
    const cue = this.subtitleCues.find((candidate) => milliseconds >= candidate.startMs && milliseconds < candidate.endMs);
    const text = cue?.text ?? "";
    if (text === this.visibleCue) return;
    this.visibleCue = text;
    this.onSubtitleCue(text);
  }

  destroy(): void {
    this.onSubtitleCue("");
    if (!this.opened) return;
    const player = avplay();
    this.opened = false;
    if (!player) return;
    try { player.stop(); } catch { /* AVPlay can already be stopped. */ }
    try { player.close(); } catch { /* Closing an errored AVPlay session can fail. */ }
  }
}
