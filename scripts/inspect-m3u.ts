import { classifyM3uEntry, parseM3u, redactUrl } from "../src/core/m3u/index.ts";
import { buildVodCatalog } from "../src/core/catalog/index.ts";

const DEFAULT_MAX_PLAYLIST_MB = 250;
const requestedMaxMegabytes = Number(process.env.IPTV_M3U_MAX_MB ?? DEFAULT_MAX_PLAYLIST_MB);
const maxPlaylistMegabytes = Number.isFinite(requestedMaxMegabytes) && requestedMaxMegabytes > 0
  ? requestedMaxMegabytes
  : DEFAULT_MAX_PLAYLIST_MB;
const MAX_PLAYLIST_BYTES = maxPlaylistMegabytes * 1024 * 1024;
const playlistUrl = process.env.IPTV_M3U_URL?.trim();

if (!playlistUrl) {
  console.error("IPTV_M3U_URL is empty. Add the private playlist URL to .env.");
  process.exitCode = 1;
} else {
  try {
    const response = await fetch(playlistUrl, { signal: AbortSignal.timeout(60_000) });
    if (!response.ok) {
      throw new Error(`Playlist request failed with HTTP ${response.status} (${redactUrl(response.url)})`);
    }

    const contentLength = Number(response.headers.get("content-length") ?? 0);
    if (contentLength > MAX_PLAYLIST_BYTES) {
      throw new Error(`Playlist exceeds the ${maxPlaylistMegabytes} MB safety limit`);
    }

    const source = await response.text();
    if (Buffer.byteLength(source) > MAX_PLAYLIST_BYTES) {
      throw new Error(`Playlist exceeds the ${maxPlaylistMegabytes} MB safety limit`);
    }

    const playlist = parseM3u(source);
    const classified = playlist.entries.map((entry) => ({ entry, classification: classifyM3uEntry(entry) }));
    const catalog = buildVodCatalog(playlist.entries);
    const count = (kind: "vod" | "live" | "unknown") =>
      classified.filter(({ classification }) => classification.kind === kind).length;
    const groups = new Map<string, number>();

    for (const [group, entries] of catalog.groupCounts) {
      groups.set(group, entries);
    }

    const summary = {
      totalEntries: playlist.entries.length,
      vodCandidates: count("vod"),
      liveCandidates: count("live"),
      unknownEntries: count("unknown"),
      vodContentTypes: Object.fromEntries(catalog.contentTypeCounts),
      warnings: playlist.warnings.slice(0, 20),
      largestVodGroups: [...groups.entries()]
        .sort((left, right) => right[1] - left[1])
        .slice(0, 20)
        .map(([name, entries]) => ({ name, entries })),
      sampleVods: classified
        .filter(({ classification }) => classification.kind === "vod")
        .slice(0, 10)
        .map(({ entry, classification }) => ({
          name: entry.name,
          group: entry.attributes["group-title"] ?? "Ungrouped",
          confidence: classification.confidence,
          evidence: classification.evidence,
        })),
    };

    console.log(JSON.stringify(summary, null, 2));
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown playlist error";
    console.error(message.replaceAll(playlistUrl, "[REDACTED PLAYLIST URL]"));
    process.exitCode = 1;
  }
}
