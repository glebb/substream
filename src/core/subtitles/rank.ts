export type SubtitleMatchTarget = {
  title: string;
  year: number | null;
  contentType: "movie" | "series";
  season?: number;
  episode?: number;
  parentFeatureId?: number;
};

export type SubtitleCandidate = {
  id: string;
  language: string;
  releaseName: string;
  fileId: number;
  fileName: string;
  hearingImpaired: boolean;
  downloads: number;
  featureType?: string;
  featureTitle?: string;
  featureYear?: number | null;
  parentFeatureId?: number;
  season?: number;
  episode?: number;
};

export type RankedSubtitleResult = SubtitleCandidate & {
  metadataMatch: boolean;
  releaseSimilarity: number;
  languageRank: number;
  highConfidence: boolean;
};

const LANGUAGE_RANK: Record<string, number> = { fi: 0, en: 1 };
const RELEASE_NOISE = new Set([
  "1080p", "2160p", "720p", "480p", "bluray", "brrip", "dvdrip", "web", "webdl", "webrip",
  "h264", "h265", "x264", "x265", "hevc", "aac", "dts", "proper", "repack", "limited", "extended",
  "multi", "dubbed", "subbed", "hdr", "uhd", "avc", "remux", "complete", "season", "episode",
]);

function words(value: string): string[] {
  return value.toLocaleLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "")
    .replace(/\b(?:s\d{1,2}e\d{1,3}|\d{1,2}x\d{1,3})\b/gi, " ")
    .replace(/[^a-z0-9]+/g, " ").trim().split(/\s+/).filter((word) => word && !RELEASE_NOISE.has(word));
}

function similarity(target: string, source: string): number {
  const targetWords = [...new Set(words(target))];
  if (!targetWords.length) return 0;
  const sourceWords = new Set(words(source));
  return targetWords.filter((word) => sourceWords.has(word)).length / targetWords.length;
}

function titleMatches(target: string, candidate: string | undefined): boolean {
  if (!candidate) return false;
  const left = words(target);
  const right = words(candidate);
  return left.length > 0 && left.every((word) => right.includes(word));
}

function releaseHasYear(releaseName: string, year: number): boolean {
  return new RegExp(`(?:^|\\D)${year}(?:\\D|$)`).test(releaseName);
}

function compareRanked(a: RankedSubtitleResult, b: RankedSubtitleResult): number {
  return Number(b.metadataMatch) - Number(a.metadataMatch)
    || a.languageRank - b.languageRank
    || b.releaseSimilarity - a.releaseSimilarity
    || b.downloads - a.downloads
    || a.id.localeCompare(b.id);
}

/**
 * Filters known metadata conflicts and ranks subtitle candidates using only
 * platform-independent data. Missing provider metadata remains eligible for
 * manual selection, but is not by itself enough to auto-attach a subtitle.
 */
export function rankSubtitleResults(target: SubtitleMatchTarget, results: SubtitleCandidate[]): RankedSubtitleResult[] {
  const targetTitle = target.title.trim();
  return results.flatMap((result) => {
    const languageRank = LANGUAGE_RANK[result.language.toLowerCase()];
    if (languageRank === undefined) return [];

    const featureType = result.featureType?.toLowerCase();
    if (target.contentType === "movie" && featureType && /episode|tvshow|series/.test(featureType)) return [];
    if (target.contentType === "series" && featureType && /movie|film/.test(featureType)) return [];
    if (target.year !== null && result.featureYear != null && result.featureYear !== target.year) return [];
    if (target.parentFeatureId !== undefined && result.parentFeatureId !== undefined
      && result.parentFeatureId !== target.parentFeatureId) return [];
    if (target.season !== undefined && result.season !== undefined && result.season !== target.season) return [];
    if (target.episode !== undefined && result.episode !== undefined && result.episode !== target.episode) return [];

    const featureTitleMatches = titleMatches(targetTitle, result.featureTitle);
    const releaseSimilarity = similarity(targetTitle, result.releaseName);
    const releaseTitleMatches = titleMatches(targetTitle, result.releaseName);
    const episodeKnown = target.season !== undefined && target.episode !== undefined
      && result.season === target.season && result.episode === target.episode;
    const exactParent = target.parentFeatureId !== undefined && result.parentFeatureId === target.parentFeatureId;
    const movieYearMatches = target.year === null
      || result.featureYear === target.year
      || releaseHasYear(result.releaseName, target.year);
    const metadataMatch = target.contentType === "series"
      ? episodeKnown && (exactParent || featureTitleMatches)
      : movieYearMatches && (featureTitleMatches || (releaseTitleMatches && target.year !== null && releaseHasYear(result.releaseName, target.year)));
    const highConfidence = target.contentType === "series"
      ? episodeKnown && (exactParent || featureTitleMatches)
      : movieYearMatches && (featureTitleMatches || (releaseTitleMatches && target.year !== null && releaseHasYear(result.releaseName, target.year)));

    return [{ ...result, metadataMatch, releaseSimilarity, languageRank, highConfidence }];
  }).sort(compareRanked);
}
