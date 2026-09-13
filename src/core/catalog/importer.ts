import { IncrementalM3uParser } from "../m3u/index.ts";
import type { M3uEntry } from "../m3u/types.ts";
import { createUnknownCatalogEntry, createVodCatalogItem } from "./catalog.ts";
import type { UnknownCatalogEntry, VodCatalogItem, VodContentType } from "./types.ts";

export interface CatalogImportGroup {
  name: string;
  count: number;
  contentType: VodContentType | "mixed";
}

export interface CatalogImportSummary {
  processedEntries: number;
  importedItems: number;
  unknownEntries: number;
  groups: CatalogImportGroup[];
  warnings: number;
}

export interface CatalogImportSink {
  begin(): Promise<void>;
  append(items: readonly VodCatalogItem[], unknownEntries?: readonly UnknownCatalogEntry[]): Promise<void>;
  complete(summary: CatalogImportSummary): Promise<void>;
  fail?(): Promise<void>;
}

export interface CatalogImportOptions {
  batchSize?: number;
  progressInterval?: number;
  onProgress?: (progress: Pick<CatalogImportSummary, "processedEntries" | "importedItems">) => void;
}

export async function importM3uChunks(
  chunks: AsyncIterable<string>,
  sink: CatalogImportSink,
  options: CatalogImportOptions = {},
): Promise<CatalogImportSummary> {
  const parser = new IncrementalM3uParser();
  const batchSize = Math.max(1, options.batchSize ?? 500);
  const progressInterval = Math.max(1, options.progressInterval ?? 5_000);
  const batch: VodCatalogItem[] = [];
  const unknownBatch: UnknownCatalogEntry[] = [];
  const groups = new Map<string, { count: number; contentTypes: Set<VodContentType> }>();
  let processedEntries = 0;
  let importedItems = 0;
  let unknownEntries = 0;
  const importStartedAt = Date.now();

  const flush = async () => {
    if (batch.length === 0 && unknownBatch.length === 0) return;
    const items = batch.splice(0, batch.length);
    const unknowns = unknownBatch.splice(0, unknownBatch.length);
    await sink.append(items, unknowns);
    importedItems += items.length;
    unknownEntries += unknowns.length;
    options.onProgress?.({ processedEntries, importedItems });
  };
  const addEntries = async (entries: readonly M3uEntry[]) => {
    for (const entry of entries) {
      processedEntries += 1;
      const item = createVodCatalogItem(entry, importStartedAt);
      if (!item) {
        const unknown = createUnknownCatalogEntry(entry, importStartedAt);
        if (unknown) unknownBatch.push(unknown);
        if (batch.length + unknownBatch.length >= batchSize) await flush();
        if (processedEntries % progressInterval === 0) options.onProgress?.({ processedEntries, importedItems });
        continue;
      }
      batch.push(item);
      const group = groups.get(item.group) ?? { count: 0, contentTypes: new Set<VodContentType>() };
      group.count += 1;
      group.contentTypes.add(item.contentType);
      groups.set(item.group, group);
      if (batch.length + unknownBatch.length >= batchSize) await flush();
      else if (processedEntries % progressInterval === 0) options.onProgress?.({ processedEntries, importedItems });
    }
  };

  await sink.begin();
  try {
    for await (const chunk of chunks) await addEntries(parser.push(chunk));
    await addEntries(parser.finish());
    await flush();
    const summary: CatalogImportSummary = {
      processedEntries,
      importedItems,
      unknownEntries,
      groups: [...groups.entries()].map(([name, group]) => ({
        name,
        count: group.count,
        contentType: group.contentTypes.size === 1 ? [...group.contentTypes][0] ?? "mixed" : "mixed",
      })),
      warnings: parser.warnings.length,
    };
    await sink.complete(summary);
    return summary;
  } catch (error) {
    await sink.fail?.();
    throw error;
  }
}
