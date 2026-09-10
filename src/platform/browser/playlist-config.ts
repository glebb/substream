const PLAYLIST_URL_KEY = "my-m3u.playlist-url";

export function loadPlaylistUrl(): string {
  return localStorage.getItem(PLAYLIST_URL_KEY) ?? "";
}

export function savePlaylistUrl(url: string): void {
  localStorage.setItem(PLAYLIST_URL_KEY, url.trim());
}
