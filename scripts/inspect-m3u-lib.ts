import { classifyM3uEntry, parseM3u } from "../src/core/m3u/index.ts";
import { buildVodCatalog } from "../src/core/catalog/index.ts";

export class PlaylistSizeLimitError extends Error {
  constructor(limitBytes: number) {
    super("Playlist exceeds the configured " + (limitBytes / (1024 * 1024)) + " MB safety limit");
    this.name = "PlaylistSizeLimitError";
  }
}

export function safeInspectionError(error: unknown): string {
  if (error instanceof PlaylistSizeLimitError) return error.message;
  return "Playlist inspection failed. Check the configured URL and network connection.";
}

/** Reads decoded response bytes incrementally and never retains more than the configured cap. */
export async function readPlaylistResponse(response: Response, limitBytes: number): Promise<string> {
  if (!Number.isSafeInteger(limitBytes) || limitBytes <= 0) throw new RangeError("A positive byte limit is required");
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > limitBytes) throw new PlaylistSizeLimitError(limitBytes);
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Streaming response support is required");

  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      if (totalBytes + value.byteLength > limitBytes) {
        await reader.cancel();
        throw new PlaylistSizeLimitError(limitBytes);
      }
      chunks.push(value);
      totalBytes += value.byteLength;
    }
  } catch (error) {
    try { await reader.cancel(); } catch { /* A failed or oversized response may already be cancelled. */ }
    throw error;
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength))).toString("utf8");
}

export interface SafePlaylistSummary {
  totalEntries: number;
  vodCandidates: number;
  liveCandidates: number;
  unknownEntries: number;
  vodContentTypes: Record<string, number>;
  warningCount: number;
  largestVodGroups: Array<{ category: string; entries: number }>;
  sampleVods: Array<{ sample: number; confidence: string; evidenceCount: number }>;
}

/** Provider-supplied names, URLs, warning text, and evidence details are intentionally omitted. */
export function summarizePlaylist(source: string): SafePlaylistSummary {
  const playlist = parseM3u(source);
  const classified = playlist.entries.map((entry) => ({ entry, classification: classifyM3uEntry(entry) }));
  const catalog = buildVodCatalog(playlist.entries);
  const count = (kind: "vod" | "live" | "unknown") =>
    classified.filter(({ classification }) => classification.kind === kind).length;
  return {
    totalEntries: playlist.entries.length,
    vodCandidates: count("vod"),
    liveCandidates: count("live"),
    unknownEntries: count("unknown"),
    vodContentTypes: Object.fromEntries(catalog.contentTypeCounts),
    warningCount: playlist.warnings.length,
    largestVodGroups: [...catalog.groupCounts.entries()]
      .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
      .slice(0, 20)
      .map(([, entries], index) => ({ category: "Category " + (index + 1), entries })),
    sampleVods: classified
      .filter(({ classification }) => classification.kind === "vod")
      .slice(0, 10)
      .map(({ classification }, index) => ({
        sample: index + 1,
        confidence: classification.confidence,
        evidenceCount: classification.evidence.length,
      })),
  };
}

export interface LiveCategoryShapeSummary {
  liveCategories: number;
  liveEntries: number;
  separators: Record<string, number>;
  leadingTokens: Array<{ token: string; separator: string; categories: number; entries: number }>;
  unseparatedFirstWords: Array<{ token: string; categories: number; entries: number }>;
}

const CATEGORY_SEPARATOR = /\s*([|:▸»›•/]|\s-\s|\s–\s)\s*/;

/**
 * Describes how provider live categories are prefixed without printing full category names.
 * Only short alphanumeric leading tokens are kept, so URLs and long free-form names cannot leak.
 */
export function summarizeLiveCategoryShapes(source: string): LiveCategoryShapeSummary {
  const playlist = parseM3u(source);
  const entriesByCategory = new Map<string, number>();
  for (const entry of playlist.entries) {
    if (classifyM3uEntry(entry).kind !== "live") continue;
    const category = (entry.attributes["group-title"] ?? "").trim();
    entriesByCategory.set(category, (entriesByCategory.get(category) ?? 0) + 1);
  }
  const separators = new Map<string, number>();
  const leading = new Map<string, { token: string; separator: string; categories: number; entries: number }>();
  const unseparated = new Map<string, { token: string; categories: number; entries: number }>();
  for (const [category, entries] of entriesByCategory) {
    const urlLike = /:\/\/|\bwww\./i.test(category);
    const match = urlLike ? null : CATEGORY_SEPARATOR.exec(category);
    const head = match && match.index > 0 ? category.slice(0, match.index) : "";
    const token = safeToken(head);
    if (match && token) {
      const separator = match[1]!.trim() || "-";
      separators.set(separator, (separators.get(separator) ?? 0) + 1);
      const key = token + "\u0000" + separator;
      const item = leading.get(key) ?? { token, separator, categories: 0, entries: 0 };
      item.categories += 1;
      item.entries += entries;
      leading.set(key, item);
    } else {
      separators.set("none", (separators.get("none") ?? 0) + 1);
      const firstWord = urlLike ? "(url-like)" : safeToken(category.split(/\s+/, 1)[0] ?? "") || "(non-text)";
      const item = unseparated.get(firstWord) ?? { token: firstWord, categories: 0, entries: 0 };
      item.categories += 1;
      item.entries += entries;
      unseparated.set(firstWord, item);
    }
  }
  const byCategories = <T extends { categories: number; token: string }>(left: T, right: T) =>
    right.categories - left.categories || left.token.localeCompare(right.token);
  return {
    liveCategories: entriesByCategory.size,
    liveEntries: [...entriesByCategory.values()].reduce((sum, value) => sum + value, 0),
    separators: Object.fromEntries(separators),
    leadingTokens: [...leading.values()].sort(byCategories),
    unseparatedFirstWords: [...unseparated.values()].sort(byCategories),
  };
}

function safeToken(value: string): string {
  const cleaned = value.normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/[^A-Za-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
  return cleaned.length > 0 && cleaned.length <= 16 ? cleaned : "";
}
