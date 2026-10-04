import type { CatalogImportSummary, UnknownCatalogEntry, VodCatalogItem, VodContentType } from "../core/catalog/index.ts";

export type CatalogMetadata = {
  key: "current";
  status: "empty" | "importing" | "ready" | "failed";
  importedAt: number | null;
  itemCount: number;
  groupCount: number;
  unknownCount: number;
  activeGeneration?: number;
  pendingGeneration?: number;
};

export type VodGroup = {
  id: string;
  name: string;
  count: number;
  contentType: VodContentType | "mixed";
  providerCategoryId?: string;
  providerContentType?: "movie" | "series";
};
export type VodSort = "title" | "playlist" | "year";

/** Durable device-owned catalogue. Implementations preserve unknown entries and import generations. */
export interface AppCatalogueRepository {
  open(onProgress?: (progress: { stage: "opening" | "upgrading" | "blocked"; processedItems: number }) => void): Promise<void>;
  metadata(): Promise<CatalogMetadata>;
  groups(): Promise<VodGroup[]>;
  unknownEntries(limit?: number): Promise<UnknownCatalogEntry[]>;
  byGroup(group: string, limit?: number): Promise<VodCatalogItem[]>;
  byGroupPage(group: string, offset?: number, limit?: number, sort?: VodSort): Promise<VodCatalogItem[]>;
  byIds(ids: readonly string[]): Promise<VodCatalogItem[]>;
  search(query: string, limit?: number): Promise<VodCatalogItem[]>;
  begin(): Promise<void>;
  append(items: readonly VodCatalogItem[], unknownEntries?: readonly UnknownCatalogEntry[]): Promise<void>;
  complete(summary: CatalogImportSummary): Promise<void>;
  replaceAll(items: readonly VodCatalogItem[], onProgress?: (progress: { imported: number; total: number }) => void): Promise<void>;
  replaceProviderGroups(groups: readonly VodGroup[]): Promise<void>;
  fail(): Promise<void>;
  clearCatalog(): Promise<void>;
  close(): void;
}

/** Opens independent catalogue sessions so one screen can close without disrupting another. */
export interface CatalogueRepositoryFactory {
  open(onProgress?: (progress: { stage: "opening" | "upgrading" | "blocked"; processedItems: number }) => void): Promise<AppCatalogueRepository>;
}

/** Optional key-value persistence used for user preferences and migration-compatible settings. */
export interface PreferencesRepository {
  get(key: string): string | null;
  set(key: string, value: string): void;
  remove(key: string): void;
}

/** Platform transport port shared by provider and metadata integrations. */
export type RuntimeFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
export interface TransportRepository { fetch: RuntimeFetch }
