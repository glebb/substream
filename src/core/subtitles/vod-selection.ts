export type VodSubtitleLanguage = "fi" | "en";

/** Safe metadata used to rank tracks exposed by the playback engine. */
export interface VodEmbeddedSubtitleCandidate {
  id: string;
  label: string;
  language?: string;
  selected?: boolean;
  playable?: boolean;
  forced?: boolean;
  hearingImpaired?: boolean;
}

/** Returns a supported language for ISO 639-1/2 codes or recognizable labels. */
export function normalizeVodSubtitleLanguage(value: string | undefined): VodSubtitleLanguage | undefined {
  const normalized = (value ?? "").trim().toLocaleLowerCase().replace(/_/g, "-");
  const code = normalized.split("-", 1)[0] ?? "";
  if (code === "fi" || code === "fin") return "fi";
  if (code === "en" || code === "eng") return "en";
  for (const language of ["fi", "en"] as const) {
    const label = language === "fi" ? "finnish" : "english";
    if (new RegExp(`(?:^|[^a-z])${label}(?:$|[^a-z])`, "i").test(normalized)) return language;
  }
  return undefined;
}

/**
 * Selects a usable full subtitle in one language. Ordinary subtitles win over
 * hearing-impaired captions unless the viewer explicitly prefers those.
 */
export function chooseEmbeddedSubtitleTrack<T extends VodEmbeddedSubtitleCandidate>(
  tracks: readonly T[],
  language: VodSubtitleLanguage,
  options: { includeHearingImpaired?: boolean | undefined } = {},
): T | undefined {
  const usable = tracks.filter((track) =>
    track.playable !== false
    && track.forced !== true
    && normalizeVodSubtitleLanguage(track.language ?? track.label) === language,
  );
  const ranked = options.includeHearingImpaired === true
    ? usable
    : [...usable.filter((track) => track.hearingImpaired !== true), ...usable.filter((track) => track.hearingImpaired === true)];
  return ranked.find((track) => track.selected && (options.includeHearingImpaired === true || track.hearingImpaired !== true))
    ?? ranked[0];
}

/** Uses the configured language first, then the other supported language. */
export function choosePreferredEmbeddedSubtitleTrack<T extends VodEmbeddedSubtitleCandidate>(
  tracks: readonly T[],
  preferredLanguage: VodSubtitleLanguage,
  options: { includeHearingImpaired?: boolean | undefined } = {},
): T | undefined {
  return chooseEmbeddedSubtitleTrack(tracks, preferredLanguage, options)
    ?? chooseEmbeddedSubtitleTrack(tracks, preferredLanguage === "fi" ? "en" : "fi", options);
}
