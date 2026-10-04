import type { PreferencesRepository } from "../../contracts/repository.ts";

export interface KeyValueStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export function browserStorage(): KeyValueStorage | null {
  try { return globalThis.localStorage ?? null; } catch { return null; }
}

/** Preserves existing setting keys/validation while allowing another device store. */
export function preferencesStorage(preferences: PreferencesRepository): KeyValueStorage {
  return {
    getItem: (key) => preferences.get(key),
    setItem: (key, value) => preferences.set(key, value),
    removeItem: (key) => preferences.remove(key),
  };
}
