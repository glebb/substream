const TV_INPUT_PRIVILEGE_KEYS = ["MediaPlayPause", "MediaRewind", "MediaFastForward"];

interface TizenInputDevice {
  registerKeyBatch(keys: string[], onSuccess?: () => void, onError?: (error: unknown) => void): void;
  registerKey(key: string): void;
}

interface TizenGlobal {
  tvinputdevice?: TizenInputDevice;
}

export function registerTizenPlaybackKeys(): void {
  const input = (globalThis as typeof globalThis & { tizen?: TizenGlobal }).tizen?.tvinputdevice;
  if (!input) return;
  try {
    input.registerKeyBatch(TV_INPUT_PRIVILEGE_KEYS);
  } catch {
    for (const key of TV_INPUT_PRIVILEGE_KEYS) {
      try { input.registerKey(key); } catch { /* Key support varies by TV model. */ }
    }
  }
}

export function isBackKey(event: KeyboardEvent): boolean {
  return event.key === "Escape" || event.key === "BrowserBack" || event.keyCode === 10009;
}
