import { packageDefaults } from "../package-defaults.ts";

const PLAYLIST_URL_KEY = "substream.playlist-url";

export function loadPlaylistUrl(): string {
  try {
    return globalThis.localStorage?.getItem(PLAYLIST_URL_KEY)?.trim() || packageDefaults.playlistUrl || "";
  } catch {
    return packageDefaults.playlistUrl || "";
  }
}

export function savePlaylistUrl(url: string): void {
  try {
    globalThis.localStorage?.setItem(PLAYLIST_URL_KEY, url.trim());
  } catch {
    // Storage can be disabled by browser policy. Importing still works for this session.
  }
}

export function clearSavedPlaylistUrl(): void {
  try {
    globalThis.localStorage?.removeItem(PLAYLIST_URL_KEY);
  } catch {
    // Reset can still clear the other app stores if local storage is unavailable.
  }
}
