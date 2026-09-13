import { classifyM3uEntry } from "../m3u/classifier.ts";
import type { M3uEntry } from "../m3u/types.ts";
import { normalizeTitle, searchTerms, stableId } from "./normalize.ts";
import type { UnknownCatalogEntry, VodCatalog, VodCatalogItem, VodContentType, VodSearchOptions } from "./types.ts";

function contentTypeFor(entry: M3uEntry): VodContentType {
  const group = entry.attributes["group-title"] ?? "";
  let pathname = entry.url;

  try {
    pathname = new URL(entry.url).pathname;
  } catch {
    // The parser retains malformed URLs for later UI diagnostics.
  }

  if (/(?:^|\/)series(?:\/|$)/i.test(pathname) || /^series\s*:/i.test(group)) return "series";
  if (/(?:^|\/)movie(?:\/|$)/i.test(pathname) || /^movies?\s*:/i.test(group)) return "movie";
  return "other";
}

export function createVodCatalogItem(entry: M3uEntry, addedAt = Date.now()): VodCatalogItem | null {
  const classification = classifyM3uEntry(entry);
  if (classification.kind !== "vod") return null;
  const normalized = normalizeTitle(entry.name);
  const group = entry.attributes["group-title"]?.trim() || "Ungrouped";
  const contentType = contentTypeFor(entry);
  return {
    id: stableId(`${entry.url}\u0000${entry.line}`),
    title: normalized.title,
    searchTitle: normalized.searchTitle,
    searchTerms: searchTerms(normalized.searchTitle),
    year: normalized.year,
    ...(contentType === "series" && normalized.season !== undefined && normalized.episode !== undefined
      ? { season: normalized.season, episode: normalized.episode }
      : {}),
    group,
    contentType,
    addedAt,
    streamUrl: entry.url,
    sourceLine: entry.line,
    classification,
    classificationSource: "classifier",
  };
}

export function createUnknownCatalogEntry(entry: M3uEntry, addedAt = Date.now()): UnknownCatalogEntry | null {
  const classification = classifyM3uEntry(entry);
  if (classification.kind !== "unknown") return null;
  return {
    id: stableId(`${entry.url}\u0000${entry.line}`),
    entry: { ...entry, attributes: { ...entry.attributes }, options: { ...entry.options } },
    classification,
    addedAt,
  };
}

export function buildVodCatalog(entries: Iterable<M3uEntry>): VodCatalog {
  const items: VodCatalogItem[] = [];
  const unknownEntries: UnknownCatalogEntry[] = [];
  const groupCounts = new Map<string, number>();
  const contentTypeCounts = new Map<VodContentType, number>([["movie", 0], ["series", 0], ["other", 0]]);

  for (const entry of entries) {
    const item = createVodCatalogItem(entry);
    if (!item) {
      const unknown = createUnknownCatalogEntry(entry);
      if (unknown) unknownEntries.push(unknown);
      continue;
    }
    items.push(item);
    groupCounts.set(item.group, (groupCounts.get(item.group) ?? 0) + 1);
    contentTypeCounts.set(item.contentType, (contentTypeCounts.get(item.contentType) ?? 0) + 1);
  }

  return { items, unknownEntries, groupCounts, contentTypeCounts };
}

export function searchVodCatalog(catalog: VodCatalog, query: string, options: VodSearchOptions = {}): VodCatalogItem[] {
  const normalizedQuery = normalizeTitle(query).searchTitle;
  const limit = Math.max(1, options.limit ?? 50);

  return catalog.items.filter((item) => {
    if (options.group !== undefined && item.group !== options.group) return false;
    if (options.contentType !== undefined && item.contentType !== options.contentType) return false;
    return !normalizedQuery || item.searchTitle.includes(normalizedQuery);
  }).slice(0, limit);
}
