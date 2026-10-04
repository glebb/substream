import { describe, expect, it } from "vitest";
import { dnaGuideCacheKey, guideIsFresh, safeCache, safeDnaGuideCache, safeGuideCache, EPG_CACHE_TTL_MS } from "./live-cache.ts";

function store(value: string | null) { return { get: () => value, set: () => {}, remove: () => {} }; }

describe("device-owned live guide cache", () => {
  it("tolerates corrupt, missing and inaccessible cache entries", () => {
    for (const value of [null, "{broken", "[]", "null"]) {
      expect(safeCache(store(value), "synthetic")).toBeNull();
      expect(safeGuideCache(store(value), "synthetic")).toBeNull();
      expect(safeDnaGuideCache(store(value), "synthetic", 0)).toBeNull();
    }
    const unavailable = { get: () => { throw new Error("storage denied"); }, set: () => {}, remove: () => {} };
    expect(safeGuideCache(unavailable, "synthetic")).toBeNull();
  });

  it("expires programme data when the programme at fetch has ended", () => {
    const guide = { savedAt: 1000, programmes: [{ channelId: "synthetic", title: "Synthetic Programme", startTime: 0, endTime: 2000 }] };
    expect(guideIsFresh(guide, 1500)).toBe(true);
    expect(guideIsFresh(guide, 2000)).toBe(false);
    expect(guideIsFresh({ savedAt: 0, programmes: [] }, EPG_CACHE_TTL_MS)).toBe(false);
  });

  it("isolates DNA cache windows and respects enrichment TTL", () => {
    expect(dnaGuideCacheKey("synthetic-channel", 0)).not.toBe(dnaGuideCacheKey("synthetic-channel", 6 * 60 * 60 * 1000));
    const value = JSON.stringify({ savedAt: 0, programmes: [] });
    expect(safeDnaGuideCache(store(value), "synthetic", EPG_CACHE_TTL_MS - 1)).not.toBeNull();
    expect(safeDnaGuideCache(store(value), "synthetic", EPG_CACHE_TTL_MS)).toBeNull();
  });
});
