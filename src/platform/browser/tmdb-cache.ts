import type { TmdbMetadata } from "../tmdb/client.ts";

const KEY = "substream.tmdb-metadata-cache";
const DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_MAX_ENTRIES = 100;
const IMAGE_KEY = "substream.tmdb-image-cache";
const ARTWORK_KEY = "substream.tmdb-artwork-cache";
const DEFAULT_MAX_IMAGE_ENTRIES = 40;
const DEFAULT_MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const DEFAULT_MAX_ARTWORK_ENTRIES = 240;
type CacheRecord = { value: TmdbMetadata; savedAt: number };
export type CacheStorage = Pick<Storage, "getItem" | "setItem">;
type ImageRecord = { dataUrl: string; savedAt: number; size: number };
type ArtworkRecord = { posterUrl: string | null; savedAt: number };
export type ThumbnailResponse = { ok: boolean; status: number; arrayBuffer(): Promise<ArrayBuffer> };
export type ThumbnailFetcher = (url: string) => Promise<ThumbnailResponse>;

function isSafeImageUrl(url: string): boolean {
  try { const parsed = new URL(url); return parsed.protocol === "https:" && parsed.hostname === "image.tmdb.org" && !/[?&](?:token|key|sig|signature)=/i.test(parsed.search); } catch { return false; }
}

/** Small, optional data-URL cache for TMDb posters. Only canonical TMDb image URLs are cached. */
export class TmdbImageCache {
  constructor(private readonly storage: CacheStorage | undefined = (() => { try { return globalThis.localStorage; } catch { return undefined; } })(), private readonly ttlMs = DEFAULT_TTL_MS, private readonly maxEntries = DEFAULT_MAX_IMAGE_ENTRIES, private readonly maxBytes = DEFAULT_MAX_IMAGE_BYTES) {}
  private read(): Record<string, ImageRecord> { try { const value: unknown = JSON.parse(this.storage?.getItem(IMAGE_KEY) ?? "{}"); return value && typeof value === "object" ? value as Record<string, ImageRecord> : {}; } catch { return {}; } }
  get(url: string, now = Date.now()): string | null { if (!isSafeImageUrl(url)) return null; const record = this.read()[url]; return record && now - record.savedAt <= this.ttlMs ? record.dataUrl : null; }
  async getOrFetch(url: string, fetcher: ThumbnailFetcher, now = Date.now()): Promise<string | null> {
    const cached = this.get(url, now); if (cached) return cached; if (!isSafeImageUrl(url)) return null;
    try {
      const response = await fetcher(url); if (!response.ok) return null;
      const bytes = new Uint8Array(await response.arrayBuffer()); if (!bytes.byteLength || bytes.byteLength > this.maxBytes) return null;
      let binary = ""; for (const byte of bytes) binary += String.fromCharCode(byte);
      const dataUrl = "data:image/jpeg;base64," + btoa(binary); this.set(url, dataUrl, bytes.byteLength, now); return dataUrl;
    } catch { return null; }
  }
  set(url: string, dataUrl: string, size = dataUrl.length, now = Date.now()): void {
    if (!isSafeImageUrl(url) || !dataUrl.startsWith("data:image/")) return;
    const records = this.read(); records[url] = { dataUrl, savedAt: now, size };
    const keys = Object.keys(records).sort((a, b) => (records[b]?.savedAt ?? 0) - (records[a]?.savedAt ?? 0));
    const bounded: Record<string, ImageRecord> = {}; let total = 0;
    for (const key of keys) { const item = records[key]; if (!item || Object.keys(bounded).length >= Math.max(1, this.maxEntries) || total + item.size > this.maxBytes) continue; bounded[key] = item; total += item.size; }
    try { this.storage?.setItem(IMAGE_KEY, JSON.stringify(bounded)); } catch { /* thumbnail caching is optional */ }
  }
  clear(): void { try { this.storage?.setItem(IMAGE_KEY, "{}"); } catch { /* optional */ } }
}

/**
 * Remembers the outcome of a title search separately from the image bytes.
 * A null poster is intentional: it prevents repeated searches for titles that
 * TMDb cannot confidently match or that simply have no artwork.
 */
export class TmdbArtworkCache {
  constructor(private readonly storage: CacheStorage | undefined = (() => { try { return globalThis.localStorage; } catch { return undefined; } })(), private readonly ttlMs = DEFAULT_TTL_MS, private readonly maxEntries = DEFAULT_MAX_ARTWORK_ENTRIES) {}
  private read(): Record<string, ArtworkRecord> { try { const value: unknown = JSON.parse(this.storage?.getItem(ARTWORK_KEY) ?? "{}"); return value && typeof value === "object" ? value as Record<string, ArtworkRecord> : {}; } catch { return {}; } }
  get(key: string, now = Date.now()): string | null | undefined {
    const record = this.read()[key];
    return record && now - record.savedAt <= this.ttlMs ? record.posterUrl : undefined;
  }
  set(key: string, posterUrl: string | null, now = Date.now()): void {
    if (!key || (posterUrl !== null && !isSafeImageUrl(posterUrl))) return;
    const records = this.read(); records[key] = { posterUrl, savedAt: now };
    const keys = Object.keys(records).sort((a, b) => (records[b]?.savedAt ?? 0) - (records[a]?.savedAt ?? 0)).slice(0, Math.max(1, this.maxEntries));
    const bounded: Record<string, ArtworkRecord> = {}; for (const item of keys) { const record = records[item]; if (record) bounded[item] = record; }
    try { this.storage?.setItem(ARTWORK_KEY, JSON.stringify(bounded)); } catch { /* artwork lookup caching is optional */ }
  }
  clear(): void { try { this.storage?.setItem(ARTWORK_KEY, "{}"); } catch { /* optional */ } }
}

export class TmdbMetadataCache {
  constructor(private readonly storage: CacheStorage | undefined = (() => { try { return globalThis.localStorage; } catch { return undefined; } })(), private readonly ttlMs = DEFAULT_TTL_MS, private readonly maxEntries = DEFAULT_MAX_ENTRIES) {}
  private read(): Record<string, CacheRecord> {
    try { const parsed: unknown = JSON.parse(this.storage?.getItem(KEY) ?? "{}"); return parsed && typeof parsed === "object" ? parsed as Record<string, CacheRecord> : {}; } catch { return {}; }
  }
  get(id: number, mediaType: "movie" | "tv", now = Date.now()): TmdbMetadata | null {
    const key = mediaType + ":" + id; const record = this.read()[key];
    if (!record || !record.value || now - record.savedAt > this.ttlMs) return null;
    return record.value;
  }
  set(value: TmdbMetadata, now = Date.now()): void {
    const records = this.read(); const key = value.mediaType + ":" + value.id;
    records[key] = { savedAt: now, value };
    const keys = Object.keys(records).sort((a, b) => (records[b]?.savedAt ?? 0) - (records[a]?.savedAt ?? 0)).slice(0, Math.max(1, this.maxEntries));
    const bounded: Record<string, CacheRecord> = {}; for (const item of keys) { const record = records[item]; if (record) bounded[item] = record; }
    try { this.storage?.setItem(KEY, JSON.stringify(bounded)); } catch { /* cache failures must not affect playback */ }
  }
  clear(): void { try { this.storage?.setItem(KEY, "{}"); } catch { /* optional */ } }
}

export const tmdbCacheKey = KEY;
export const tmdbImageCacheKey = IMAGE_KEY;
export const tmdbArtworkCacheKey = ARTWORK_KEY;
