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
  if (!username || !password || !/\/get\.php$/i.test(playlist.pathname)) return null;
  const apiUrl = new URL(playlist.toString());
  apiUrl.pathname = apiUrl.pathname.replace(/get\.php$/i, "player_api.php");
  apiUrl.search = "";
  return { apiUrl, username, password, sourceFingerprint: stableId(apiUrl.origin + apiUrl.pathname) };
}

export async function fetchXtreamAction(connection, action, parameters = {}, request = fetch) {
  const url = new URL(connection.apiUrl.toString());
  url.searchParams.set("username", connection.username);
  url.searchParams.set("password", connection.password);
  url.searchParams.set("action", action);
  for (const [key, value] of Object.entries(parameters)) url.searchParams.set(key, value);
  const response = await request(url);
  if (!response.ok) throw new Error("Provider request failed");
  const body = await response.json();
  return Array.isArray(body) ? body : body && typeof body === "object" ? body : [];
}

export async function loadXtreamCatalogue(connection, request = fetch) {
  const [movieCategories, seriesCategories] = await Promise.all([
    fetchXtreamAction(connection, "get_vod_categories", {}, request),
    fetchXtreamAction(connection, "get_series_categories", {}, request),
  ]);
  const categories = [
    ...categoryRecords(movieCategories, "movie"),
    ...categoryRecords(seriesCategories, "series"),
  ];
  const records = [];
  // Category requests are used because providers differ in their handling of
  // an omitted category_id. Deduplicate IDs across overlapping categories.
  const seen = new Set();
  for (const category of categories) {
    const action = category.contentType === "movie" ? "get_vod_streams" : "get_series";
    const values = await fetchXtreamAction(connection, action, { category_id: category.id }, request);
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

function stableId(value) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return `vod_${(hash >>> 0).toString(36)}`;
}
