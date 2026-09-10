export interface NormalizedTitle {
  title: string;
  searchTitle: string;
  year: number | null;
  season?: number;
  episode?: number;
}

const LANGUAGE_PREFIX = /^[A-Z]{2,3}\s*(?::|-)\s*/;
const TRAILING_YEAR = /\s*(?:[-–—]\s*|\()\b((?:19|20)\d{2})\)?\s*$/;
const PARENTHESIZED_YEAR = /\((?:19|20)\d{2}\)/g;
const EPISODE_MARKER = /(?:\s*[-–—]?\s*)(?:s(?:eason)?\s*(\d{1,2})\s*e(?:pisode)?\s*(\d{1,3})|(\d{1,2})\s*x\s*(\d{1,3}))/i;

export function normalizeTitle(value: string): NormalizedTitle {
  const withoutPrefix = value.trim().replace(LANGUAGE_PREFIX, "");
  const yearMatch = withoutPrefix.match(TRAILING_YEAR);
  const embeddedYear = withoutPrefix.match(PARENTHESIZED_YEAR)?.[0];
  const year = yearMatch?.[1] === undefined
    ? embeddedYear === undefined ? null : Number(embeddedYear.slice(1, -1))
    : Number(yearMatch[1]);
  const title = yearMatch ? withoutPrefix.slice(0, yearMatch.index).trim() : withoutPrefix;
  const episodeMatch = title.match(EPISODE_MARKER);
  const searchSource = (episodeMatch?.index === undefined ? title : title.slice(0, episodeMatch.index))
    .replace(PARENTHESIZED_YEAR, " ")
    .trim();
  const searchTitle = searchSource
    .normalize("NFKD")
    .replace(/\p{Diacritic}/gu, "")
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();

  const season = Number(episodeMatch?.[1] ?? episodeMatch?.[3]);
  const episode = Number(episodeMatch?.[2] ?? episodeMatch?.[4]);
  return {
    title: title || value.trim(),
    searchTitle,
    year,
    ...(Number.isInteger(season) && Number.isInteger(episode) ? { season, episode } : {}),
  };
}

export function searchTerms(value: string): string[] {
  return [...new Set(value.split(" ").filter((term) => term.length >= 2))];
}

export function stableId(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return `vod_${(hash >>> 0).toString(36)}`;
}
