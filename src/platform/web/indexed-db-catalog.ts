import { classifyM3uEntry } from "../../core/m3u/classifier.ts";
import type { M3uEntry } from "../../core/m3u/types.ts";
import type { CatalogImportSummary, UnknownCatalogEntry, VodCatalogItem, VodContentType } from "../../core/catalog/index.ts";
import { normalizeTitle, searchTerms } from "../../core/catalog/index.ts";

const DATABASE_NAME = "my-m3u-catalog";
const DATABASE_VERSION = 7;
const LEGACY_ITEMS_STORE = "vod-items";
const LEGACY_UNKNOWN_STORE = "unknown-entries";
const LEGACY_GROUPS_STORE = "vod-groups";
const ITEMS_STORE = "vod-items-v7";
const UNKNOWN_STORE = "unknown-entries-v7";
const META_STORE = "catalog-meta";
const GROUPS_STORE = "vod-groups-v7";
const METADATA_KEY = "current";

export interface CatalogMetadata {
  key: "current";
  status: "empty" | "importing" | "ready" | "failed";
  importedAt: number | null;
  itemCount: number;
  groupCount: number;
  unknownCount: number;
  activeGeneration?: number;
  pendingGeneration?: number;
}

export interface VodGroup {
  id: string;
  name: string;
  count: number;
  contentType: VodContentType | "mixed";
  providerCategoryId?: string;
  providerContentType?: "movie" | "series";
}

export type VodSort = "title" | "playlist" | "year";

export interface CatalogImportProgress {
  imported: number;
  total: number;
}

export interface IndexedDbCatalogOpenProgress {
  stage: "opening" | "upgrading" | "blocked";
  processedItems: number;
}

export class IndexedDbCatalogOpenError extends Error {
  readonly kind = "blocked";

  constructor() {
    super("Catalog upgrade is blocked by another open app tab. Close other app tabs and reload.");
    this.name = "IndexedDbCatalogOpenError";
  }
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
  private pendingGeneration: number | undefined;

  private constructor(private readonly database: IDBDatabase) {}

  static async open(onProgress?: (progress: IndexedDbCatalogOpenProgress) => void): Promise<IndexedDbCatalogStore> {
    const report = (progress: IndexedDbCatalogOpenProgress) => {
      try {
        onProgress?.(progress);
      } catch {
        // A UI observer must not fail a database open or migration.
      }
    };
    report({ stage: "opening", processedItems: 0 });
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    return new Promise<IndexedDbCatalogStore>((resolve, reject) => {
      let settled = false;
      request.onupgradeneeded = (event) => {
        const database = request.result;
        const transaction = request.transaction!;
        const oldItems = database.objectStoreNames.contains(LEGACY_ITEMS_STORE)
          ? transaction.objectStore(LEGACY_ITEMS_STORE)
          : undefined;
        const oldUnknown = database.objectStoreNames.contains(LEGACY_UNKNOWN_STORE)
          ? transaction.objectStore(LEGACY_UNKNOWN_STORE)
          : undefined;
        const oldGroups = database.objectStoreNames.contains(LEGACY_GROUPS_STORE)
          ? transaction.objectStore(LEGACY_GROUPS_STORE)
          : undefined;

        if (!database.objectStoreNames.contains(META_STORE)) database.createObjectStore(META_STORE, { keyPath: "key" });
        if (!database.objectStoreNames.contains(ITEMS_STORE)) {
          database.createObjectStore(ITEMS_STORE, { keyPath: ["generation", "id"] });
        }
        const items = database.objectStoreNames.contains(ITEMS_STORE)
          ? request.transaction!.objectStore(ITEMS_STORE)
          : transaction.objectStore(ITEMS_STORE);
        for (const indexName of [...items.indexNames]) items.deleteIndex(indexName);
        // The active-generation prefix lets imports stage a full replacement while
        // indexed browsing continues to read the last completed generation.
        items.createIndex("by-group-title", ["generation", "group", "searchTitle", "id"], { unique: false });
        items.createIndex("by-group-source", ["generation", "group", "sourceLine", "id"], { unique: false });
        items.createIndex("by-group-year-sort", ["generation", "group", "yearSortKey", "searchTitle", "id"], { unique: false });
        items.createIndex("by-search-title", ["generation", "searchTitle", "id"], { unique: false });
        items.createIndex("by-generation", "generation", { unique: false });
        if (!database.objectStoreNames.contains(GROUPS_STORE)) {
          const groups = database.createObjectStore(GROUPS_STORE, { keyPath: ["generation", "id"] });
          groups.createIndex("by-generation", "generation", { unique: false });
        }
        if (!database.objectStoreNames.contains(UNKNOWN_STORE)) {
          const unknown = database.createObjectStore(UNKNOWN_STORE, { keyPath: ["generation", "id"] });
          unknown.createIndex("by-generation", "generation", { unique: false });
        }

        if (event.oldVersion < 7) {
          report({ stage: "upgrading", processedItems: 0 });
          let processedItems = 0;
          let pendingMigrations = 0;
          const finishMigrationPart = () => {
            pendingMigrations -= 1;
            if (pendingMigrations !== 0) return;
            for (const legacyStore of [LEGACY_ITEMS_STORE, LEGACY_GROUPS_STORE, LEGACY_UNKNOWN_STORE]) {
              if (database.objectStoreNames.contains(legacyStore)) database.deleteObjectStore(legacyStore);
            }
            const metadataStore = transaction.objectStore(META_STORE);
            const metadataRequest = metadataStore.get(METADATA_KEY);
            metadataRequest.onsuccess = () => {
              const metadata = metadataRequest.result as CatalogMetadata | undefined;
              const migrated = {
                ...(metadata ?? { key: METADATA_KEY, status: "empty", importedAt: null, itemCount: 0, groupCount: 0, unknownCount: 0 }),
              } as CatalogMetadata;
              if (metadata?.status === "ready") migrated.activeGeneration = 0;
              else delete migrated.activeGeneration;
              delete migrated.pendingGeneration;
              metadataStore.put(migrated);
              report({ stage: "upgrading", processedItems });
            };
          };

          if (oldItems) {
            pendingMigrations += 1;
            const targetItems = transaction.objectStore(ITEMS_STORE);
            const metadataRequest = transaction.objectStore(META_STORE).get(METADATA_KEY);
            metadataRequest.onsuccess = () => {
              const importedAt = (metadataRequest.result as CatalogMetadata | undefined)?.importedAt ?? 0;
              const cursorRequest = oldItems.openCursor();
              cursorRequest.onsuccess = () => {
                const cursor = cursorRequest.result;
                if (!cursor) {
                  finishMigrationPart();
                  return;
                }
                const item = cursor.value as VodCatalogItem & { yearSortKey?: number };
                const normalized = event.oldVersion < 4 ? normalizeTitle(item.title) : null;
                const title = normalized?.title ?? item.title;
                const searchTitle = normalized?.searchTitle ?? item.searchTitle;
                const entry: M3uEntry = {
                  name: title,
                  url: item.streamUrl,
                  duration: null,
                  attributes: { "group-title": item.group },
                  options: {},
                  line: item.sourceLine,
                };
                const reconstructed = classifyM3uEntry(entry);
                targetItems.put({
                  ...item,
                  generation: 0,
                  ...(event.oldVersion < 2 && !item.addedAt ? { addedAt: importedAt } : {}),
                  title,
                  searchTitle,
                  ...(normalized ? {
                    searchTerms: searchTerms(normalized.searchTitle),
                    year: normalized.year ?? item.year,
                    ...(item.contentType === "series" && normalized.season !== undefined && normalized.episode !== undefined
                      ? { season: normalized.season, episode: normalized.episode }
                      : {}),
                  } : {}),
                  yearSortKey: (normalized?.year ?? item.year) ?? 0,
                  classification: item.classification ?? {
                    kind: "vod",
                    confidence: "low",
                    evidence: [
                      "Reconstructed from a saved VOD record; original classification evidence is unavailable",
                      ...reconstructed.evidence,
                    ],
                  },
                  classificationSource: item.classificationSource ?? "reconstructed",
                });
                processedItems += 1;
                if (processedItems % 500 === 0) report({ stage: "upgrading", processedItems });
                cursor.continue();
              };
            };
          }

          if (oldGroups) {
            pendingMigrations += 1;
            const targetGroups = transaction.objectStore(GROUPS_STORE);
            const groupsRequest = oldGroups.getAll();
            groupsRequest.onsuccess = () => {
              for (const group of groupsRequest.result as Array<VodGroup & { id?: string }>) {
                const id = group.id ?? (group.providerCategoryId && group.providerContentType
                  ? "provider:" + group.providerContentType + ":" + group.providerCategoryId
                  : "local:" + group.name);
                targetGroups.put({ ...group, id, generation: 0 });
              }
              finishMigrationPart();
            };
          }

          if (oldUnknown) {
            pendingMigrations += 1;
            const targetUnknown = transaction.objectStore(UNKNOWN_STORE);
            const unknownCursor = oldUnknown.openCursor();
            unknownCursor.onsuccess = () => {
              const cursor = unknownCursor.result;
              if (!cursor) {
                finishMigrationPart();
                return;
              }
              targetUnknown.put({ ...(cursor.value as UnknownCatalogEntry), generation: 0 });
              cursor.continue();
            };
          }

          if (pendingMigrations === 0) {
            // A new database has no legacy stores to copy.
            pendingMigrations = 1;
            finishMigrationPart();
          }
        }
      };
      request.onblocked = () => {
        report({ stage: "blocked", processedItems: 0 });
        if (settled) return;
        settled = true;
        reject(new IndexedDbCatalogOpenError());
      };
      request.onerror = () => {
        if (settled) return;
        settled = true;
        reject(request.error ?? new Error("IndexedDB open failed"));
      };
      request.onsuccess = () => {
        const database = request.result;
        if (settled) {
          database.close();
          return;
        }
        database.onversionchange = () => database.close();
        settled = true;
        resolve(new IndexedDbCatalogStore(database));
      };
    });
  }

  async metadata(): Promise<CatalogMetadata> {
    const transaction = this.database.transaction(META_STORE, "readonly");
    const stored = await requestResult(transaction.objectStore(META_STORE).get(METADATA_KEY));
    await transactionDone(transaction);
    return stored
      ? { ...stored, unknownCount: stored.unknownCount ?? 0 }
      : { key: "current", status: "empty", importedAt: null, itemCount: 0, groupCount: 0, unknownCount: 0 };
  }

  async replaceAll(
    items: readonly VodCatalogItem[],
    onProgress?: (progress: CatalogImportProgress) => void,
  ): Promise<void> {
    const groups = summarizeGroups(items);
    try {
      await this.begin();
      const batchSize = 500;
      for (let offset = 0; offset < items.length; offset += batchSize) {
        await this.append(items.slice(offset, offset + batchSize));
        onProgress?.({ imported: Math.min(offset + batchSize, items.length), total: items.length });
      }
      await this.complete({ processedEntries: items.length, importedItems: items.length, unknownEntries: 0, groups, warnings: 0 });
    } catch (error) {
      try {
        await this.fail();
      } catch {
        // Preserve the original replacement failure if rollback also fails.
      }
      throw error;
    }
  }

  async begin(): Promise<void> {
    const previous = await this.metadata();
    const generation = previous.pendingGeneration ?? ((previous.activeGeneration ?? -1) + 1);
    await Promise.all([ITEMS_STORE, GROUPS_STORE, UNKNOWN_STORE].map((storeName) => this.deleteGeneration(storeName, generation)));
    this.pendingGeneration = generation;
    const pending: CatalogMetadata = {
      ...previous,
      status: previous.activeGeneration === undefined ? "importing" : "ready",
      pendingGeneration: generation,
    };
    await this.writeMetadata(pending);
  }

  async append(items: readonly VodCatalogItem[], unknownEntries: readonly UnknownCatalogEntry[] = []): Promise<void> {
    const stores = [...(items.length > 0 ? [ITEMS_STORE] : []), ...(unknownEntries.length > 0 ? [UNKNOWN_STORE] : [])];
    if (stores.length === 0) return;
    const generation = this.pendingGeneration;
    if (generation === undefined) throw new Error("Catalog import has not been started");
    const transaction = this.database.transaction(stores, "readwrite");
    const store = items.length > 0 ? transaction.objectStore(ITEMS_STORE) : undefined;
    for (const item of items) store!.put({ ...item, generation, yearSortKey: item.year ?? 0 });
    if (unknownEntries.length > 0) {
      const unknownStore = transaction.objectStore(UNKNOWN_STORE);
      for (const item of unknownEntries) unknownStore.put({ ...item, generation });
    }
    await transactionDone(transaction);
  }

  async complete(summary: CatalogImportSummary): Promise<void> {
    const generation = this.pendingGeneration;
    if (generation === undefined) throw new Error("Catalog import has not been started");
    const transaction = this.database.transaction(GROUPS_STORE, "readwrite");
    const store = transaction.objectStore(GROUPS_STORE);
    for (const group of summary.groups) store.put({ ...group, id: "local:" + group.name, generation });
    await transactionDone(transaction);
    const metadata: CatalogMetadata = {
      ...(await this.metadata()),
      status: "ready",
      importedAt: Date.now(),
      itemCount: summary.importedItems,
      groupCount: summary.groups.length,
      unknownCount: summary.unknownEntries,
      activeGeneration: generation,
    };
    delete metadata.pendingGeneration;
    await this.writeMetadata(metadata);
    this.pendingGeneration = undefined;
  }

  async replaceProviderGroups(groups: readonly VodGroup[]): Promise<void> {
    await this.begin();
    const generation = this.pendingGeneration!;
    const transaction = this.database.transaction(GROUPS_STORE, "readwrite");
    const store = transaction.objectStore(GROUPS_STORE);
    for (const group of groups) store.put({
      ...group,
      id: group.providerCategoryId && group.providerContentType
        ? "provider:" + group.providerContentType + ":" + group.providerCategoryId
        : group.id,
      generation,
    });
    await transactionDone(transaction);
    const metadata: CatalogMetadata = {
      ...(await this.metadata()),
      status: "ready",
      importedAt: Date.now(),
      itemCount: 0,
      groupCount: groups.length,
      unknownCount: 0,
      activeGeneration: generation,
    };
    delete metadata.pendingGeneration;
    await this.writeMetadata(metadata);
    this.pendingGeneration = undefined;
  }

  async fail(): Promise<void> {
    const previous = await this.metadata();
    const generation = this.pendingGeneration ?? previous.pendingGeneration;
    if (generation !== undefined) {
      await Promise.all([ITEMS_STORE, GROUPS_STORE, UNKNOWN_STORE].map((storeName) => this.deleteGeneration(storeName, generation)));
    }
    const failed: CatalogMetadata = {
      ...previous,
      status: previous.activeGeneration === undefined ? "failed" : "ready",
    };
    delete failed.pendingGeneration;
    await this.writeMetadata(failed);
    this.pendingGeneration = undefined;
  }

  async groups(): Promise<VodGroup[]> {
    const generation = await this.activeGeneration();
    const transaction = this.database.transaction(GROUPS_STORE, "readonly");
    const groups = (await requestResult(transaction.objectStore(GROUPS_STORE).getAll()) as Array<VodGroup & { generation: number }>)
      .filter((group) => group.generation === generation);
    await transactionDone(transaction);
    return groups.sort((left, right) => right.count - left.count || left.name.localeCompare(right.name));
  }

  async unknownEntries(limit = 100): Promise<UnknownCatalogEntry[]> {
    const boundedLimit = Number.isSafeInteger(limit) && limit > 0 ? Math.min(limit, 1_000) : 0;
    if (boundedLimit === 0) return [];
    const generation = await this.activeGeneration();
    const transaction = this.database.transaction(UNKNOWN_STORE, "readonly");
    const results: UnknownCatalogEntry[] = [];
    const request = transaction.objectStore(UNKNOWN_STORE).index("by-generation").openCursor(IDBKeyRange.only(generation));
    await new Promise<void>((resolve, reject) => {
      request.onerror = () => reject(request.error ?? new Error("IndexedDB unknown-entry query failed"));
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor || results.length >= boundedLimit) return resolve();
        results.push(cursor.value as UnknownCatalogEntry);
        cursor.continue();
      };
    });
    await transactionDone(transaction);
    return results;
  }

  async byGroup(group: string, limit = 100): Promise<VodCatalogItem[]> {
    return this.byGroupPage(group, 0, limit);
  }

  async byIds(ids: readonly string[]): Promise<VodCatalogItem[]> {
    const uniqueIds = [...new Set(ids)].filter((id) => typeof id === "string" && id.length > 0 && id.length <= 256);
    if (uniqueIds.length === 0) return [];
    const generation = await this.activeGeneration();
    const transaction = this.database.transaction(ITEMS_STORE, "readonly");
    const items = transaction.objectStore(ITEMS_STORE);
    const results = await Promise.all(uniqueIds.map((id) => requestResult(items.get([generation, id]))));
    await transactionDone(transaction);
    return results.filter((item): item is VodCatalogItem => item !== undefined) as VodCatalogItem[];
  }

  async clearCatalog(): Promise<void> {
    const transaction = this.database.transaction([ITEMS_STORE, GROUPS_STORE, UNKNOWN_STORE, META_STORE], "readwrite");
    transaction.objectStore(ITEMS_STORE).clear();
    transaction.objectStore(GROUPS_STORE).clear();
    transaction.objectStore(UNKNOWN_STORE).clear();
    transaction.objectStore(META_STORE).put({
      key: METADATA_KEY,
      status: "empty",
      importedAt: null,
      itemCount: 0,
      groupCount: 0,
      unknownCount: 0,
    } satisfies CatalogMetadata);
    await transactionDone(transaction);
    this.pendingGeneration = undefined;
  }

  async byGroupPage(group: string, offset = 0, limit = 100, sort: VodSort = "title"): Promise<VodCatalogItem[]> {
    const generation = await this.activeGeneration();
    const transaction = this.database.transaction(ITEMS_STORE, "readonly");
    const items: VodCatalogItem[] = [];
    const indexName = sort === "title" ? "by-group-title" : sort === "playlist" ? "by-group-source" : "by-group-year-sort";
    const range = sort === "title"
      ? IDBKeyRange.bound([generation, group, "", ""], [generation, group, "\uffff", "\uffff"])
      : sort === "playlist"
        ? IDBKeyRange.bound([generation, group, 0, ""], [generation, group, Number.MAX_SAFE_INTEGER, "\uffff"])
        : IDBKeyRange.bound([generation, group, 0, "", ""], [generation, group, 9999, "\uffff", "\uffff"]);
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
    const resultLimit = Number.isSafeInteger(limit) && limit > 0 ? Math.min(limit, 1_000) : 0;
    if (resultLimit === 0) return [];
    const terms = query.normalize("NFKD").replace(/\p{Diacritic}/gu, "").toLocaleLowerCase()
      .split(/[^\p{L}\p{N}]+/u).filter((term) => term.length >= 2);
    if (terms.length === 0) return [];

    const generation = await this.activeGeneration();
    const transaction = this.database.transaction(ITEMS_STORE, "readonly");
    const results: VodCatalogItem[] = [];
    const request = transaction.objectStore(ITEMS_STORE).index("by-search-title")
      .openCursor(IDBKeyRange.bound([generation, "", ""], [generation, "\uffff", "\uffff"]));

    await new Promise<void>((resolve, reject) => {
      request.onerror = () => reject(request.error ?? new Error("IndexedDB search failed"));
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor || results.length >= resultLimit) return resolve();
        const item = cursor.value as VodCatalogItem;
        if (terms.every((term) => item.searchTerms.some((candidate) => candidate.startsWith(term)))) {
          results.push(item);
        }
        cursor.continue();
      };
    });
    await transactionDone(transaction);
    // Results are the first `limit` matches in global normalized-title order;
    // the index keeps memory bounded without truncating before sorting.
    return results;
  }

  close(): void {
    this.database.close();
  }

  private async writeMetadata(metadata: CatalogMetadata): Promise<void> {
    const transaction = this.database.transaction(META_STORE, "readwrite");
    transaction.objectStore(META_STORE).put(metadata);
    await transactionDone(transaction);
  }

  private async activeGeneration(): Promise<number> {
    return (await this.metadata()).activeGeneration ?? 0;
  }

  private async deleteGeneration(storeName: string, generation: number): Promise<void> {
    const transaction = this.database.transaction(storeName, "readwrite");
    const request = transaction.objectStore(storeName).index("by-generation").openCursor(IDBKeyRange.only(generation));
    await new Promise<void>((resolve, reject) => {
      request.onerror = () => reject(request.error ?? new Error("IndexedDB generation cleanup failed"));
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) return resolve();
        cursor.delete();
        cursor.continue();
      };
    });
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
    id: "local:" + name,
    name,
    count: group.count,
    contentType: group.contentTypes.size === 1 ? [...group.contentTypes][0] ?? "mixed" : "mixed",
  }));
}
