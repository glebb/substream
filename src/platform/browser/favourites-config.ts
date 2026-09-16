const STORAGE_KEY = "substream.favourite-groups";
const MAX_GROUPS = 500;
const MAX_ID_LENGTH = 256;

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
