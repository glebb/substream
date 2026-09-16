import { packageDefaults } from "../package-defaults.ts";

const TOKEN_KEY = "substream.tmdb-api-read-access-token";
const API_KEY = "substream.tmdb-api-key";

export function loadTmdbCredentials(): { readAccessToken: string; apiKey: string } {
  try {
    return {
      readAccessToken: globalThis.localStorage?.getItem(TOKEN_KEY)?.trim() || packageDefaults.tmdbApiReadAccessToken || "",
      apiKey: globalThis.localStorage?.getItem(API_KEY)?.trim() || packageDefaults.tmdbApiKey || "",
    };
  } catch {
    return { readAccessToken: packageDefaults.tmdbApiReadAccessToken || "", apiKey: packageDefaults.tmdbApiKey || "" };
  }
}

export function saveTmdbCredentials(credentials: { readAccessToken?: string; apiKey?: string }): void {
  try {
    if (credentials.readAccessToken !== undefined) globalThis.localStorage?.setItem(TOKEN_KEY, credentials.readAccessToken.trim());
    if (credentials.apiKey !== undefined) globalThis.localStorage?.setItem(API_KEY, credentials.apiKey.trim());
  } catch { /* persistence is optional */ }
}

export function clearSavedTmdbCredentials(): void {
  try {
    globalThis.localStorage?.removeItem(TOKEN_KEY);
    globalThis.localStorage?.removeItem(API_KEY);
  } catch { /* reset remains safe when storage is unavailable */ }
}
