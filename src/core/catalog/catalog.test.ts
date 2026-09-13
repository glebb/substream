import { describe, expect, it } from "vitest";
import { parseM3u } from "../m3u/index.ts";
import { buildVodCatalog, normalizeTitle, searchVodCatalog } from "./index.ts";

describe("normalizeTitle", () => {
  it("removes language prefixes, extracts a year, and normalizes accents for searching", () => {
    expect(normalizeTitle("FI:Risto Räppääjä ja väärä Vincent - 2020")).toEqual({
      title: "Risto Räppääjä ja väärä Vincent",
      searchTitle: "risto rappaaja ja vaara vincent",
      year: 2020,
    });
  });

  it("extracts season and episode while searching by the series title", () => {
    expect(normalizeTitle("SE:Example Show S01E02 - 2024")).toMatchObject({
      title: "Example Show S01E02",
      searchTitle: "example show",
      year: 2024,
      season: 1,
      episode: 2,
    });
    expect(normalizeTitle("Example Show 2x10")).toMatchObject({ searchTitle: "example show", season: 2, episode: 10 });
    expect(normalizeTitle("NC - Silo (2023) S03 E01")).toMatchObject({
      searchTitle: "silo",
      year: 2023,
      season: 3,
      episode: 1,
    });
    expect(normalizeTitle("NC - The Example Movie - 2024")).toMatchObject({
      title: "The Example Movie",
      searchTitle: "the example movie",
      year: 2024,
    });
  });
});

describe("VodCatalog", () => {
  const entries = parseM3u(`#EXTM3U
#EXTINF:-1 group-title="Movies: Finland",FI:Risto Räppääjä ja väärä Vincent - 2020
https://iptv.example/movie/user/pass/1.mkv
#EXTINF:-1 group-title="Series: Nordic",SE:Example Show S01E01 - 2024
https://iptv.example/series/user/pass/2.mkv
#EXTINF:-1 group-title="Sweden - Movies Club",SE: Film Channel FHD
https://iptv.example/live/user/pass/3.ts
#EXTINF:-1 group-title="Unclear",Mystery stream
https://iptv.example/media/opaque?id=4
`).entries;

  it("keeps only VOD entries and identifies provider movie/series routes", () => {
    const catalog = buildVodCatalog(entries);

    expect(catalog.items).toHaveLength(2);
    expect(catalog.contentTypeCounts).toEqual(new Map([["movie", 1], ["series", 1], ["other", 0]]));
    expect(catalog.items[0]).toMatchObject({ title: "Risto Räppääjä ja väärä Vincent", year: 2020, contentType: "movie" });
    expect(catalog.items[0]?.searchTerms).toContain("rappaaja");
    expect(catalog.items[1]).toMatchObject({ searchTitle: "example show", season: 1, episode: 1 });
  });

  it("searches normalized titles within a bounded result set", () => {
    const catalog = buildVodCatalog(entries);

    expect(searchVodCatalog(catalog, "rappaaja", { contentType: "movie", limit: 1 }))
      .toMatchObject([{ title: "Risto Räppääjä ja väärä Vincent" }]);
  });

  it("retains unknown entries with classifier evidence separately from VOD", () => {
    const catalog = buildVodCatalog(entries);

    expect(catalog.items).toHaveLength(2);
    expect(catalog.unknownEntries).toHaveLength(1);
    expect(catalog.unknownEntries[0]).toMatchObject({
      entry: { name: "Mystery stream", attributes: { "group-title": "Unclear" } },
      classification: { kind: "unknown", evidence: ["No reliable VOD or live markers"] },
    });
    expect(catalog.items[0]?.classification).toMatchObject({ kind: "vod", evidence: expect.any(Array) });
  });
});
