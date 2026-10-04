import { browserStorage, type KeyValueStorage } from "../web/preferences-storage.ts";
import { packageDefaults } from "../package-defaults.ts";

const PLAYLIST_URL_KEY = "substream.playlist-url";

export function loadPlaylistUrl(storage: KeyValueStorage | null = browserStorage()): string {
  try {
    return storage?.getItem(PLAYLIST_URL_KEY)?.trim() || packageDefaults.playlistUrl || "";
  } catch {
    return packageDefaults.playlistUrl || "";
  }
}

export function savePlaylistUrl(url: string, storage: KeyValueStorage | null = browserStorage()): void {
  try {
    storage?.setItem(PLAYLIST_URL_KEY, url.trim());
  } catch {
    // Storage can be disabled by browser policy. Importing still works for this session.
  }
}

export function clearSavedPlaylistUrl(storage: KeyValueStorage | null = browserStorage()): void {
  try {
    storage?.removeItem(PLAYLIST_URL_KEY);
  } catch {
    // Reset can still clear the other app stores if local storage is unavailable.
  }
}
