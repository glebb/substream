/**
 * Parse a typed playback start position: "h:mm:ss", "m:ss" or plain minutes.
 * Returns whole seconds, or null when the text is not a time.
 */
export function parseStartTime(text: string): number | null {
  const value = text.trim();
  if (!value) return 0;
  if (/^\d{1,4}$/.test(value)) return Number(value) * 60;
  const parts = value.split(":");
  if (parts.length < 2 || parts.length > 3 || !parts.every((part) => /^\d{1,4}$/.test(part))) return null;
  const numbers = parts.map(Number);
  const [hours, minutes, seconds] = numbers.length === 3 ? numbers : [0, numbers[0]!, numbers[1]!];
  if (seconds! >= 60 || (numbers.length === 3 && minutes! >= 60)) return null;
  return hours! * 3_600 + minutes! * 60 + seconds!;
}

/** Clamp a start position to [0, duration]; an unknown duration only clamps at zero. */
export function clampStartTime(seconds: number, durationSeconds: number | null): number {
  const whole = Math.max(0, Math.floor(Number.isFinite(seconds) ? seconds : 0));
  return durationSeconds && durationSeconds > 0 ? Math.min(whole, Math.floor(durationSeconds)) : whole;
}
