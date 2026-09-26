const FINNISH_CODES = new Set(["fi", "fin", "finnish"]);
const ENGLISH_CODES = new Set(["en", "eng", "english"]);

type SubtitleLanguageCandidate = { language?: string; label: string };

function normalizedLanguage(track: SubtitleLanguageCandidate): string {
  return (track.language ?? track.label).trim().toLocaleLowerCase().split(/[-_]/, 1)[0] ?? "";
}

/**
 * Chooses the provider rendition deterministically. Live TV deliberately does
 * not fall back to an unrelated language: Finnish, then English, then off.
 */
export function preferredEmbeddedSubtitleTrack<T extends SubtitleLanguageCandidate>(tracks: readonly T[]): T | undefined {
  return tracks.find((track) => FINNISH_CODES.has(normalizedLanguage(track)))
    ?? tracks.find((track) => ENGLISH_CODES.has(normalizedLanguage(track)));
}
