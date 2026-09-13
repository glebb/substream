import type { M3uEntry, MediaClassification } from "../m3u/types.ts";

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
  /** Present for M3U imports. Provider API records may not have classifier evidence. */
  classification?: MediaClassification;
  /** Legacy catalogue rows are marked reconstructed during upgrade. */
  classificationSource?: "classifier" | "reconstructed";
  /** Present only for an Xtream series container; episodes are fetched lazily. */
  providerSeriesId?: number;
}

/** Entries retained for diagnosis or future reclassification, never shown as VOD. */
export interface UnknownCatalogEntry {
  id: string;
  entry: M3uEntry;
  classification: MediaClassification;
  addedAt: number;
}

export interface VodCatalog {
  items: VodCatalogItem[];
  unknownEntries: UnknownCatalogEntry[];
  groupCounts: ReadonlyMap<string, number>;
  contentTypeCounts: ReadonlyMap<VodContentType, number>;
}

export interface VodSearchOptions {
  group?: string;
  contentType?: VodContentType;
  limit?: number;
}
