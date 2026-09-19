const STORAGE_KEY = "substream.favourite-groups";
const MAX_GROUPS = 500;
const MAX_ID_LENGTH = 256;

const DEFAULT_MOVIE_GROUP_NAMES = [
  "Action", "Adventure", "Comedy", "Crime", "Documentary", "Drama", "Fantasy", "Finland",
  "Horror", "Marvel and DC", "Music", "Nordic [Multi-Sub]", "Nordic 4K", "Science-Fiction",
];
const DEFAULT_SERIES_GROUP_NAMES = [
  "Apple TV+", "Finland", "HBO", "Netflix", "Nordic 4K", "Nordic Apple TV", "Nordic Disney",
  "Nordic Netflix", "Nordic Prime Video", "Nordic Viaplay",
];

interface KeyValueStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

function browserStorage(): KeyValueStorage | null {
  try { return globalThis.localStorage ?? null; } catch { return null; }
}

function validId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_ID_LENGTH && !/^https?:\/\//i.test(value);
}

/** Returns the provider/local group ids marked as favourites on this device. */
export function loadFavouriteGroupIds(storage: KeyValueStorage | null = browserStorage()): string[] {
  if (!storage) return [];
  try {
    const parsed: unknown = JSON.parse(storage.getItem(STORAGE_KEY) ?? "[]");
    return Array.isArray(parsed) ? [...new Set(parsed.filter(validId))].slice(0, MAX_GROUPS) : [];
  } catch { return []; }
}

/** Whether this device has saved a selection, including an explicitly empty one. */
export function hasSavedFavouriteGroupIds(storage: KeyValueStorage | null = browserStorage()): boolean {
  if (!storage) return false;
  try { return storage.getItem(STORAGE_KEY) !== null; } catch { return false; }
}

/** Resolve the first-run provider defaults against the groups currently available. */
export function defaultFavouriteGroupIds(groups: readonly { id: string; name: string; contentType?: "movie" | "series" | "mixed" | "other"; providerContentType?: "movie" | "series" }[]): string[] {
  const matches: string[] = [];
  for (const group of groups) {
    const type = group.providerContentType ?? (group.contentType === "movie" || group.contentType === "series" ? group.contentType : undefined);
    const names = type === "movie" ? DEFAULT_MOVIE_GROUP_NAMES : type === "series" ? DEFAULT_SERIES_GROUP_NAMES : [];
    const prefix = type === "movie" ? "Movies: " : "Series: ";
    if (names.some((name) => group.name === name || group.name === prefix + name || group.name === prefix + prefix + name)) matches.push(group.id);
  }
  return matches;
}

export function saveFavouriteGroupIds(ids: readonly string[], storage: KeyValueStorage | null = browserStorage()): void {
  if (!storage) return;
  const safe = [...new Set(ids.filter(validId))].slice(0, MAX_GROUPS);
  try { storage.setItem(STORAGE_KEY, JSON.stringify(safe)); } catch { /* persistence is best effort */ }
}

export function setFavouriteGroup(groupId: string, favourite: boolean, storage: KeyValueStorage | null = browserStorage()): string[] {
  const next = loadFavouriteGroupIds(storage).filter((id) => id !== groupId);
  if (favourite && validId(groupId)) next.push(groupId);
  saveFavouriteGroupIds(next, storage);
  return next;
}

export function clearFavouriteGroups(storage: KeyValueStorage | null = browserStorage()): void {
  try { storage?.removeItem(STORAGE_KEY); } catch { /* reset remains usable */ }
}
