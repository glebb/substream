import { isBackKey, isRedKey, normalizedRemoteKey } from "../../contracts/input.ts";

export { isBackKey, isRedKey, normalizedRemoteKey };

/** Samsung colour keys are privileged on Tizen and must be registered before
 * the browser receives them. Some models expose red under legacy key names. */
const TV_INPUT_PRIVILEGE_KEYS = ["MediaPlayPause", "MediaPlay", "MediaPause", "MediaRewind", "MediaFastForward", "Info", "ColorF0Red"];

interface TizenInputDevice {
  registerKeyBatch(keys: string[], onSuccess?: () => void, onError?: (error: unknown) => void): void;
  registerKey(key: string): void;
}
interface TizenGlobal { tvinputdevice?: TizenInputDevice }

export function isTizenRuntime(): boolean {
  return (globalThis as typeof globalThis & { tizen?: TizenGlobal }).tizen !== undefined;
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
