import { describe, expect, it } from "vitest";
import { TmdbMetadataCache, tmdbCacheKey } from "./tmdb-cache.ts";

const metadata = (id: number) => ({ id, mediaType: "movie" as const, title: "Movie " + id, overview: "", year: 2024, genres: [], runtime: null, rating: null, posterUrl: null, backdropUrl: null, language: "fi-FI" });
describe("TMDb metadata cache", () => {
  it("expires entries and bounds the newest entries", () => {
    const values = new Map<string, string>(); const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value) };
    const cache = new TmdbMetadataCache(storage, 100, 2); cache.set(metadata(1), 1); cache.set(metadata(2), 2); cache.set(metadata(3), 3);
    expect(cache.get(1, "movie", 3)).toBeNull(); expect(cache.get(2, "movie", 3)?.id).toBe(2); expect(Object.keys(JSON.parse(values.get(tmdbCacheKey)!))).toHaveLength(2);
  });
});
