/** Subtitle timing adjustment limit in either direction. */
export const MAX_SUBTITLE_OFFSET_SECONDS = 10;

/**
 * Keeps user timing adjustments bounded and aligned to half-second steps.
 * Positive values delay subtitles; negative values show them earlier.
 */
export function normalizeSubtitleOffsetSeconds(offsetSeconds: number): number {
  if (!Number.isFinite(offsetSeconds)) return 0;
  const bounded = Math.max(-MAX_SUBTITLE_OFFSET_SECONDS, Math.min(MAX_SUBTITLE_OFFSET_SECONDS, offsetSeconds));
  const rounded = Math.round(bounded * 2) / 2;
  return Object.is(rounded, -0) ? 0 : rounded;
}

export function adjustSubtitleOffsetSeconds(currentSeconds: number, deltaSeconds: number): number {
  return normalizeSubtitleOffsetSeconds(normalizeSubtitleOffsetSeconds(currentSeconds) + deltaSeconds);
}
