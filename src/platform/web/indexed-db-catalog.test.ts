import "fake-indexeddb/auto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildVodCatalog } from "../../core/catalog/index.ts";
import { parseM3u } from "../../core/m3u/index.ts";
import { importM3uChunks } from "../../core/catalog/index.ts";
import { IndexedDbCatalogOpenError, IndexedDbCatalogStore } from "./indexed-db-catalog.ts";

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
    const openProgress: Array<{ stage: string; processedItems: number }> = [];
    store = await IndexedDbCatalogStore.open((progress) => openProgress.push(progress));
    expect(openProgress).toContainEqual({ stage: "opening", processedItems: 0 });
    expect(openProgress).toContainEqual({ stage: "upgrading", processedItems: 0 });
    await store.replaceAll(buildVodCatalog(entries).items);

    await expect(store.metadata()).resolves.toMatchObject({ status: "ready", itemCount: 2, groupCount: 2 });
    await expect(store.groups()).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "Movies: Finland", count: 1, contentType: "movie" }),
    ]));
    await expect(store.byGroup("Series: Nordic")).resolves.toMatchObject([{ title: "Example Show S01E01" }]);
    await expect(store.byGroupPage("Movies: Finland", 1)).resolves.toEqual([]);
    await expect(store.search("rapp")).resolves.toMatchObject([{ title: "Risto Räppääjä ja väärä Vincent" }]);
  });

  it("keeps the active catalogue visible and restores it after a failed replacement", async () => {
    store = await IndexedDbCatalogStore.open();
    const [original] = buildVodCatalog(entries).items;
    if (!original) throw new Error("Missing fixture item");
    await store.replaceAll([original]);
    const replacement = { ...original, id: original.id, title: "Replacement", searchTitle: "replacement", group: "Replacement group" };

    await store.begin();
    await store.append([replacement]);
    await expect(store.groups()).resolves.toMatchObject([{ name: original.group }]);
    await expect(store.byGroup(original.group)).resolves.toMatchObject([{ title: original.title }]);
    await store.fail();

    await expect(store.metadata()).resolves.toMatchObject({ status: "ready", itemCount: 1 });
    await expect(store.groups()).resolves.toMatchObject([{ name: original.group }]);
    await expect(store.byGroup(original.group)).resolves.toMatchObject([{ title: original.title }]);
    await expect(store.byGroup("Replacement group")).resolves.toEqual([]);
  });

  it("cleans up the pending generation when replaceAll append fails", async () => {
    store = await IndexedDbCatalogStore.open();
    const [original] = buildVodCatalog(entries).items;
    if (!original) throw new Error("Missing fixture item");
    await store.replaceAll([original]);
    const activeGeneration = (await store.metadata()).activeGeneration;
    const replacement = { ...original, title: "Replacement", searchTitle: "replacement", group: "Replacement group" };
    const append = store.append.bind(store);
    const appendSpy = vi.spyOn(store, "append").mockImplementationOnce(async (batch, unknowns) => {
      await append(batch, unknowns);
      throw new Error("synthetic append failure");
    });

    try {
      await expect(store.replaceAll([replacement])).rejects.toThrow("synthetic append failure");
    } finally {
      appendSpy.mockRestore();
    }

    await expect(store.metadata()).resolves.toMatchObject({ status: "ready", activeGeneration, itemCount: 1 });
    await expect(store.metadata()).resolves.not.toHaveProperty("pendingGeneration");
    await expect(store.byGroup(original.group)).resolves.toMatchObject([{ title: original.title }]);
    await expect(store.byGroup("Replacement group")).resolves.toEqual([]);
  });

  it("does not mark an empty catalogue ready after its first import fails", async () => {
    store?.close();
    store = undefined;
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.deleteDatabase("substream-catalog");
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
      request.onblocked = () => reject(new Error("Test database deletion was blocked"));
    });
    store = await IndexedDbCatalogStore.open();
    await store.begin();
    await store.fail();

    await expect(store.metadata()).resolves.toMatchObject({ status: "failed", itemCount: 0 });
  });

  it("uses provider category identifiers when display names collide", async () => {
    store = await IndexedDbCatalogStore.open();
    await store.replaceProviderGroups([
      { id: "provider:movie:1", name: "Movies: Same name", count: 0, contentType: "movie", providerCategoryId: "1", providerContentType: "movie" },
      { id: "provider:movie:2", name: "Movies: Same name", count: 0, contentType: "movie", providerCategoryId: "2", providerContentType: "movie" },
    ]);

    const groups = await store.groups();
    expect(groups).toHaveLength(2);
    expect(groups.map((group) => group.id).sort()).toEqual(["provider:movie:1", "provider:movie:2"]);
    expect(groups.map((group) => group.name)).toEqual(["Movies: Same name", "Movies: Same name"]);
  });

  it("looks up saved title IDs and clears catalogue records without deleting the database", async () => {
    store = await IndexedDbCatalogStore.open();
    const [item] = buildVodCatalog(entries).items;
    if (!item) throw new Error("Missing fixture item");
    await store.replaceAll([item]);

    await expect(store.byIds([item.id, "missing"])).resolves.toEqual([
      expect.objectContaining({ id: item.id, title: item.title, streamUrl: item.streamUrl }),
    ]);
    await store.clearCatalog();
    await expect(store.metadata()).resolves.toMatchObject({ status: "empty", itemCount: 0, groupCount: 0, unknownCount: 0 });
    await expect(store.groups()).resolves.toEqual([]);
    await expect(store.byIds([item.id])).resolves.toEqual([]);
  });

  it("returns the global first alphabetical search matches before enforcing its bound", async () => {
    store = await IndexedDbCatalogStore.open();
    const [template] = buildVodCatalog(entries).items;
    if (!template) throw new Error("Missing fixture item");
    const make = (id: string, title: string) => ({
      ...template,
      id,
      title,
      searchTitle: title.toLowerCase(),
      searchTerms: [title.toLowerCase()],
      group: "Search fixture",
    });
    await store.replaceAll([make("a", "Maple"), make("b", "Mango"), make("z", "Mallow")]);

    await expect(store.search("ma", 2)).resolves.toMatchObject([{ title: "Mallow" }, { title: "Mango" }]);
  });

  it("pages a group by title, playlist order, or release year", async () => {
    store = await IndexedDbCatalogStore.open();
    const [first] = buildVodCatalog(entries).items;
    if (!first) throw new Error("Missing fixture item");
    await store.replaceAll([
      { ...first, id: "z", title: "Zulu", searchTitle: "zulu", sourceLine: 20, year: 2020, addedAt: 200 },
      { ...first, id: "a", title: "Alpha", searchTitle: "alpha", sourceLine: 10, year: 2024, addedAt: 100 },
      { ...first, id: "unknown", title: "Mystery", searchTitle: "mystery", sourceLine: 30, year: null, addedAt: 300 },
    ]);

    await expect(store.byGroupPage(first.group, 0, 3, "title")).resolves.toMatchObject([{ title: "Alpha" }, { title: "Mystery" }, { title: "Zulu" }]);
    await expect(store.byGroupPage(first.group, 0, 2, "playlist")).resolves.toMatchObject([{ title: "Alpha" }, { title: "Zulu" }]);
    await expect(store.byGroupPage(first.group, 0, 2, "year")).resolves.toMatchObject([{ title: "Alpha" }, { title: "Zulu" }]);
    await expect(store.byGroupPage(first.group, 2, 2, "year")).resolves.toMatchObject([{ title: "Mystery", year: null }]);
  });

  it("persists unknown import entries with evidence outside VOD browsing", async () => {
    store = await IndexedDbCatalogStore.open();
    async function* playlist(): AsyncGenerator<string> {
      yield `#EXTM3U\n#EXTINF:-1 group-title="Movies: Finland",Known - 2020\nhttps://iptv.example/movie/a/b/1.mkv\n#EXTINF:-1 group-title="Unclear",Mystery\nhttps://iptv.example/media/opaque?id=4\n`;
    }

    const summary = await importM3uChunks(playlist(), store);

    expect(summary).toMatchObject({ importedItems: 1, unknownEntries: 1 });
    store.close();
    store = await IndexedDbCatalogStore.open();
    await expect(store.metadata()).resolves.toMatchObject({ itemCount: 1, unknownCount: 1 });
    await expect(store.byGroup("Movies: Finland")).resolves.toMatchObject([
      { classification: { kind: "vod", evidence: expect.any(Array) }, classificationSource: "classifier" },
    ]);
    await expect(store.unknownEntries(1)).resolves.toMatchObject([{
      entry: { name: "Mystery", attributes: { "group-title": "Unclear" }, url: "https://iptv.example/media/opaque?id=4" },
      classification: { kind: "unknown", evidence: expect.any(Array) },
    }]);
    await expect(store.byGroup("Unclear")).resolves.toEqual([]);
    await expect(store.unknownEntries(0)).resolves.toEqual([]);
  });

  it("upgrades a version 5 catalogue with null-year records and marks reconstructed evidence", async () => {
    store?.close();
    store = undefined;
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.deleteDatabase("substream-catalog");
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
      request.onblocked = () => reject(new Error("Test database deletion was blocked"));
    });
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.open("substream-catalog", 5);
      request.onupgradeneeded = () => {
        const database = request.result;
        const items = database.createObjectStore("vod-items", { keyPath: "id" });
        items.createIndex("by-group-title", ["group", "searchTitle", "id"]);
        items.createIndex("by-group-source", ["group", "sourceLine", "id"]);
        items.createIndex("by-group-year", ["group", "year", "id"]);
        database.createObjectStore("catalog-meta", { keyPath: "key" });
        database.createObjectStore("vod-groups", { keyPath: "name" });
      };
      request.onsuccess = () => {
        const database = request.result;
        const tx = database.transaction(["vod-items", "catalog-meta"], "readwrite");
        tx.objectStore("vod-items").put({
          id: "old-null-year", title: "Old title", searchTitle: "old title", searchTerms: ["old", "title"],
          year: null, group: "Older import", contentType: "movie", addedAt: 1,
          streamUrl: "https://iptv.example/movie/a/b/9.mkv", sourceLine: 9,
        });
        tx.objectStore("vod-items").put({
          id: "old-known-year", title: "Known year", searchTitle: "known year", searchTerms: ["known", "year"],
          year: 2022, group: "Older import", contentType: "movie", addedAt: 1,
          streamUrl: "https://iptv.example/movie/a/b/8.mkv", sourceLine: 8,
        });
        tx.objectStore("catalog-meta").put({ key: "current", status: "ready", importedAt: 2, itemCount: 1, groupCount: 1 });
        tx.oncomplete = () => { database.close(); resolve(); };
        tx.onerror = () => reject(tx.error);
      };
      request.onerror = () => reject(request.error);
    });

    const openProgress: Array<{ stage: string; processedItems: number }> = [];
    store = await IndexedDbCatalogStore.open((progress) => openProgress.push(progress));
    expect(openProgress).toContainEqual({ stage: "upgrading", processedItems: 2 });
    await expect(store.byGroupPage("Older import", 0, 1, "year")).resolves.toMatchObject([
      { id: "old-known-year", year: 2022, classificationSource: "reconstructed" },
    ]);
    await expect(store.byGroupPage("Older import", 1, 10, "year")).resolves.toMatchObject([
      { id: "old-null-year", year: null, classificationSource: "reconstructed", classification: { kind: "vod", evidence: expect.arrayContaining(["Reconstructed from a saved VOD record; original classification evidence is unavailable"]) } },
    ]);
    await expect(store.metadata()).resolves.toMatchObject({ unknownCount: 0 });
  });

  it("rejects a blocked upgrade and closes its late successful connection", async () => {
    store?.close();
    store = undefined;
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.deleteDatabase("substream-catalog");
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
      request.onblocked = () => reject(new Error("Test database deletion was blocked"));
    });
    const blocker = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("substream-catalog", 5);
      request.onupgradeneeded = () => {
        const database = request.result;
        const items = database.createObjectStore("vod-items", { keyPath: "id" });
        items.createIndex("by-group-title", ["group", "searchTitle", "id"]);
        items.createIndex("by-group-source", ["group", "sourceLine", "id"]);
        items.createIndex("by-group-year", ["group", "year", "id"]);
        database.createObjectStore("catalog-meta", { keyPath: "key" });
        database.createObjectStore("vod-groups", { keyPath: "name" });
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const progress: Array<{ stage: string; processedItems: number }> = [];
    const openPromise = IndexedDbCatalogStore.open((event) => progress.push(event));

    await expect(openPromise).rejects.toBeInstanceOf(IndexedDbCatalogOpenError);
    expect(progress).toContainEqual({ stage: "blocked", processedItems: 0 });
    blocker.close();

    // Wait for the originally blocked request's late success handler to run.
    const currentVersionConnection = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("substream-catalog", 7);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    currentVersionConnection.close();
    const nextVersionConnection = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("substream-catalog", 8);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
      request.onblocked = () => reject(new Error("A late catalog connection remained open"));
    });
    nextVersionConnection.close();
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.deleteDatabase("substream-catalog");
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
      request.onblocked = () => reject(new Error("Test database cleanup was blocked"));
    });
  });
});
