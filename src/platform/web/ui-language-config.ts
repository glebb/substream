import { browserStorage, type KeyValueStorage } from "./preferences-storage.ts";

export type UiLanguage = "fi" | "en";
const STORAGE_KEY = "substream.ui-language";

export function loadUiLanguage(storage: KeyValueStorage | null = browserStorage()): UiLanguage {
  try { return storage?.getItem(STORAGE_KEY) === "en" ? "en" : "fi"; } catch { return "fi"; }
}

export function saveUiLanguage(language: UiLanguage, storage: KeyValueStorage | null = browserStorage()): void {
  try { storage?.setItem(STORAGE_KEY, language); } catch { /* Optional preference. */ }
}
