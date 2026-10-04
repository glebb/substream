import type { AppCatalogueRepository, CatalogueRepositoryFactory } from "../../contracts/repository.ts";
import { IndexedDbCatalogStore, type IndexedDbCatalogOpenProgress } from "./indexed-db-catalog.ts";

/** Runtime factory: each call owns a distinct IndexedDB connection and close lease. */
export function createIndexedDbCatalogRepositoryFactory(): CatalogueRepositoryFactory {
  return {
    async open(onProgress) {
      const repository = createIndexedDbCatalogRepository();
      try {
        await repository.open(onProgress);
        return repository;
      } catch (error) {
        repository.close();
        throw error;
      }
    },
  };
}

/** Lazy, reusable application port over the existing versioned IndexedDB store. */
export function createIndexedDbCatalogRepository(): AppCatalogueRepository {
  let store: IndexedDbCatalogStore | null = null;
  let opening: Promise<IndexedDbCatalogStore> | null = null;
  let generation = 0;
  const getStore = async (onProgress?: (progress: IndexedDbCatalogOpenProgress) => void) => {
    if (store) return store;
    if (!opening) {
      const requestGeneration = generation;
      const task = IndexedDbCatalogStore.open(onProgress).then((opened) => {
        if (requestGeneration !== generation) {
          opened.close();
          throw new Error("Catalogue opening was cancelled.");
        }
        store = opened;
        return opened;
      }).finally(() => { if (opening === task) opening = null; });
      opening = task;
    }
    return opening;
  };
  return {
    async open(onProgress) { await getStore(onProgress); },
    async metadata() { return (await getStore()).metadata(); },
    async groups() { return (await getStore()).groups(); },
    async unknownEntries(limit) { return (await getStore()).unknownEntries(limit); },
    async byGroup(group, limit) { return (await getStore()).byGroup(group, limit); },
    async byGroupPage(group, offset, limit, sort) { return (await getStore()).byGroupPage(group, offset, limit, sort); },
    async byIds(ids) { return (await getStore()).byIds(ids); },
    async search(query, limit) { return (await getStore()).search(query, limit); },
    async begin() { await (await getStore()).begin(); },
    async append(items, unknownEntries) { await (await getStore()).append(items, unknownEntries); },
    async complete(summary) { await (await getStore()).complete(summary); },
    async replaceAll(items, onProgress) { await (await getStore()).replaceAll(items, onProgress); },
    async replaceProviderGroups(groups) { await (await getStore()).replaceProviderGroups(groups); },
    async fail() { await (await getStore()).fail(); },
    async clearCatalog() { await (await getStore()).clearCatalog(); },
    close() { generation += 1; store?.close(); store = null; opening = null; },
  };
}
