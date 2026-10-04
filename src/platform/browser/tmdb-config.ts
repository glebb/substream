import { browserStorage, type KeyValueStorage } from "../web/preferences-storage.ts";
import { packageDefaults } from "../package-defaults.ts";

const TOKEN_KEY = "substream.tmdb-api-read-access-token";
const API_KEY = "substream.tmdb-api-key";

export function loadTmdbCredentials(storage: KeyValueStorage | null = browserStorage()): { readAccessToken: string; apiKey: string } {
  try {
    return {
      readAccessToken: storage?.getItem(TOKEN_KEY)?.trim() || packageDefaults.tmdbApiReadAccessToken || "",
      apiKey: storage?.getItem(API_KEY)?.trim() || packageDefaults.tmdbApiKey || "",
    };
  } catch {
    return { readAccessToken: packageDefaults.tmdbApiReadAccessToken || "", apiKey: packageDefaults.tmdbApiKey || "" };
  }
}

export function saveTmdbCredentials(credentials: { readAccessToken?: string; apiKey?: string }, storage: KeyValueStorage | null = browserStorage()): void {
  try {
    if (credentials.readAccessToken !== undefined) storage?.setItem(TOKEN_KEY, credentials.readAccessToken.trim());
    if (credentials.apiKey !== undefined) storage?.setItem(API_KEY, credentials.apiKey.trim());
  } catch { /* persistence is optional */ }
}

export function clearSavedTmdbCredentials(storage: KeyValueStorage | null = browserStorage()): void {
  try {
    storage?.removeItem(TOKEN_KEY);
    storage?.removeItem(API_KEY);
  } catch { /* reset remains safe when storage is unavailable */ }
}
