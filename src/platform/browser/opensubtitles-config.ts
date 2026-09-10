const KEY = "my-m3u.opensubtitles-api-key";

export function loadOpenSubtitlesApiKey(): string {
  return window.localStorage.getItem(KEY) ?? "";
}

export function saveOpenSubtitlesApiKey(apiKey: string): void {
  window.localStorage.setItem(KEY, apiKey.trim());
}
