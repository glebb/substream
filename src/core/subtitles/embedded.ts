const FINNISH_CODES = new Set(["fi", "fin", "finnish"]);
const ENGLISH_CODES = new Set(["en", "eng", "english"]);

type SubtitleLanguageCandidate = { language?: string; label: string };
export type EmbeddedSubtitleLanguage = "fi" | "en";

function normalizedLanguage(track: SubtitleLanguageCandidate): string {
  return (track.language ?? track.label).trim().toLocaleLowerCase().split(/[-_]/, 1)[0] ?? "";
}

/**
 * Chooses a supported provider rendition deterministically, preferring the
 * configured language and falling back to the other supported language.
 */
export function preferredEmbeddedSubtitleTrack<T extends SubtitleLanguageCandidate>(tracks: readonly T[], preferredLanguage: EmbeddedSubtitleLanguage = "fi"): T | undefined {
  const preferredCodes = preferredLanguage === "fi" ? FINNISH_CODES : ENGLISH_CODES;
  const fallbackCodes = preferredLanguage === "fi" ? ENGLISH_CODES : FINNISH_CODES;
  return tracks.find((track) => preferredCodes.has(normalizedLanguage(track)))
    ?? tracks.find((track) => fallbackCodes.has(normalizedLanguage(track)));
}
