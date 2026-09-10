export function srtToWebVtt(subtitleText: string): string {
  const normalized = subtitleText.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
  if (normalized.trimStart().startsWith("WEBVTT")) return normalized;

  const cueText = normalized.replace(
    /^(\d{2}:\d{2}:\d{2},\d{3}\s+-->\s+\d{2}:\d{2}:\d{2},\d{3}.*)$/gm,
    (timing) => timing.replace(/,/g, "."),
  );
  return "WEBVTT\n\n" + cueText.trim() + "\n";
}
