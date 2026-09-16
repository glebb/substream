import { describe, expect, it } from "vitest";
import { TmdbImageCache, tmdbImageCacheKey } from "./tmdb-cache.ts";

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
