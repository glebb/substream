import type { EpgProgramme, LiveCategory, LiveChannel } from "../core/live/index.ts";
import type { PreferencesRepository } from "../contracts/repository.ts";

const DNA_EPG_CACHE_PREFIX = "substream.dna-epg.v1.";
export const EPG_CACHE_TTL_MS = 12 * 60 * 1000;

export type CachedLive = { savedAt: number; categories: LiveCategory[]; channelsByCategory: Record<string, LiveChannel[]> };
export type CachedGuide = { savedAt: number; programmes: EpgProgramme[]; dnaAttemptAt?: number; source?: "nordic-skyshowtime" };
export type CachedDnaGuide = { savedAt: number; programmes: EpgProgramme[] };

export function safeGuideCache(storage: PreferencesRepository, key: string): CachedGuide | null {
  try {
    const value = JSON.parse(storage.get(key) ?? "null") as CachedGuide | null;
    return value && typeof value.savedAt === "number" && Array.isArray(value.programmes) ? value : null;
  } catch { return null; }
}


export function safeDnaGuideCache(storage: PreferencesRepository, key: string, now: number): CachedDnaGuide | null {
  try {
    const value = JSON.parse(storage.get(key) ?? "null") as CachedDnaGuide | null;
    return value && typeof value.savedAt === "number" && Array.isArray(value.programmes)
      && now - value.savedAt < EPG_CACHE_TTL_MS ? value : null;
  } catch { return null; }
}


export function dnaGuideCacheKey(channelId: string, now: number): string {
  const windowMs = 6 * 60 * 60 * 1000;
  return `${DNA_EPG_CACHE_PREFIX}${channelId}.${Math.floor(now / windowMs)}`;
}


export function guideIsFresh(guide: CachedGuide, now: number): boolean {
  const programmeAtFetch = guide.programmes.find((item) => item.startTime <= guide.savedAt && item.endTime > guide.savedAt);
  return now - guide.savedAt < EPG_CACHE_TTL_MS && (!programmeAtFetch || now < programmeAtFetch.endTime);
}


export function safeCache(storage: PreferencesRepository, key: string): CachedLive | null {
  try {
    const value = JSON.parse(storage.get(key) ?? "null") as CachedLive | null;
    return value && Array.isArray(value.categories) && value.channelsByCategory && typeof value.channelsByCategory === "object" && typeof value.savedAt === "number" ? value : null;
  } catch { return null; }
}

