import { xtreamConnectionMetadata } from "../src/core/provider/xtream.ts";

/**
 * LAN companion provider service.  This module intentionally returns only
 * catalogue metadata and provider identifiers; credentials and stream URLs
 * never cross the companion API boundary.
 */

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
      id: String(episodeId), kind: "episode", title: normalizeTitle(name).title,
      year: null,
      extension: /^[a-z0-9]{1,10}$/i.test(String(found.container_extension ?? "")) ? String(found.container_extension).toLowerCase() : "mp4",
      sourceFingerprint: connection.sourceFingerprint,
    };
  }
  return null;
}

export async function loadXtreamCatalogue(connection, request = fetch, options = {}) {
  const categoryConcurrency = 4;
  const maxRecords = 50_000;
  const deadline = options.signal ?? AbortSignal.timeout(options.timeoutMs ?? 30_000);
  const requestOptions = { ...options, signal: deadline };
  const [movieCategories, seriesCategories] = await Promise.all([
    fetchXtreamAction(connection, "get_vod_categories", {}, request, requestOptions),
    fetchXtreamAction(connection, "get_series_categories", {}, request, requestOptions),
  ]);
  const categories = [
    ...categoryRecords(movieCategories, "movie"),
    ...categoryRecords(seriesCategories, "series"),
  ];
  const records = [];
  // Category requests are used because providers differ in their handling of
  // an omitted category_id. Deduplicate IDs across overlapping categories.
  const seen = new Set();
  for (let offset = 0; offset < categories.length && records.length < maxRecords; offset += categoryConcurrency) {
    const batch = categories.slice(offset, offset + categoryConcurrency);
    const settled = await Promise.allSettled(batch.map((category) => {
      const action = category.contentType === "movie" ? "get_vod_streams" : "get_series";
      return fetchXtreamAction(connection, action, { category_id: category.id }, request, requestOptions);
    }));
    const failed = settled.find((result) => result.status === "rejected");
    if (failed?.status === "rejected") throw failed.reason;
    for (let batchIndex = 0; batchIndex < batch.length && records.length < maxRecords; batchIndex += 1) {
      const category = batch[batchIndex];
      const values = settled[batchIndex].value;
      for (const record of values) {
        const id = String(record?.stream_id ?? record?.series_id ?? "");
        const name = typeof record?.name === "string" ? record.name.trim() : "";
        if (!/^\d{1,20}$/.test(id) || !name) continue;
        const key = category.contentType + ":" + id;
        if (seen.has(key)) continue;
        seen.add(key);
        const normalized = normalizeTitle(name);
        records.push({
          id,
          kind: category.contentType,
          title: normalized.title,
          searchTitle: normalized.searchTitle,
          year: normalized.year ?? numberOrNull(record.year),
          extension: category.contentType === "movie" && /^[a-z0-9]{1,10}$/i.test(String(record.container_extension ?? ""))
            ? String(record.container_extension).toLowerCase() : "mp4",
          category: category.name,
          sourceFingerprint: connection.sourceFingerprint,
        });
        if (records.length >= maxRecords) break;
      }
    }
  }
  return records;
}

export function searchCatalogue(records, query, limit = 50) {
  const terms = normalizeSearch(query).split(" ").filter(Boolean);
  if (!terms.length) return [];
  return records
    .filter((record) => terms.every((term) => record.searchTitle.includes(term)))
    .sort((left, right) => left.searchTitle.localeCompare(right.searchTitle) || left.id.localeCompare(right.id))
    .slice(0, Math.max(1, Math.min(100, limit)))
    .map(({ id, kind, title, year, extension, category, sourceFingerprint }) => ({ id, kind, title, year, extension, category, sourceFingerprint }));
}

function categoryRecords(values, contentType) {
  return values.flatMap((record) => {
    const id = String(record?.category_id ?? "");
    const name = typeof record?.category_name === "string" ? record.category_name.trim() : "";
    return id && name ? [{ id, name, contentType }] : [];
  });
}

function normalizeTitle(value) {
  const input = value.trim();
  const yearMatch = input.match(/\s*(?:[-–—]\s*|\()\b((?:19|20)\d{2})\)?\s*$/);
  const year = yearMatch ? Number(yearMatch[1]) : null;
  const title = yearMatch ? input.slice(0, yearMatch.index).trim() : input;
  return { title: title || input, searchTitle: normalizeSearch(title || input), year };
}

function normalizeSearch(value) {
  return value.normalize("NFKD").replace(/\p{Diacritic}/gu, "").toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

function numberOrNull(value) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : null;
}
