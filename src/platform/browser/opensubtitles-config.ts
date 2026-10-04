import { browserStorage, type KeyValueStorage } from "../web/preferences-storage.ts";
import { packageDefaults } from "../package-defaults.ts";

const KEY = "substream.opensubtitles-api-key";

export function loadOpenSubtitlesApiKey(storage: KeyValueStorage | null = browserStorage()): string {
  try {
    return storage?.getItem(KEY)?.trim() || packageDefaults.openSubtitlesApiKey || "";
  } catch {
    return packageDefaults.openSubtitlesApiKey || "";
  }
}

export function saveOpenSubtitlesApiKey(apiKey: string, storage: KeyValueStorage | null = browserStorage()): void {
  try {
    storage?.setItem(KEY, apiKey.trim());
  } catch {
    // A key remains usable for the current session if persistence is denied.
  }
}

export function clearSavedOpenSubtitlesSettings(storage: KeyValueStorage | null = browserStorage()): void {
  try {
    storage?.removeItem(KEY);
  } catch {
    // Reset can still clear the other app stores if local storage is unavailable.
  }
}
