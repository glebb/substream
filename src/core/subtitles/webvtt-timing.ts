const WEBVTT_TIMESTAMP = /^(?:(?<hours>\d{2,}):)?(?<minutes>\d{2}):(?<seconds>\d{2})\.(?<milliseconds>\d{3})$/;
const CUE_TIMING_LINE = /^(?<start>\S+)\s+-->\s+(?<end>\S+)(?<settings>.*)$/;

function parseTimestamp(timestamp: string): number | null {
  const match = WEBVTT_TIMESTAMP.exec(timestamp);
  if (!match?.groups) return null;
  const hours = Number(match.groups.hours ?? 0);
  const minutes = Number(match.groups.minutes);
  const seconds = Number(match.groups.seconds);
  const milliseconds = Number(match.groups.milliseconds);
  if (minutes > 59 || seconds > 59) return null;
  return (((hours * 60 + minutes) * 60 + seconds) * 1_000) + milliseconds;
}

function formatTimestamp(milliseconds: number): string {
  const hours = Math.floor(milliseconds / 3_600_000);
  const minutes = Math.floor(milliseconds / 60_000) % 60;
  const seconds = Math.floor(milliseconds / 1_000) % 60;
  const fraction = milliseconds % 1_000;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}.${String(fraction).padStart(3, "0")}`;
}

/** Shift WebVTT cue times; positive offsets show subtitles later. */
export function shiftWebVttCues(webVttText: string, offsetSeconds: number): string {
  if (!Number.isFinite(offsetSeconds) || offsetSeconds === 0) return webVttText;
  const offsetMilliseconds = Math.round(offsetSeconds * 1_000);
  const normalized = webVttText.replace(/\r\n?/g, "\n");
  const hadTrailingNewline = normalized.endsWith("\n");
  const blocks = normalized.split(/\n[\t ]*\n/);
  const shiftedBlocks = blocks.flatMap((block) => {
    const trimmed = block.trimStart();
    if (!trimmed || trimmed.startsWith("NOTE") || trimmed.startsWith("STYLE") || trimmed.startsWith("REGION")) return [block];

    const lines = block.split("\n");
    const timingLineIndex = lines.findIndex((line) => CUE_TIMING_LINE.test(line));
    if (timingLineIndex < 0) return [block];

    const timingLine = lines[timingLineIndex];
    if (timingLine === undefined) return [block];
    const match = CUE_TIMING_LINE.exec(timingLine);
    const start = match?.groups?.start ? parseTimestamp(match.groups.start) : null;
    const end = match?.groups?.end ? parseTimestamp(match.groups.end) : null;
    if (start === null || end === null) return [block];

    const shiftedStart = start + offsetMilliseconds;
    const shiftedEnd = end + offsetMilliseconds;
    // Drop cues that finish at or before time zero; clip partially visible cues.
    if (shiftedEnd <= 0) return [];
    const clippedStart = Math.max(0, shiftedStart);
    if (clippedStart >= shiftedEnd) return [];
    lines[timingLineIndex] = `${formatTimestamp(clippedStart)} --> ${formatTimestamp(shiftedEnd)}${match?.groups?.settings ?? ""}`;
    return [lines.join("\n")];
  });
  const result = shiftedBlocks.join("\n\n");
  return hadTrailingNewline && !result.endsWith("\n") ? result + "\n" : result;
}
