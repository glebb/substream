import type { CatalogImportSummary, VodCatalogItem, VodContentType } from "../../core/catalog/index.ts";
import { normalizeTitle, searchTerms } from "../../core/catalog/index.ts";

const DATABASE_NAME = "my-m3u-catalog";
const DATABASE_VERSION = 4;
const ITEMS_STORE = "vod-items";
const META_STORE = "catalog-meta";
const GROUPS_STORE = "vod-groups";
const METADATA_KEY = "current";

export interface CatalogMetadata {
  key: "current";
  status: "empty" | "importing" | "ready" | "failed";
  importedAt: number | null;
  itemCount: number;
  groupCount: number;
}

export interface VodGroup {
  name: string;
  count: number;
  contentType: VodContentType | "mixed";
}

export type VodSort = "title" | "playlist" | "year";

export interface CatalogImportProgress {
  imported: number;
  total: number;
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB request failed"));
  });
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(transaction.error ?? new Error("IndexedDB transaction aborted"));
    transaction.onerror = () => reject(transaction.error ?? new Error("IndexedDB transaction failed"));
  });
}

export class IndexedDbCatalogStore {
  private constructor(private readonly database: IDBDatabase) {}

  static async open(): Promise<IndexedDbCatalogStore> {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    request.onupgradeneeded = (event) => {
      const database = request.result;
      const items = database.objectStoreNames.contains(ITEMS_STORE)
        ? request.transaction!.objectStore(ITEMS_STORE)
        : database.createObjectStore(ITEMS_STORE, { keyPath: "id" });
      if (!items.indexNames.contains("by-group")) items.createIndex("by-group", "group", { unique: false });
      if (!items.indexNames.contains("by-group-title")) items.createIndex("by-group-title", ["group", "searchTitle", "id"], { unique: false });
      if (!items.indexNames.contains("by-group-added")) items.createIndex("by-group-added", ["group", "addedAt", "id"], { unique: false });
      if (!items.indexNames.contains("by-group-source")) items.createIndex("by-group-source", ["group", "sourceLine", "id"], { unique: false });
      if (!items.indexNames.contains("by-group-year")) items.createIndex("by-group-year", ["group", "year", "id"], { unique: false });
      if (!items.indexNames.contains("by-content-type")) items.createIndex("by-content-type", "contentType", { unique: false });
      if (!items.indexNames.contains("by-search-term")) items.createIndex("by-search-term", "searchTerms", { multiEntry: true, unique: false });
      if (!database.objectStoreNames.contains(META_STORE)) database.createObjectStore(META_STORE, { keyPath: "key" });
      if (!database.objectStoreNames.contains(GROUPS_STORE)) database.createObjectStore(GROUPS_STORE, { keyPath: "name" });
      if (event.oldVersion < 2 && database.objectStoreNames.contains(META_STORE)) {
        const metadataRequest = request.transaction!.objectStore(META_STORE).get(METADATA_KEY);
        metadataRequest.onsuccess = () => {
          const importedAt = (metadataRequest.result as CatalogMetadata | undefined)?.importedAt ?? 0;
          const cursorRequest = items.openCursor();
          cursorRequest.onsuccess = () => {
            const cursor = cursorRequest.result;
            if (!cursor) return;
            const item = cursor.value as VodCatalogItem;
            if (!item.addedAt) cursor.update({ ...item, addedAt: importedAt });
            cursor.continue();
          };
        };
      }
      if (event.oldVersion < 4) {
        const cursorRequest = items.openCursor();
        cursorRequest.onsuccess = () => {
          const cursor = cursorRequest.result;
          if (!cursor) return;
          const item = cursor.value as VodCatalogItem;
          const normalized = normalizeTitle(item.title);
          const upgraded: VodCatalogItem = {
            ...item,
            title: normalized.title,
            searchTitle: normalized.searchTitle,
            searchTerms: searchTerms(normalized.searchTitle),
            year: normalized.year ?? item.year,
            ...(item.contentType === "series" && normalized.season !== undefined && normalized.episode !== undefined
              ? { season: normalized.season, episode: normalized.episode }
              : {}),
          };
          cursor.update(upgraded);
          cursor.continue();
        };
      }
    };
    return new IndexedDbCatalogStore(await requestResult(request));
  }

  async metadata(): Promise<CatalogMetadata> {
    const transaction = this.database.transaction(META_STORE, "readonly");
    const stored = await requestResult(transaction.objectStore(META_STORE).get(METADATA_KEY));
    await transactionDone(transaction);
    return stored ?? { key: "current", status: "empty", importedAt: null, itemCount: 0, groupCount: 0 };
  }

  async replaceAll(
    items: readonly VodCatalogItem[],
    onProgress?: (progress: CatalogImportProgress) => void,
  ): Promise<void> {
    const groups = summarizeGroups(items);
    await this.begin();

    const batchSize = 500;
    for (let offset = 0; offset < items.length; offset += batchSize) {
      await this.append(items.slice(offset, offset + batchSize));
      onProgress?.({ imported: Math.min(offset + batchSize, items.length), total: items.length });
    }
    await this.complete({ processedEntries: items.length, importedItems: items.length, groups, warnings: 0 });
  }

  async begin(): Promise<void> {
    await this.writeMetadata({ key: "current", status: "importing", importedAt: null, itemCount: 0, groupCount: 0 });
    const transaction = this.database.transaction([ITEMS_STORE, GROUPS_STORE], "readwrite");
    transaction.objectStore(ITEMS_STORE).clear();
    transaction.objectStore(GROUPS_STORE).clear();
    await transactionDone(transaction);
  }

  async append(items: readonly VodCatalogItem[]): Promise<void> {
    const transaction = this.database.transaction(ITEMS_STORE, "readwrite");
    const store = transaction.objectStore(ITEMS_STORE);
    for (const item of items) store.put(item);
    await transactionDone(transaction);
  }

  async complete(summary: CatalogImportSummary): Promise<void> {
    const transaction = this.database.transaction(GROUPS_STORE, "readwrite");
    const store = transaction.objectStore(GROUPS_STORE);
    for (const group of summary.groups) store.put(group);
    await transactionDone(transaction);
    await this.writeMetadata({
      key: "current",
      status: "ready",
      importedAt: Date.now(),
      itemCount: summary.importedItems,
      groupCount: summary.groups.length,
    });
  }

  async fail(): Promise<void> {
    const previous = await this.metadata();
    await this.writeMetadata({ ...previous, status: "failed" });
  }

  async groups(): Promise<VodGroup[]> {
    const transaction = this.database.transaction(GROUPS_STORE, "readonly");
    const groups = await requestResult(transaction.objectStore(GROUPS_STORE).getAll()) as VodGroup[];
    await transactionDone(transaction);
    return groups.sort((left, right) => right.count - left.count || left.name.localeCompare(right.name));
  }

  async byGroup(group: string, limit = 100): Promise<VodCatalogItem[]> {
    return this.byGroupPage(group, 0, limit);
  }

  async byGroupPage(group: string, offset = 0, limit = 100, sort: VodSort = "title"): Promise<VodCatalogItem[]> {
    const transaction = this.database.transaction(ITEMS_STORE, "readonly");
    const items: VodCatalogItem[] = [];
    const indexName = sort === "title" ? "by-group-title" : sort === "playlist" ? "by-group-source" : "by-group-year";
    const range = sort === "title"
      ? IDBKeyRange.bound([group, "", ""], [group, "\uffff", "\uffff"])
      : sort === "playlist"
        ? IDBKeyRange.bound([group, 0, ""], [group, Number.MAX_SAFE_INTEGER, "\uffff"])
        : IDBKeyRange.bound([group, 0, ""], [group, 9999, "\uffff"]);
    const request = transaction.objectStore(ITEMS_STORE).index(indexName).openCursor(range, sort === "year" ? "prev" : "next");
    let seen = 0;
    await new Promise<void>((resolve, reject) => {
      request.onerror = () => reject(request.error ?? new Error("IndexedDB group query failed"));
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor || items.length >= limit) return resolve();
        if (seen >= offset) items.push(cursor.value as VodCatalogItem);
        seen += 1;
        cursor.continue();
      };
    });
    await transactionDone(transaction);
    return items;
  }

  async search(query: string, limit = 50): Promise<VodCatalogItem[]> {
    const terms = query.normalize("NFKD").replace(/\p{Diacritic}/gu, "").toLocaleLowerCase()
      .split(/[^\p{L}\p{N}]+/u).filter((term) => term.length >= 2);
    if (terms.length === 0) return [];

    const transaction = this.database.transaction(ITEMS_STORE, "readonly");
    const index = transaction.objectStore(ITEMS_STORE).index("by-search-term");
    const results = new Map<string, VodCatalogItem>();
    const range = IDBKeyRange.bound(terms[0] ?? "", `${terms[0]}\uffff`, false, false);
    const request = index.openCursor(range);

    await new Promise<void>((resolve, reject) => {
      request.onerror = () => reject(request.error ?? new Error("IndexedDB search failed"));
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor || results.size >= limit * 3) return resolve();
        const item = cursor.value as VodCatalogItem;
        if (terms.every((term) => item.searchTerms.some((candidate) => candidate.startsWith(term)))) {
          results.set(item.id, item);
        }
        cursor.continue();
      };
    });
    await transactionDone(transaction);
    return [...results.values()].sort((left, right) => left.title.localeCompare(right.title)).slice(0, limit);
  }

  close(): void {
    this.database.close();
  }

  private async writeMetadata(metadata: CatalogMetadata): Promise<void> {
    const transaction = this.database.transaction(META_STORE, "readwrite");
    transaction.objectStore(META_STORE).put(metadata);
    await transactionDone(transaction);
  }
}

function summarizeGroups(items: readonly VodCatalogItem[]): VodGroup[] {
  const groups = new Map<string, { count: number; contentTypes: Set<VodContentType> }>();
  for (const item of items) {
    const group = groups.get(item.group) ?? { count: 0, contentTypes: new Set<VodContentType>() };
    group.count += 1;
    group.contentTypes.add(item.contentType);
    groups.set(item.group, group);
  }
  return [...groups.entries()].map(([name, group]) => ({
    name,
    count: group.count,
    contentType: group.contentTypes.size === 1 ? [...group.contentTypes][0] ?? "mixed" : "mixed",
  }));
}
