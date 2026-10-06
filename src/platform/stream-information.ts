import type { StreamInformation } from "./media-player.ts";

/** Reject arbitrary metadata, including credential-bearing URLs and free text. */
export function technicalToken(value: unknown): string | undefined {
  return typeof value === "string" && /^[a-zA-Z0-9][a-zA-Z0-9 ._()+-]{0,47}$/.test(value) ? value : undefined;
}

export function positiveMetadataNumber(value: unknown): number | undefined {
  if (typeof value !== "number" && typeof value !== "string") return undefined;
  const number = Number(value);
  return Number.isFinite(number) && number > 0 && number < 1e12 ? number : undefined;
}

export function streamInformationRows(info: StreamInformation): Array<[string, string]> {
  const rows: Array<[string, string]> = [];
  for (const [key, label] of [["videoCodec", "Video codec"], ["audioCodec", "Audio codec"], ["audioLanguage", "Audio language"], ["subtitleLanguage", "Subtitle language"], ["subtitleCodec", "Subtitle codec"]] as const) {
    const value = technicalToken(info[key]);
    if (value || key === "videoCodec" || key === "audioCodec") rows.push([label, value ?? "Unavailable"]);
  }
  for (const [key, label, divisor, unit] of [
    ["frameRate", "Frame rate", 1, " fps"], ["videoBitrate", "Video bitrate", 1000, " kb/s"],
    ["streamBitrate", "Rendition bitrate", 1000, " kb/s"],
    ["audioBitrate", "Audio bitrate", 1000, " kb/s"], ["audioChannels", "Audio channels", 1, ""],
    ["audioSampleRate", "Audio sample rate", 1000, " kHz"], ["bufferedSeconds", "Buffered ahead", 1, " s"],
    ["decodedFrames", "Total video frames", 1, ""], ["droppedFrames", "Dropped frames", 1, ""],
  ] as const) {
    const value = info[key];
    if (typeof value === "number" && Number.isFinite(value) && value >= 0) rows.push([label, String(Math.round(value / divisor * 100) / 100) + unit]);
  }
  for (const [key, label] of [["audioTrackCount", "Audio tracks"], ["subtitleTrackCount", "Embedded subtitle tracks"]] as const) {
    const value = info[key];
    rows.push([label, typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? String(value) : "Unavailable"]);
  }
  return rows;
}
