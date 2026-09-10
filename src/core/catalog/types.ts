export type VodContentType = "movie" | "series" | "other";

export interface VodCatalogItem {
  id: string;
  title: string;
  searchTitle: string;
  searchTerms: string[];
  year: number | null;
  season?: number;
  episode?: number;
  group: string;
  contentType: VodContentType;
  addedAt: number;
  streamUrl: string;
  sourceLine: number;
}

export interface VodCatalog {
  items: VodCatalogItem[];
  groupCounts: ReadonlyMap<string, number>;
  contentTypeCounts: ReadonlyMap<VodContentType, number>;
}

export interface VodSearchOptions {
  group?: string;
  contentType?: VodContentType;
  limit?: number;
}
