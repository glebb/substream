/** Small structural event target surface so lifecycle behavior is testable without LG globals. */
export interface WebOsLifecycleDocument {
  readonly visibilityState: string;
  addEventListener(type: "visibilitychange", listener: EventListener): void;
  removeEventListener(type: "visibilitychange", listener: EventListener): void;
}

export interface WebOsLifecycleWindow {
  addEventListener(type: "pagehide", listener: EventListener): void;
  removeEventListener(type: "pagehide", listener: EventListener): void;
}

export interface WebOsPlaybackLifecycleOptions {
  document: WebOsLifecycleDocument;
  window: WebOsLifecycleWindow;
  /** Persist the latest progress and release the active player. Must be safe to call once. */
  onSuspend(reason: "hidden" | "pagehide"): void;
  /** Restore only the app's safe playback state; do not create a second player. */
  onResume?(): void;
}

/**
 * Binds webOS app background/exit events to playback cleanup. Hidden and pagehide
 * can be delivered for the same transition, so suspension is coalesced until the
 * app becomes visible again. The caller owns persistence and player release.
 */
export function bindWebOsPlaybackLifecycle(options: WebOsPlaybackLifecycleOptions): () => void {
  let suspended = options.document.visibilityState === "hidden";
  let disposed = false;
  const suspend = (reason: "hidden" | "pagehide") => {
    if (disposed || suspended) return;
    suspended = true;
    options.onSuspend(reason);
  };
  const onVisibilityChange: EventListener = () => {
    if (options.document.visibilityState === "hidden") {
      suspend("hidden");
    } else if (options.document.visibilityState === "visible" && suspended) {
      suspended = false;
      options.onResume?.();
    }
  };
  const onPageHide: EventListener = () => suspend("pagehide");
  options.document.addEventListener("visibilitychange", onVisibilityChange);
  options.window.addEventListener("pagehide", onPageHide);
  return () => {
    if (disposed) return;
    disposed = true;
    options.document.removeEventListener("visibilitychange", onVisibilityChange);
    options.window.removeEventListener("pagehide", onPageHide);
  };
}
