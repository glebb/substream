import { IncrementalM3uParser } from "../m3u/index.ts";
import type { M3uEntry } from "../m3u/types.ts";
import { createVodCatalogItem } from "./catalog.ts";
import type { VodCatalogItem, VodContentType } from "./types.ts";

export interface CatalogImportGroup {
  name: string;
  count: number;
  contentType: VodContentType | "mixed";
}

export interface CatalogImportSummary {
  processedEntries: number;
  importedItems: number;
  groups: CatalogImportGroup[];
  warnings: number;
}

export interface CatalogImportSink {
  begin(): Promise<void>;
  append(items: readonly VodCatalogItem[]): Promise<void>;
  complete(summary: CatalogImportSummary): Promise<void>;
  fail?(): Promise<void>;
}

export interface CatalogImportOptions {
  batchSize?: number;
  onProgress?: (progress: Pick<CatalogImportSummary, "processedEntries" | "importedItems">) => void;
}

export async function importM3uChunks(
  chunks: AsyncIterable<string>,
  sink: CatalogImportSink,
  options: CatalogImportOptions = {},
): Promise<CatalogImportSummary> {
  const parser = new IncrementalM3uParser();
  const batchSize = Math.max(1, options.batchSize ?? 500);
  const batch: VodCatalogItem[] = [];
  const groups = new Map<string, { count: number; contentTypes: Set<VodContentType> }>();
  let processedEntries = 0;
  let importedItems = 0;
  const importStartedAt = Date.now();

  const flush = async () => {
    if (batch.length === 0) return;
    const items = batch.splice(0, batch.length);
    await sink.append(items);
    importedItems += items.length;
    options.onProgress?.({ processedEntries, importedItems });
  };
  const addEntries = async (entries: readonly M3uEntry[]) => {
    for (const entry of entries) {
      processedEntries += 1;
      const item = createVodCatalogItem(entry, importStartedAt);
      if (!item) continue;
      batch.push(item);
      const group = groups.get(item.group) ?? { count: 0, contentTypes: new Set<VodContentType>() };
      group.count += 1;
      group.contentTypes.add(item.contentType);
      groups.set(item.group, group);
      if (batch.length >= batchSize) await flush();
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
