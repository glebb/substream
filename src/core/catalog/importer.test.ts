import { describe, expect, it } from "vitest";
import { importM3uChunks } from "./importer.ts";
import type { CatalogImportSink, CatalogImportSummary, VodCatalogItem } from "./index.ts";

async function* chunks(): AsyncGenerator<string> {
  yield "#EXTM3U\n#EXTINF:-1 group-title=\"Movies: Finland\",FI:First - 2020\nhttps://iptv.example/mo";
  yield "vie/user/pass/1.mkv\n#EXTINF:-1,Channel\nhttps://iptv.example/live/user/pass/2.ts\n";
}

describe("importM3uChunks", () => {
  it("parses split chunks and sends only VOD entries to a batch sink", async () => {
    const written: VodCatalogItem[] = [];
    let summary: CatalogImportSummary | undefined;
    const sink: CatalogImportSink = {
      begin: async () => undefined,
      append: async (items) => { written.push(...items); },
      complete: async (result) => { summary = result; },
    };

    const result = await importM3uChunks(chunks(), sink, { batchSize: 1 });

    expect(result).toMatchObject({ processedEntries: 2, importedItems: 1, warnings: 0 });
    expect(written).toMatchObject([{ title: "First", contentType: "movie" }]);
    expect(summary).toEqual(result);
  });
});
