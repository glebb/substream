const CATALOG_CLEARED_KEY = "substream.catalog-cleared";

export function wasCatalogCleared(): boolean {
  try {
    return globalThis.localStorage?.getItem(CATALOG_CLEARED_KEY) === "1";
  } catch {
    return false;
  }
}

export function markCatalogCleared(): void {
  try {
    globalThis.localStorage?.setItem(CATALOG_CLEARED_KEY, "1");
  } catch {
    // The current session still keeps the catalogue cleared if persistence is denied.
  }
}

export function clearCatalogClearedMarker(): void {
  try {
    globalThis.localStorage?.removeItem(CATALOG_CLEARED_KEY);
  } catch {
    // A later playlist import can still replace the catalogue for this session.
  }
}
