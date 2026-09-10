import "fake-indexeddb/auto";
import { afterEach, describe, expect, it } from "vitest";
import { buildVodCatalog } from "../../core/catalog/index.ts";
import { parseM3u } from "../../core/m3u/index.ts";
import { IndexedDbCatalogStore } from "./indexed-db-catalog.ts";

const entries = parseM3u(`#EXTM3U
#EXTINF:-1 group-title="Movies: Finland",FI:Risto Räppääjä ja väärä Vincent - 2020
https://iptv.example/movie/user/pass/1.mkv
#EXTINF:-1 group-title="Series: Nordic",SE:Example Show S01E01 - 2024
https://iptv.example/series/user/pass/2.mkv
`).entries;

let store: IndexedDbCatalogStore | undefined;

afterEach(() => store?.close());

describe("IndexedDbCatalogStore", () => {
  it("stores catalog items in batches and exposes indexed groups and searches", async () => {
    store = await IndexedDbCatalogStore.open();
    await store.replaceAll(buildVodCatalog(entries).items);

    await expect(store.metadata()).resolves.toMatchObject({ status: "ready", itemCount: 2, groupCount: 2 });
    await expect(store.groups()).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "Movies: Finland", count: 1, contentType: "movie" }),
    ]));
    await expect(store.byGroup("Series: Nordic")).resolves.toMatchObject([{ title: "Example Show S01E01" }]);
    await expect(store.byGroupPage("Movies: Finland", 1)).resolves.toEqual([]);
    await expect(store.search("rapp")).resolves.toMatchObject([{ title: "Risto Räppääjä ja väärä Vincent" }]);
  });

  it("pages a group by title, playlist order, or release year", async () => {
    store = await IndexedDbCatalogStore.open();
    const [first] = buildVodCatalog(entries).items;
    if (!first) throw new Error("Missing fixture item");
    await store.replaceAll([
      { ...first, id: "z", title: "Zulu", searchTitle: "zulu", sourceLine: 20, year: 2020, addedAt: 200 },
      { ...first, id: "a", title: "Alpha", searchTitle: "alpha", sourceLine: 10, year: 2024, addedAt: 100 },
    ]);

    await expect(store.byGroupPage(first.group, 0, 2, "title")).resolves.toMatchObject([{ title: "Alpha" }, { title: "Zulu" }]);
    await expect(store.byGroupPage(first.group, 0, 2, "playlist")).resolves.toMatchObject([{ title: "Alpha" }, { title: "Zulu" }]);
    await expect(store.byGroupPage(first.group, 0, 2, "year")).resolves.toMatchObject([{ title: "Alpha" }, { title: "Zulu" }]);
  });
});
