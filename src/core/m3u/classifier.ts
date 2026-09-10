import type { M3uEntry, MediaClassification } from "./types.ts";

const VOD_EXTENSIONS = new Set([
  "3gp", "avi", "flv", "m2ts", "m4v", "mkv", "mov", "mp4", "mpeg", "mpg", "ts", "webm", "wmv",
]);

// Providers frequently use "Movies Club" for live television channels. Only
// provider-style catalogue prefixes (for example, "Movies: Nordic") are strong
// enough group metadata to classify an entry as on-demand content.
const VOD_GROUP_PATTERN = /^(?:vod|movies?|series|films?)\s*(?::|\||-|$)/i;
const LIVE_GROUP_PATTERN = /\b(?:movie|movies|film|films)\s+club\b/i;

export function classifyM3uEntry(entry: M3uEntry): MediaClassification {
  const vodEvidence: string[] = [];
  const liveEvidence: string[] = [];
  let pathname = "";
  let protocol = "";

  try {
    const parsed = new URL(entry.url);
    pathname = parsed.pathname.toLowerCase();
    protocol = parsed.protocol.toLowerCase();
  } catch {
    pathname = entry.url.toLowerCase().split(/[?#]/, 1)[0] ?? "";
  }

  const extension = pathname.match(/\.([a-z0-9]+)$/)?.[1];
  const groupTitle = entry.attributes["group-title"] ?? "";
  const declaredType = entry.attributes.type ?? entry.attributes["media-type"] ?? "";

  if (LIVE_GROUP_PATTERN.test(groupTitle)) liveEvidence.push("Group title identifies a live movie/film channel collection");
  if (/(?:^|\/)movie(?:\/|$)/.test(pathname)) vodEvidence.push("URL contains a movie path segment");
  if (/(?:^|\/)series(?:\/|$)/.test(pathname)) vodEvidence.push("URL contains a series path segment");
  if (extension && VOD_EXTENSIONS.has(extension)) vodEvidence.push(`URL has a video-file extension (.${extension})`);
  if (entry.duration !== null && entry.duration > 0) vodEvidence.push("EXTINF declares a positive duration");
  if (VOD_GROUP_PATTERN.test(groupTitle)) vodEvidence.push("Group title uses an on-demand catalogue prefix");
  if (/\b(?:vod|movie|film)\b/i.test(declaredType)) vodEvidence.push("Playlist metadata declares movie/VOD content");

  if (/(?:^|\/)live(?:\/|$)/.test(pathname)) liveEvidence.push("URL contains a live path segment");
  if (["udp:", "rtp:", "rtsp:"].includes(protocol)) liveEvidence.push(`URL uses the ${protocol} live-stream protocol`);
  if (extension === "m3u8" && vodEvidence.length === 0) liveEvidence.push("HLS URL has no VOD-specific evidence");

  const hasExplicitVodLocation = vodEvidence.some(
    (item) => item.includes("movie path segment") || item.includes("series path segment"),
  );
  const hasExplicitLiveLocation = liveEvidence.some(
    (item) => item.includes("live path segment") || item.includes("live-stream protocol"),
  );

  // A provider's URL routing is more trustworthy than a generic .ts extension,
  // which is used by both live and on-demand IPTV streams.
  if (hasExplicitLiveLocation && !hasExplicitVodLocation) {
    return { kind: "live", confidence: "high", evidence: liveEvidence };
  }

  if (liveEvidence.length > 0 && vodEvidence.length === 0) {
    return {
      kind: "live",
      confidence: liveEvidence.some((item) => item.includes("path segment") || item.includes("protocol") || item.includes("channel collection"))
        ? "high"
        : "low",
      evidence: liveEvidence,
    };
  }

  if (vodEvidence.length > 0) {
    return {
      kind: "vod",
      confidence: vodEvidence.length >= 2 || vodEvidence.some((item) => item.includes("movie path")) ? "high" : "medium",
      evidence: vodEvidence,
    };
  }

  if (liveEvidence.length > 0) {
    return {
      kind: "live",
      confidence: liveEvidence.some((item) => item.includes("path segment") || item.includes("protocol")) ? "high" : "low",
      evidence: liveEvidence,
    };
  }

  return { kind: "unknown", confidence: "low", evidence: ["No reliable VOD or live markers"] };
}
