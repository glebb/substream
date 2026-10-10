import { HtmlVideoPlayer, type HtmlVideoBackgroundSnapshot } from "../browser/html-video-player.ts";
import { bindWebOsPlaybackLifecycle, type WebOsLifecycleDocument, type WebOsLifecycleWindow } from "./playback-lifecycle.ts";
import type { MediaPlayerEventHandlers, PlaybackState } from "../media-player.ts";

/** HTML player with webOS app-background cleanup and guarded single-source restore. */
export class WebOsHtmlVideoPlayer extends HtmlVideoPlayer {
  private lifecycleSnapshot: HtmlVideoBackgroundSnapshot | null = null;
  private removeLifecycleListeners: (() => void) | undefined;
  private lifecycleDocument: WebOsLifecycleDocument | undefined;
  private hidden = false;
  private disposed = false;
  private playbackRequested = false;

  constructor(
    video: HTMLVideoElement,
    lifecycle?: { document: WebOsLifecycleDocument; window: WebOsLifecycleWindow },
  ) {
    super(video);
    const targets = lifecycle ?? (typeof document !== "undefined" && typeof window !== "undefined"
      ? { document, window }
      : undefined);
    if (targets) {
      this.lifecycleDocument = targets.document;
      this.hidden = targets.document.visibilityState === "hidden";
      this.removeLifecycleListeners = bindWebOsPlaybackLifecycle({
        ...targets,
        onSuspend: () => this.suspendForLifecycle(),
        onResume: () => {
          this.hidden = false;
          this.restoreWhenVisible();
        },
      });
    }
  }

  override setEventHandlers(handlers: MediaPlayerEventHandlers | null): void {
    super.setEventHandlers(handlers && {
      ...handlers,
      onStateChange: (state: PlaybackState) => {
        if (!this.disposed && !this.hidden) {
          if (state === "playing") this.playbackRequested = true;
          // Explicit pause() calls set intent synchronously. A generic paused
          // event can also mean autoplay was blocked or an old source was
          // replaced, so only terminal states clear intent here.
          else if (state === "ended" || state === "error") this.playbackRequested = false;
        }
        handlers.onStateChange(state);
      },
    });
  }

  override load(streamUrl: string): void {
    if (this.disposed) return;
    this.syncHiddenState();
    if (this.hidden) {
      // A later hidden load supersedes the old title and starts only after
      // visibility returns. A following seekTo() can replace this position.
      this.lifecycleSnapshot = { streamUrl, currentTimeSeconds: 0, restorePosition: false, wasPlaying: true };
      this.playbackRequested = true;
      return;
    }
    this.lifecycleSnapshot = null;
    this.playbackRequested = true;
    super.load(streamUrl);
  }

  override play(): void {
    if (this.disposed) return;
    this.syncHiddenState();
    this.playbackRequested = true;
    if (this.hidden) {
      if (this.lifecycleSnapshot) this.lifecycleSnapshot.wasPlaying = true;
      return;
    }
    const snapshot = this.lifecycleSnapshot;
    if (snapshot) {
      this.lifecycleSnapshot = null;
      // A formerly paused title is reloaded only after an explicit user play.
      // load() starts playback, so calling the base play as well would duplicate it.
      this.resumeFromBackground(snapshot);
      return;
    }
    super.play();
  }

  override pause(): void {
    if (this.disposed) return;
    this.syncHiddenState();
    this.playbackRequested = false;
    if (this.hidden) {
      if (this.lifecycleSnapshot) this.lifecycleSnapshot.wasPlaying = false;
      return;
    }
    if (this.lifecycleSnapshot) {
      this.lifecycleSnapshot.wasPlaying = false;
      return;
    }
    super.pause();
  }

  override seekTo(seconds: number): void {
    if (this.disposed || !Number.isFinite(seconds) || seconds < 0) return;
    this.syncHiddenState();
    if (this.hidden || this.lifecycleSnapshot) {
      if (this.lifecycleSnapshot) {
        this.lifecycleSnapshot.currentTimeSeconds = seconds;
        this.lifecycleSnapshot.restorePosition = true;
      }
      return;
    }
    super.seekTo(seconds);
  }

  override restart(): void {
    if (this.disposed) return;
    this.syncHiddenState();
    if (this.hidden || this.lifecycleSnapshot) {
      if (this.lifecycleSnapshot) {
        this.lifecycleSnapshot.currentTimeSeconds = 0;
        this.lifecycleSnapshot.restorePosition = true;
      }
      return;
    }
    super.restart();
  }

  override skip(seconds: number): void {
    if (this.disposed || !Number.isFinite(seconds)) return;
    this.syncHiddenState();
    if (this.hidden || this.lifecycleSnapshot) {
      if (this.lifecycleSnapshot) {
        this.lifecycleSnapshot.currentTimeSeconds = Math.max(0, this.lifecycleSnapshot.currentTimeSeconds + seconds);
        this.lifecycleSnapshot.restorePosition = true;
      }
      return;
    }
    super.skip(seconds);
  }

  override destroy(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.hidden = true;
    this.removeLifecycleListeners?.();
    this.removeLifecycleListeners = undefined;
    this.lifecycleDocument = undefined;
    this.lifecycleSnapshot = null;
    super.destroy();
  }

  private syncHiddenState(): void {
    if (this.lifecycleDocument?.visibilityState === "hidden" && !this.hidden) this.suspendForLifecycle();
    else if (this.lifecycleDocument?.visibilityState === "visible" && this.hidden) {
      this.hidden = false;
      this.restoreWhenVisible();
    }
  }

  private suspendForLifecycle(): void {
    if (this.disposed) return;
    this.hidden = true;
    const snapshot = this.suspendForBackground();
    if (snapshot) {
      snapshot.wasPlaying = this.playbackRequested;
      this.lifecycleSnapshot = snapshot;
    }
  }

  private restoreWhenVisible(): void {
    const snapshot = this.lifecycleSnapshot;
    if (!snapshot?.wasPlaying || this.disposed) return;
    this.lifecycleSnapshot = null;
    this.playbackRequested = true;
    this.resumeFromBackground(snapshot);
  }
}
