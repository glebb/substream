import { describe, expect, it } from "vitest";
import { orderLatestVodItems } from "./latest.ts";
import type { VodCatalogItem } from "./types.ts";

function item(id: string, type: "movie" | "series" | "other", addedAt: number, url = id): VodCatalogItem {
  return { id, title: id, searchTitle: id, searchTerms: [id], year: null, group: "g", contentType: type, addedAt, streamUrl: url, sourceLine: 1 };
}

describe("orderLatestVodItems", () => {
  it("filters by type, de-duplicates stream identity, and sorts newest first with stable ties", () => {
    const input = [item("old", "movie", 1), item("z", "movie", 5), item("a", "movie", 5), item("duplicate", "movie", 9, "z"), item("show", "series", 10)];
    expect(orderLatestVodItems(input, "movie").map(({ id }) => id)).toEqual(["duplicate", "a", "old"]);
    expect(orderLatestVodItems([item("a", "movie", 1), item("b", "movie", 1)], "movie").map(({ id }) => id)).toEqual(["a", "b"]);
  });

  it("deduplicates provider records by ID, keeps the newest variant, and normalizes invalid dates", () => {
    const older = item("xtream:movie:42", "movie", 100, "https://example/42.mp4");
    const newer = { ...older, title: "Newest variant", addedAt: 500, streamUrl: "https://example/42.mkv" };
    const invalid = item("invalid", "movie", Number.NaN);
    const zero = item("zero", "movie", 0);
    expect(orderLatestVodItems([older, newer, invalid, zero], "movie").map(({ id, title }) => [id, title]))
      .toEqual([["xtream:movie:42", "Newest variant"], ["invalid", "invalid"], ["zero", "zero"]]);
  });
});
