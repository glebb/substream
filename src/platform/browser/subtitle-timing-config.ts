import { normalizeSubtitleOffsetSeconds } from "../../core/subtitles/timing.ts";

const STORAGE_KEY = "substream.subtitle-timing-offsets";
const MAX_SAVED_TITLES = 500;
const MAX_TITLE_ID_LENGTH = 256;

interface KeyValueStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

function browserStorage(): KeyValueStorage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

function validTitleId(titleId: string): boolean {
  return titleId.length > 0 && titleId.length <= MAX_TITLE_ID_LENGTH && !/^https?:\/\//i.test(titleId);
}

function readOffsets(storage: KeyValueStorage | null): Record<string, number> {
  if (!storage) return {};
  try {
    const saved = storage.getItem(STORAGE_KEY);
    if (!saved) return {};
    const parsed: unknown = JSON.parse(saved);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return Object.fromEntries(Object.entries(parsed)
      .filter(([titleId, value]) => validTitleId(titleId) && typeof value === "number" && Number.isFinite(value))
      .slice(-MAX_SAVED_TITLES)
      .map(([titleId, value]) => [titleId, normalizeSubtitleOffsetSeconds(value as number)]));
  } catch {
    return {};
  }
}

/** Loads an offset using a stable catalogue title ID, never a media URL. */
export function loadSubtitleTimingOffset(titleId: string, storage: KeyValueStorage | null = browserStorage()): number {
  if (!validTitleId(titleId)) return 0;
  return readOffsets(storage)[titleId] ?? 0;
}

/** Stores only the stable title ID and bounded timing value. */
export function saveSubtitleTimingOffset(
  titleId: string,
  offsetSeconds: number,
  storage: KeyValueStorage | null = browserStorage(),
): number {
  const normalized = normalizeSubtitleOffsetSeconds(offsetSeconds);
  if (!validTitleId(titleId) || !storage) return normalized;
  try {
    const offsets = readOffsets(storage);
    delete offsets[titleId];
    offsets[titleId] = normalized;
    const entries = Object.entries(offsets).slice(-MAX_SAVED_TITLES);
    storage.setItem(STORAGE_KEY, JSON.stringify(Object.fromEntries(entries)));
  } catch {
    // Playback timing remains adjustable for this session when storage is unavailable.
  }
  return normalized;
}

export function clearSubtitleTimingOffsets(storage: KeyValueStorage | null = browserStorage()): void {
  try {
    storage?.removeItem(STORAGE_KEY);
  } catch {
    // Reset can still clear the other app stores if local storage is unavailable.
  }
}
