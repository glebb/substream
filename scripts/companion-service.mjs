import { xtreamConnectionMetadata } from "../src/core/provider/xtream.ts";

/** LAN companion provider service for resolving playback identifiers. */

export function xtreamConnectionFromPlaylist(playlistUrl) {
  let playlist;
  try { playlist = new URL(playlistUrl); } catch { return null; }
  const username = playlist.searchParams.get("username");
  const password = playlist.searchParams.get("password");
  if (!username || !password) return null;
  const metadata = xtreamConnectionMetadata({ origin: playlist.origin, pathname: playlist.pathname, username, password });
  if (!metadata) return null;
  return { apiUrl: new URL(metadata.apiUrl), username, password, sourceFingerprint: metadata.pairingFingerprint };
}

export async function fetchXtreamAction(connection, action, parameters = {}, request = fetch, { timeoutMs = 30_000, signal } = {}) {
  const url = new URL(connection.apiUrl.toString());
  url.searchParams.set("username", connection.username);
  url.searchParams.set("password", connection.password);
  url.searchParams.set("action", action);
  for (const [key, value] of Object.entries(parameters)) url.searchParams.set(key, value);
  const response = await request(url, { signal: signal ?? AbortSignal.timeout(timeoutMs) });
  if (!response.ok) throw new Error("Provider request failed");
  const body = await response.json();
  return Array.isArray(body) ? body : body && typeof body === "object" ? body : [];
}

/** Resolve one series episode by its provider ID; only safe metadata leaves this service. */
export async function resolveXtreamEpisode(connection, seriesId, episodeId, request = fetch, options = {}) {
  if (!/^\d{1,20}$/.test(String(seriesId)) || !/^\d{1,20}$/.test(String(episodeId))) return null;
  const response = await fetchXtreamAction(connection, "get_series_info", { series_id: String(seriesId) }, request, options);
  const episodes = response?.episodes;
  if (!episodes || typeof episodes !== "object") return null;
  for (const season of Object.values(episodes)) {
    if (!Array.isArray(season)) continue;
    const found = season.find((record) => String(record?.id ?? "") === String(episodeId));
    if (!found) continue;
    const name = typeof found.title === "string" ? found.title.trim() : "";
    if (!name) return null;
    return {
      id: String(episodeId), kind: "episode", title: normalizeEpisodeTitle(name),
      year: null,
      extension: /^[a-z0-9]{1,10}$/i.test(String(found.container_extension ?? "")) ? String(found.container_extension).toLowerCase() : "mp4",
      sourceFingerprint: connection.sourceFingerprint,
    };
  }
  return null;
}

function normalizeEpisodeTitle(value) {
  const input = value.trim();
  const yearMatch = input.match(/\s*(?:[-–—]\s*|\()\b((?:19|20)\d{2})\)?\s*$/);
  const title = yearMatch ? input.slice(0, yearMatch.index).trim() : input;
  return title || input;
}
