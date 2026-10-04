import { browserStorage, type KeyValueStorage } from "../web/preferences-storage.ts";
const CATALOG_CLEARED_KEY = "substream.catalog-cleared";

export function wasCatalogCleared(storage: KeyValueStorage | null = browserStorage()): boolean {
  try {
    return storage?.getItem(CATALOG_CLEARED_KEY) === "1";
  } catch {
    return false;
  }
}

export function markCatalogCleared(storage: KeyValueStorage | null = browserStorage()): void {
  try {
    storage?.setItem(CATALOG_CLEARED_KEY, "1");
  } catch {
    // The current session still keeps the catalogue cleared if persistence is denied.
  }
}

export function clearCatalogClearedMarker(storage: KeyValueStorage | null = browserStorage()): void {
  try {
    storage?.removeItem(CATALOG_CLEARED_KEY);
  } catch {
    // A later playlist import can still replace the catalogue for this session.
  }
}
