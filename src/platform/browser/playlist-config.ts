import { packageDefaults } from "../package-defaults.ts";

const PLAYLIST_URL_KEY = "my-m3u.playlist-url";

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
