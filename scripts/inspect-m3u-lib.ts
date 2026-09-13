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
