/** Fullscreen is optional: unsupported APIs must never interrupt playback. */
export async function requestBrowserFullscreen(element: { requestFullscreen?: () => Promise<void> | void }): Promise<boolean> {
  try {
    if (typeof element.requestFullscreen !== "function") return false;
    await element.requestFullscreen();
    return true;
  } catch {
    return false;
  }
}

export async function exitBrowserFullscreen(document: { exitFullscreen?: () => Promise<void> | void }): Promise<boolean> {
  try {
    if (typeof document.exitFullscreen !== "function") return false;
    await document.exitFullscreen();
    return true;
  } catch {
    return false;
  }
}

type PlayerOrientation = { lock?: (orientation: "landscape") => Promise<void>; unlock?: () => void };

export async function requestLandscapeOrientation(orientation: PlayerOrientation | undefined): Promise<void> {
  try { await orientation?.lock?.("landscape"); } catch { /* The user can rotate the phone manually. */ }
}

export async function requestPlayerFullscreen(element: HTMLElement): Promise<boolean> {
  const entered = await requestBrowserFullscreen(element);
  if (typeof window !== "undefined" && window.matchMedia?.("(pointer: coarse)").matches) {
    await requestLandscapeOrientation(window.screen.orientation as PlayerOrientation | undefined);
  }
  return entered;
}

export function releasePlayerOrientation(): void {
  try { if (typeof window !== "undefined") window.screen.orientation?.unlock?.(); } catch { /* Optional API. */ }
}
