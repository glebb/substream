import type { MediaPlayer, MediaPlayerEventHandlers, PlaybackState, SubtitleAttachment, VideoDisplayMode } from "../media-player.ts";
import { parseSrtCues, type SubtitleCue } from "../../core/subtitles/srt-cues.ts";
import { normalizeSubtitleOffsetSeconds } from "../../core/subtitles/timing.ts";

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
  getCurrentStreamInfo?(): Array<{ type?: string; extra_info?: string }>;
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

  constructor(
    private readonly container: HTMLElement,
    private readonly onSubtitleCue: (text: string) => void,
  ) {}

  setEventHandlers(handlers: MediaPlayerEventHandlers | null): void {
    this.eventHandlers = handlers;
  }

  load(streamUrl: string): void {
    this.destroy();
    const player = avplay();
    if (!player) {
      this.emit("error");
      return;
    }
    const generation = this.generation;
    this.emit("loading");
    try {
      player.open(streamUrl);
      this.opened = true;
      this.paused = false;
      this.configureBuffering(player);
      this.setDisplayRect(player);
      this.applyDisplayMode(player);
      player.setListener?.({
        oncurrentplaytime: (milliseconds) => {
          if (!this.isCurrent(generation)) return;
          this.currentPlayheadMilliseconds = milliseconds;
          this.updateSubtitle(milliseconds);
          this.emitProgress(milliseconds, player);
        },
        onbufferingstart: () => { if (this.isCurrent(generation)) this.emit("buffering"); },
        onbufferingcomplete: () => { if (this.isCurrent(generation) && !this.paused) this.emit("playing"); },
        onstreamcompleted: () => { if (this.isCurrent(generation)) { this.paused = true; this.emit("ended"); } },
        onerror: () => { if (this.isCurrent(generation)) this.fail(generation); },
      });
      player.prepareAsync(
        () => {
          if (!this.isCurrent(generation)) return;
          this.isPrepared = true;
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

  private configureBuffering(player: AvPlayApi): void {
    if (!player.setBufferingParam) return;
    // AVPlay accepts these settings only in IDLE, after open() and before prepareAsync().
    // Keep the initial threshold modest for Tizen TV memory, while allowing a deeper
    // reserve if playback stalls and AVPlay needs to refill.
    try { player.setBufferingParam("PLAYER_BUFFER_FOR_PLAY", "PLAYER_BUFFER_SIZE_IN_SECOND", 5); } catch { /* Older AVPlay versions may not support this setting. */ }
    try { player.setBufferingParam("PLAYER_BUFFER_FOR_RESUME", "PLAYER_BUFFER_SIZE_IN_SECOND", 15); } catch { /* Buffer tuning must not prevent playback. */ }
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

  private emitProgress(currentTimeMilliseconds: number, player: AvPlayApi): void {
    if (!Number.isFinite(currentTimeMilliseconds) || !player.getDuration) return;
    try {
      const durationMilliseconds = player.getDuration();
      if (!Number.isFinite(durationMilliseconds) || durationMilliseconds <= 0) return;
      this.eventHandlers?.onProgress?.({
        currentTimeSeconds: Math.max(0, currentTimeMilliseconds / 1_000),
        durationSeconds: durationMilliseconds / 1_000,
      });
    } catch {
      // Duration may be unavailable while AVPlay is preparing the stream.
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
    this.currentPlayheadMilliseconds = 0;
    this.paused = false;
    this.isPrepared = false;
    this.pendingSeekMilliseconds = null;
    if (!this.opened) return;
    const player = avplay();
    this.opened = false;
    if (!player) return;
    try { player.stop(); } catch { /* AVPlay can already be stopped. */ }
    try { player.close(); } catch { /* Closing an errored AVPlay session can fail. */ }
  }
}
