import { describe, expect, it } from "vitest";
import { TmdbArtworkCache, TmdbImageCache, tmdbArtworkCacheKey, tmdbImageCacheKey } from "./tmdb-cache.ts";

describe("TMDb image cache", () => {
  it("caches only safe TMDb images with expiry and hard bounds", async () => {
    const values = new Map<string, string>(); const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value) };
    const cache = new TmdbImageCache(storage, 100, 2, 10); let calls = 0;
    const fetcher = async () => { calls++; return { ok: true, status: 200, arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer }; };
    const url = "https://image.tmdb.org/t/p/w500/a.jpg";
    expect(await cache.getOrFetch(url, fetcher, 1)).toContain("data:image/jpeg;base64,"); expect(await cache.getOrFetch(url, fetcher, 2)).toContain("data:image/jpeg;base64,"); expect(calls).toBe(1);
    expect(cache.get(url, 102)).toBeNull(); await cache.getOrFetch("https://evil.example/a.jpg", fetcher); expect(calls).toBe(1); expect(Object.keys(JSON.parse(values.get(tmdbImageCacheKey)!))).toHaveLength(1);
  });
});

describe("TMDb artwork lookup cache", () => {
  it("remembers missing artwork and only accepts canonical poster URLs", () => {
    const values = new Map<string, string>(); const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value) };
    const cache = new TmdbArtworkCache(storage, 100, 2);
    cache.set("movie:one", null, 1);
    cache.set("movie:two", "https://image.tmdb.org/t/p/w500/two.jpg", 2);
    cache.set("movie:unsafe", "https://example.test/poster.jpg", 3);
    expect(cache.get("movie:one", 4)).toBeNull();
    expect(cache.get("movie:two", 4)).toBe("https://image.tmdb.org/t/p/w500/two.jpg");
    expect(cache.get("movie:unsafe", 4)).toBeUndefined();
    expect(cache.get("movie:two", 103)).toBeUndefined();
    expect(Object.keys(JSON.parse(values.get(tmdbArtworkCacheKey)!))).toHaveLength(2);
  });
});
