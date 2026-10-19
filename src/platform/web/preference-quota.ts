export interface EnumerableStorage {
  readonly length: number;
  key(index: number): string | null;
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

// Caches the app can rebuild from the provider, cheapest to lose first. Guide
// entries expire within minutes anyway; the live list cache is cleared last.
const REGENERABLE_CACHE_TIERS: readonly (readonly string[])[] = [
  ["substream.live.v2.", "substream.dna-epg.", "substream.epg."],
  ["substream.live.v"],
];
const OBSOLETE_CACHE_PREFIXES = ["substream.live.v2."];

export function removeKeysWithPrefixes(storage: EnumerableStorage, prefixes: readonly string[], keep?: string): number {
  const keys: string[] = [];
  for (let index = 0; index < storage.length; index += 1) {
    const key = storage.key(index);
    if (key && key !== keep && prefixes.some((prefix) => key.startsWith(prefix))) keys.push(key);
  }
  keys.forEach((key) => storage.removeItem(key));
  return keys.length;
}

/**
 * Writes a value, clearing regenerable Live TV caches and retrying when the
 * storage quota is full. Returns whether the value was stored.
 */
export function setPreferenceWithEviction(storage: EnumerableStorage, key: string, value: string): boolean {
  try { storage.setItem(key, value); return true; } catch { /* try freeing cache space below */ }
  for (const prefixes of REGENERABLE_CACHE_TIERS) {
    try {
      if (!removeKeysWithPrefixes(storage, prefixes, key)) continue;
      storage.setItem(key, value);
      return true;
    } catch { /* try the next tier */ }
  }
  return false;
}

/** Removes caches written by older app versions that nothing reads any more. */
export function removeObsoleteCaches(storage: EnumerableStorage): void {
  try { removeKeysWithPrefixes(storage, OBSOLETE_CACHE_PREFIXES); } catch { /* cleanup is best effort */ }
}
