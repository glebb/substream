import { describe, expect, it } from "vitest";
import { formatRuntime, titleDetailsFor } from "./title-details.ts";
import type { VodCatalogItem } from "../core/catalog/index.ts";

const item = (metadata?: unknown): VodCatalogItem => ({
  id: "movie:1", title: "Example", searchTitle: "example", searchTerms: ["example"], year: 2024,
  group: "Movies", contentType: "movie", addedAt: 0, streamUrl: "https://media.invalid/a", sourceLine: 1,
  ...(metadata === undefined ? {} : { metadata } as Partial<VodCatalogItem>),
} as VodCatalogItem);

describe("title details", () => {
  it("accepts complete metadata and formats runtime", () => {
    expect(titleDetailsFor(item({ posterUrl: "https://image.tmdb.org/poster.jpg", synopsis: "A story", year: 2023, genres: ["Drama"], runtimeMinutes: 125, rating: 8.2, subtitleLanguages: ["English"] }))).toEqual({
      posterUrl: "https://image.tmdb.org/poster.jpg", synopsis: "A story", year: 2023, genres: ["Drama"], runtimeMinutes: 125, rating: 8.2, subtitleLanguages: ["English"],
    });
    expect(formatRuntime(125)).toBe("2h 5m");
  });

  it("falls back safely and rejects malformed artwork", () => {
    expect(titleDetailsFor(item({ posterUrl: "javascript:alert(1)", genres: ["", 2], rating: 99 }))).toEqual({ year: 2024, genres: [], subtitleLanguages: [] });
  });
});
