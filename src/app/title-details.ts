import type { VodCatalogItem } from "../core/catalog/index.ts";

export interface TitleDetails {
  posterUrl?: string;
  synopsis?: string;
  year?: number;
  genres: string[];
  runtimeMinutes?: number;
  rating?: number;
  subtitleLanguages: string[];
}

const webUrl = (value: unknown): string | undefined => {
  if (typeof value !== "string" || !/^https?:\/\/[^\s]+$/i.test(value.trim())) return undefined;
  return value.trim();
};

/** Reads optional provider metadata without trusting ambiguous or malformed values. */
export function titleDetailsFor(item: VodCatalogItem): TitleDetails {
  const raw = (item as VodCatalogItem & { metadata?: unknown }).metadata;
  const metadata = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
  const genres = Array.isArray(metadata.genres)
    ? metadata.genres.filter((genre): genre is string => typeof genre === "string" && genre.trim().length > 0).map((genre) => genre.trim())
    : [];
  const languages = Array.isArray(metadata.subtitleLanguages)
    ? metadata.subtitleLanguages.filter((language): language is string => typeof language === "string" && language.trim().length > 0).map((language) => language.trim())
    : [];
  const year = typeof metadata.year === "number" && Number.isInteger(metadata.year) && metadata.year > 1800 ? metadata.year : item.year ?? undefined;
  const runtimeMinutes = typeof metadata.runtimeMinutes === "number" && Number.isFinite(metadata.runtimeMinutes) && metadata.runtimeMinutes > 0 ? Math.round(metadata.runtimeMinutes) : undefined;
  const rating = typeof metadata.rating === "number" && Number.isFinite(metadata.rating) && metadata.rating >= 0 && metadata.rating <= 10 ? metadata.rating : undefined;
  const synopsis = typeof metadata.synopsis === "string" && metadata.synopsis.trim() ? metadata.synopsis.trim() : undefined;
  const posterUrl = webUrl(metadata.posterUrl);
  return {
    genres,
    subtitleLanguages: languages,
    ...(posterUrl !== undefined ? { posterUrl } : {}),
    ...(synopsis ? { synopsis } : {}),
    ...(year !== undefined ? { year } : {}),
    ...(runtimeMinutes !== undefined ? { runtimeMinutes } : {}),
    ...(rating !== undefined ? { rating } : {}),
  };
}

export function formatRuntime(minutes: number | undefined): string | undefined {
  if (!minutes || !Number.isFinite(minutes) || minutes <= 0) return undefined;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return hours ? `${hours}h ${rest}m` : `${rest}m`;
}
