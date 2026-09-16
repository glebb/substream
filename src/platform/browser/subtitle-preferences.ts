export type SubtitleLanguage = "fi" | "en";

export interface SubtitlePreferences {
  languagePreference: SubtitleLanguage;
  lastLanguage: SubtitleLanguage;
  fontSize: number;
}

const STORAGE_KEY = "substream.subtitle-preferences";
const DEFAULT_PREFERENCES: SubtitlePreferences = { languagePreference: "fi", lastLanguage: "fi", fontSize: 2.3 };
const MIN_FONT_SIZE = 1;
const MAX_FONT_SIZE = 3.5;

interface KeyValueStorage { getItem(key: string): string | null; setItem(key: string, value: string): void; removeItem(key: string): void; }

function storage(): KeyValueStorage | null {
  try { return globalThis.localStorage ?? null; } catch { return null; }
}

function language(value: unknown, fallback: SubtitleLanguage): SubtitleLanguage {
  return value === "fi" || value === "en" ? value : fallback;
}

export function normalizeSubtitleFontSize(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_PREFERENCES.fontSize;
  return Math.min(MAX_FONT_SIZE, Math.max(MIN_FONT_SIZE, Math.round(value * 10) / 10));
}

export function loadSubtitlePreferences(store: KeyValueStorage | null = storage()): SubtitlePreferences {
  if (!store) return { ...DEFAULT_PREFERENCES };
  try {
    const parsed: unknown = JSON.parse(store.getItem(STORAGE_KEY) ?? "null");
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { ...DEFAULT_PREFERENCES };
    const value = parsed as Record<string, unknown>;
    return {
      languagePreference: language(value.languagePreference, DEFAULT_PREFERENCES.languagePreference),
      lastLanguage: language(value.lastLanguage, DEFAULT_PREFERENCES.lastLanguage),
      fontSize: normalizeSubtitleFontSize(typeof value.fontSize === "number" ? value.fontSize : DEFAULT_PREFERENCES.fontSize),
    };
  } catch { return { ...DEFAULT_PREFERENCES }; }
}

function save(preferences: SubtitlePreferences, store: KeyValueStorage | null = storage()): void {
  try { store?.setItem(STORAGE_KEY, JSON.stringify(preferences)); } catch { /* Session remains usable when storage is denied. */ }
}

export function saveSubtitleLanguagePreference(value: SubtitleLanguage, store: KeyValueStorage | null = storage()): void {
  const current = loadSubtitlePreferences(store);
  save({ ...current, languagePreference: language(value, "fi") }, store);
}

export function saveLastSubtitleLanguage(value: string, store: KeyValueStorage | null = storage()): void {
  if (value !== "fi" && value !== "en") return;
  const current = loadSubtitlePreferences(store);
  save({ ...current, lastLanguage: value }, store);
}

export function saveSubtitleFontSize(value: number, store: KeyValueStorage | null = storage()): number {
  const normalized = normalizeSubtitleFontSize(value);
  save({ ...loadSubtitlePreferences(store), fontSize: normalized }, store);
  return normalized;
}

export function clearSubtitlePreferences(store: KeyValueStorage | null = storage()): void {
  try { store?.removeItem(STORAGE_KEY); } catch { /* Reset remains best effort. */ }
}
