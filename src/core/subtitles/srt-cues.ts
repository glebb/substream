export interface SubtitleCue {
  startMs: number;
  endMs: number;
  text: string;
}
import { normalizeSubtitleText } from "./normalize.ts";

/** Parses the common SRT subset returned by OpenSubtitles into timed cues. */
export function parseSrtCues(subtitleText: string): SubtitleCue[] {
  return subtitleText.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n").trim().split(/\n{2,}/).flatMap((block) => {
    const lines = block.split("\n");
    const timingIndex = lines.findIndex((line) => line.includes("-->"));
    if (timingIndex < 0) return [];
    const [startText, endText] = (lines[timingIndex] ?? "").split("-->");
    const startMs = parseTimestamp(startText ?? "");
    const endMs = parseTimestamp(endText ?? "");
    const text = normalizeSubtitleText(lines.slice(timingIndex + 1).join("\n")).trim();
    return startMs === undefined || endMs === undefined || !text ? [] : [{ startMs, endMs, text }];
  });
}

function parseTimestamp(value: string): number | undefined {
  const match = value.trim().match(/^(\d+):(\d{2}):(\d{2})[,.](\d{3})$/);
  if (!match) return undefined;
  const [, hours, minutes, seconds, milliseconds] = match;
  return ((Number(hours) * 3_600) + (Number(minutes) * 60) + Number(seconds)) * 1_000 + Number(milliseconds);
}
