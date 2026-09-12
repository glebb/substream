import { packageDefaults } from "../package-defaults.ts";

const KEY = "my-m3u.opensubtitles-api-key";

export function loadOpenSubtitlesApiKey(): string {
  return window.localStorage.getItem(KEY)?.trim() || packageDefaults.openSubtitlesApiKey || "";
}

export function saveOpenSubtitlesApiKey(apiKey: string): void {
  window.localStorage.setItem(KEY, apiKey.trim());
}
