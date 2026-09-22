import { describe, expect, it } from "vitest";
import { createBrowserSearchClient, createCompanionSearchClient, searchSafeRecords, toVodCatalogItem, type SafeSearchRecord, type SearchCatalogueStorage } from "./search-catalog.ts";

const fp = "vod_test123";
const record = (id: string, title: string, kind: "movie" | "series" = "movie"): SafeSearchRecord => ({
  id, kind, title, searchTitle: title.toLowerCase(), year: 2024, extension: "mkv", category: "Drama", sourceFingerprint: fp,
});

describe("companion search catalogue", () => {
  it("searches normalized terms, sorts deterministically, and caps result counts", () => {
    const records = [record("2", "The Café"), record("3", "Cafe Nights"), record("1", "Cafe Nights")];
    expect(searchSafeRecords(records, "CAFE nights").map(({ id }) => id)).toEqual(["1", "3"]);
    expect(searchSafeRecords(records, " ")).toEqual([]);
    expect(searchSafeRecords(Array.from({ length: 150 }, (_, index) => record(String(index + 1), "Match " + index)), "match", 500)).toHaveLength(100);
  });

  it("creates URL-free movie and series detail candidates", () => {
    const movie = toVodCatalogItem(record("12", "A Film (2024)"));
    const series = toVodCatalogItem(record("13", "A Series", "series"));
    expect(movie).toMatchObject({ id: "xtream:movie:12", contentType: "movie", year: 2024, streamUrl: "" });
    expect(series).toMatchObject({ id: "xtream:series:13", providerSeriesId: 13, streamUrl: "" });
    expect(JSON.stringify([movie, series])).not.toMatch(/https?:|password|username/i);
  });

  it("refreshes from the relay, filters cross-provider rows, and caches safe results", async () => {
    let saved: SafeSearchRecord[] = [];
    const storage: SearchCatalogueStorage = {
      load: async () => saved,
      save: async (_fingerprint, values) => { saved = values; },
    };
    let requested = "";
    const client = createCompanionSearchClient({
      baseUrl: "http://localhost:4312/path",
      storage,
      fetcher: async (url) => {
        requested = url;
        return { ok: true, json: async () => ({ refreshedAt: 123, records: [
          { id: "5", kind: "movie", title: "Safe Title", year: 2021, extension: "mp4", category: "Films", sourceFingerprint: fp, streamUrl: "http://secret/credential" },
          { id: "6", kind: "movie", title: "Other Provider", sourceFingerprint: "other" },
          { id: "../x", kind: "movie", title: "Bad ID", sourceFingerprint: fp },
        ] }) };
      },
    });
    const result = await client.refresh(fp, "session_12345678");
    expect(new URL(requested).origin).toBe("http://localhost:4312");
    expect(result).toEqual({ refreshedAt: 123, records: [{
      id: "5", kind: "movie", title: "Safe Title", searchTitle: "safe title", year: 2021,
      extension: "mp4", category: "Films", sourceFingerprint: fp,
    }] });
    expect(saved).toEqual(result.records);
    expect(await client.loadCached(fp)).toEqual(result.records);
  });

  it("refreshes the browser provider without a relay and stores only safe deduplicated rows", async () => {
    let saved: SafeSearchRecord[] = [];
    const storage: SearchCatalogueStorage = { load: async () => saved, save: async (_key, rows) => { saved = rows; } };
    const calls: string[] = [];
    const client = createBrowserSearchClient({
      playlistUrl: "https://provider.example/get.php?username=private&password=secret",
      storage,
      providerFactory: () => ({
        pairingFingerprint: () => fp,
        categories: async () => [
          { id: "1", name: "Films", contentType: "movie" },
          { id: "2", name: "Drama", contentType: "series" },
          { id: "3", name: "Other films", contentType: "movie" },
        ],
        movies: async (category) => {
          calls.push("movie:" + category);
          return [{ id: "xtream:movie:4", title: "A Safe Film", searchTitle: "a safe film", searchTerms: [], year: 2020, group: "", contentType: "movie", addedAt: 0, sourceLine: 4, streamUrl: "https://provider.example/private/secret/4.mkv" }];
        },
        series: async (category) => {
          calls.push("series:" + category);
          return [{ id: "xtream:series:9", title: "A Series", searchTitle: "a series", searchTerms: [], year: null, group: "", contentType: "series", addedAt: 0, sourceLine: 9, streamUrl: "" }];
        },
      }),
    });
    const result = await client.refresh();
    expect(calls.sort()).toEqual(["movie:1", "movie:3", "series:2"]);
    expect(result.records).toHaveLength(2);
    expect(result.records.map(({ id, kind, category }) => [id, kind, category])).toEqual([
      ["4", "movie", "Films"], ["9", "series", "Drama"],
    ]);
    expect(JSON.stringify(result)).not.toMatch(/provider\.example|private|secret|streamUrl/i);
    expect(saved).toEqual(result.records);
    expect(await client.loadCached()).toEqual(result.records);
  });

  it("keeps the prior complete cache when any provider category fails", async () => {
    const oldRows = [record("77", "Cached Film")];
    let saves = 0;
    const storage: SearchCatalogueStorage = { load: async () => oldRows, save: async () => { saves++; } };
    const client = createBrowserSearchClient({
      playlistUrl: "synthetic",
      storage,
      providerFactory: () => ({
        pairingFingerprint: () => fp,
        categories: async () => [{ id: "ok", name: "Good", contentType: "movie" }, { id: "bad", name: "Bad", contentType: "series" }],
        movies: async () => [],
        series: async () => { throw new TypeError("CORS failure https://private.example/user/pass"); },
      }),
    });
    await expect(client.refresh()).rejects.toThrow("could not be reached from this browser");
    expect(saves).toBe(0);
    expect(await client.loadCached()).toEqual(oldRows);
  });
});
