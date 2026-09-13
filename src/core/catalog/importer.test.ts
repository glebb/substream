import { describe, expect, it } from "vitest";
import { importM3uChunks } from "./importer.ts";
import type { CatalogImportSink, CatalogImportSummary, VodCatalogItem } from "./index.ts";

async function* chunks(): AsyncGenerator<string> {
  yield "#EXTM3U\n#EXTINF:-1 group-title=\"Movies: Finland\",FI:First - 2020\nhttps://iptv.example/mo";
  yield "vie/user/pass/1.mkv\n#EXTINF:-1,Channel\nhttps://iptv.example/live/user/pass/2.ts\n#EXTINF:-1 group-title=\"Unclear\",Mystery\nhttps://iptv.example/media/opaque?id=3\n";
}

describe("importM3uChunks", () => {
  it("parses split chunks and sends only VOD entries to a batch sink", async () => {
    const written: VodCatalogItem[] = [];
    const retainedUnknown: unknown[] = [];
    let summary: CatalogImportSummary | undefined;
    const sink: CatalogImportSink = {
      begin: async () => undefined,
      append: async (items, unknowns = []) => { written.push(...items); retainedUnknown.push(...unknowns); },
      complete: async (result) => { summary = result; },
    };

    const result = await importM3uChunks(chunks(), sink, { batchSize: 1 });

    expect(result).toMatchObject({ processedEntries: 3, importedItems: 1, unknownEntries: 1, warnings: 0 });
    expect(written).toMatchObject([{ title: "First", contentType: "movie" }]);
    expect(retainedUnknown).toMatchObject([{ entry: { name: "Mystery", url: "https://iptv.example/media/opaque?id=3" }, classification: { kind: "unknown", evidence: expect.any(Array) } }]);
    expect(summary).toEqual(result);
  });
});
