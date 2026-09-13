const STORAGE_KEY = "substream.playback-progress";
const MAX_SAVED_TITLES = 500;
const MAX_TITLE_ID_LENGTH = 256;

export interface PlaybackHistoryItem {
  id: string;
  title: string;
  group: string;
  contentType: "movie" | "series" | "other";
  year: number | null;
  season?: number;
  episode?: number;
  currentTimeSeconds: number;
  durationSeconds: number;
  updatedAt: number;
  providerKind?: "movie" | "series";
  providerId?: string;
  providerExtension?: string;
  providerSourceId?: string;
}

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

function validText(value: unknown, maxLength: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maxLength;
}

function isHistoryItem(value: unknown): value is PlaybackHistoryItem {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as Partial<PlaybackHistoryItem>;
  return validText(item.id, MAX_TITLE_ID_LENGTH)
    && !/^https?:\/\//i.test(item.id)
    && validText(item.title, 512)
    && typeof item.group === "string" && item.group.length <= 512
    && (item.contentType === "movie" || item.contentType === "series" || item.contentType === "other")
    && (item.year === null || (typeof item.year === "number" && Number.isInteger(item.year)))
    && Number.isFinite(item.currentTimeSeconds) && item.currentTimeSeconds! > 0
    && Number.isFinite(item.durationSeconds) && item.durationSeconds! > 0
    && Number.isFinite(item.updatedAt) && item.updatedAt! >= 0
    && (item.season === undefined || Number.isInteger(item.season))
    && (item.episode === undefined || Number.isInteger(item.episode))
    && (item.providerKind === undefined || item.providerKind === "movie" || item.providerKind === "series")
    && (item.providerId === undefined || /^\d{1,20}$/.test(item.providerId))
    && (item.providerExtension === undefined || /^[a-z0-9]{1,10}$/i.test(item.providerExtension))
    && (item.providerSourceId === undefined || /^vod_[a-z0-9]{1,16}$/.test(item.providerSourceId));
}

function readItems(storage: KeyValueStorage | null): PlaybackHistoryItem[] {
  if (!storage) return [];
  try {
    const raw = storage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isHistoryItem)
      .sort((left, right) => right.updatedAt - left.updatedAt)
      .slice(0, MAX_SAVED_TITLES);
  } catch {
    return [];
  }
}

function isUnfinished(item: Pick<PlaybackHistoryItem, "currentTimeSeconds" | "durationSeconds">): boolean {
  return item.currentTimeSeconds < item.durationSeconds * 0.95
    && item.durationSeconds - item.currentTimeSeconds > 30;
}

/** Returns unfinished titles with the most recently played item first. */
export function loadPlaybackHistory(storage: KeyValueStorage | null = browserStorage()): PlaybackHistoryItem[] {
  return readItems(storage).filter(isUnfinished);
}

/** Saves a playhead and safe display metadata. Stream URLs and credentials are never stored here. */
export function savePlaybackProgress(
  item: PlaybackHistoryItem,
  storage: KeyValueStorage | null = browserStorage(),
): void {
  if (!storage || !isHistoryItem(item)) return;
  const items = readItems(storage).filter((saved) => saved.id !== item.id && isUnfinished(saved));
  if (isUnfinished(item)) items.push(item);
  items.sort((left, right) => right.updatedAt - left.updatedAt);
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify(items.slice(0, MAX_SAVED_TITLES)));
  } catch {
    // Keep playback usable for this session if local storage is unavailable.
  }
}

export function removePlaybackProgress(
  titleId: string,
  storage: KeyValueStorage | null = browserStorage(),
): void {
  if (!storage || !validText(titleId, MAX_TITLE_ID_LENGTH)) return;
  try {
    const items = readItems(storage).filter((item) => item.id !== titleId);
    storage.setItem(STORAGE_KEY, JSON.stringify(items));
  } catch {
    // History removal remains best-effort when local storage is unavailable.
  }
}

export function clearPlaybackProgress(storage: KeyValueStorage | null = browserStorage()): void {
  try {
    storage?.removeItem(STORAGE_KEY);
  } catch {
    // Reset can still clear the other app stores if local storage is unavailable.
  }
}
