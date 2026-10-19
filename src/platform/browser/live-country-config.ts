import { DEFAULT_LIVE_COUNTRIES } from "../../core/live/country.ts";
import { browserStorage, type KeyValueStorage } from "../web/preferences-storage.ts";

const COUNTRIES_KEY = "substream.live-countries";
const LAST_COUNTRY_KEY = "substream.live-last-country";
const MAX_COUNTRIES = 200;

function validCountry(value: unknown): value is string {
  return typeof value === "string" && /^[a-z0-9-]{1,40}$/.test(value);
}

/** Countries shown in Live TV on this device; Finland until the user saves a choice. */
export function loadLiveCountries(storage: KeyValueStorage | null = browserStorage()): string[] {
  try {
    const parsed: unknown = JSON.parse(storage?.getItem(COUNTRIES_KEY) ?? "null");
    const countries = Array.isArray(parsed) ? [...new Set(parsed.filter(validCountry))].slice(0, MAX_COUNTRIES) : [];
    return countries.length ? countries : [...DEFAULT_LIVE_COUNTRIES];
  } catch { return [...DEFAULT_LIVE_COUNTRIES]; }
}

/**
 * Saves the selection; an empty selection falls back to the default so Live TV never becomes empty.
 * Returns what is actually stored, so a failed write is visible to the caller.
 */
export function saveLiveCountries(countries: readonly string[], storage: KeyValueStorage | null = browserStorage()): string[] {
  const safe = [...new Set(countries.filter(validCountry))].slice(0, MAX_COUNTRIES);
  const next = safe.length ? safe : [...DEFAULT_LIVE_COUNTRIES];
  try { storage?.setItem(COUNTRIES_KEY, JSON.stringify(next)); } catch { /* the read-back below reports the failure */ }
  return loadLiveCountries(storage);
}

export function clearLiveCountries(storage: KeyValueStorage | null = browserStorage()): void {
  try {
    storage?.removeItem(COUNTRIES_KEY);
    storage?.removeItem(LAST_COUNTRY_KEY);
  } catch { /* reset remains usable */ }
}

export function loadLastLiveCountry(storage: KeyValueStorage | null = browserStorage()): string | null {
  try {
    const value = storage?.getItem(LAST_COUNTRY_KEY) ?? null;
    return validCountry(value) ? value : null;
  } catch { return null; }
}

export function saveLastLiveCountry(country: string, storage: KeyValueStorage | null = browserStorage()): void {
  if (!validCountry(country)) return;
  try { storage?.setItem(LAST_COUNTRY_KEY, country); } catch { /* persistence is best effort */ }
}
