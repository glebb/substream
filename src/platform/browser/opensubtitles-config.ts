import { packageDefaults } from "../package-defaults.ts";

const KEY = "my-m3u.opensubtitles-api-key";

export function loadOpenSubtitlesApiKey(): string {
  try {
    return globalThis.localStorage?.getItem(KEY)?.trim() || packageDefaults.openSubtitlesApiKey || "";
  } catch {
    return packageDefaults.openSubtitlesApiKey || "";
  }
}

export function saveOpenSubtitlesApiKey(apiKey: string): void {
  try {
    globalThis.localStorage?.setItem(KEY, apiKey.trim());
  } catch {
    // A key remains usable for the current session if persistence is denied.
  }
}

export function clearSavedOpenSubtitlesSettings(): void {
  try {
    globalThis.localStorage?.removeItem(KEY);
  } catch {
    // Reset can still clear the other app stores if local storage is unavailable.
  }
}
