const DEFAULT_BASE_URL = "https://api.themoviedb.org/3";
const IMAGE_BASE_URL = "https://image.tmdb.org/t/p/w500";

export type TmdbMediaType = "movie" | "tv";
export type TmdbCredentials = { readAccessToken?: string; apiKey?: string };
export type TmdbMetadata = {
  id: number;
  mediaType: TmdbMediaType;
  title: string;
  originalTitle?: string;
  overview: string;
  year: number | null;
  genres: string[];
  runtime: number | null;
  rating: number | null;
  posterUrl: string | null;
  backdropUrl: string | null;
  language: string;
};
export type TmdbCandidate = { id: number; mediaType: TmdbMediaType; title: string; originalTitle: string; year: number | null; posterUrl: string | null; score: number };
export type HttpResponse = { ok: boolean; status: number; json(): Promise<unknown> };
export type HttpRequest = (url: string, init: RequestInit) => Promise<HttpResponse>;

export class TmdbRequestError extends Error {
  constructor(readonly status?: number) { super(status ? "TMDb request failed (" + status + ")" : "TMDb request failed"); }
}

type Raw = Record<string, unknown>;
const text = (value: unknown): string => typeof value === "string" ? value.trim() : "";
const number = (value: unknown): number | null => typeof value === "number" && Number.isFinite(value) ? value : null;
const year = (value: unknown): number | null => { const match = text(value).match(/^(\d{4})/); return match ? Number(match[1]) : null; };
const image = (path: unknown): string | null => text(path) ? IMAGE_BASE_URL + text(path) : null;
const titleOf = (item: Raw): string => text(item.title) || text(item.name) || text(item.original_title) || text(item.original_name);
const originalTitleOf = (item: Raw): string => text(item.original_title) || text(item.original_name) || titleOf(item);

function normalize(value: string): string { return value.toLocaleLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, " ").trim(); }
function candidateFrom(item: Raw, mediaType: TmdbMediaType, query: string): TmdbCandidate | null {
  const id = number(item.id); const title = titleOf(item); if (!id || !title) return null;
  const normalizedQuery = normalize(query); const normalizedTitle = normalize(title); const original = normalize(originalTitleOf(item));
  // Prefer the localized display title. An original-title match alone is
  // deliberately below the auto-attach threshold: TMDb can pair a translated
  // title with an unrelated result for short/common queries.
  const score = normalizedTitle === normalizedQuery ? 1 : original === normalizedQuery ? 0.9 : normalizedTitle.startsWith(normalizedQuery) ? 0.8 : normalizedTitle.includes(normalizedQuery) ? 0.6 : 0;
  return { id, mediaType, title, originalTitle: originalTitleOf(item), year: year(item.release_date ?? item.first_air_date), posterUrl: image(item.poster_path), score };
}

export class TmdbClient {
  private readonly request: HttpRequest;
  constructor(private readonly credentials: TmdbCredentials, request?: HttpRequest, private readonly baseUrl = DEFAULT_BASE_URL) {
    this.request = request ?? ((url, init) => fetch(url, init));
  }
  private async get(path: string, params: Record<string, string | undefined>): Promise<Raw> {
    const query = new URLSearchParams(); for (const key of Object.keys(params).sort()) if (params[key]) query.set(key, params[key]!);
    const headers: Record<string, string> = { Accept: "application/json" };
    if (this.credentials.readAccessToken?.trim()) headers.Authorization = "Bearer " + this.credentials.readAccessToken.trim();
    else if (this.credentials.apiKey?.trim()) query.set("api_key", this.credentials.apiKey.trim());
    else throw new TmdbRequestError();
    const response = await this.request(this.baseUrl + path + "?" + query, { headers, method: "GET" });
    if (!response.ok) throw new TmdbRequestError(response.status);
    const payload = await response.json(); if (!payload || typeof payload !== "object") throw new TmdbRequestError();
    return payload as Raw;
  }
  private async searchLanguage(query: string, mediaType: TmdbMediaType, language: string, yearHint?: number | null): Promise<TmdbCandidate[]> {
    const payload = await this.get("/search/" + mediaType, { language, query: query.trim(), year: mediaType === "movie" && yearHint ? String(yearHint) : undefined, include_adult: "false" });
    const items = Array.isArray(payload.results) ? payload.results : [];
    return items.map((item) => item && typeof item === "object" ? candidateFrom(item as Raw, mediaType, query) : null).filter((x): x is TmdbCandidate => x !== null);
  }
  async search(query: string, mediaType: TmdbMediaType, yearHint?: number | null): Promise<TmdbCandidate[]> {
    const finnish = await this.searchLanguage(query, mediaType, "fi-FI", yearHint);
    // TMDb may return an unrelated localized title (especially for short/common
    // queries). Ask English only when Finnish produced no confident title match.
    const normalizedQuery = normalize(query);
    const hasExact = finnish.some((candidate) => normalize(candidate.title) === normalizedQuery);
    const english = hasExact ? [] : await this.searchLanguage(query, mediaType, "en-US", yearHint);
    const combined = [...finnish, ...english];
    const bestById = new Map<string, TmdbCandidate>();
    for (const candidate of combined) {
      const key = candidate.mediaType + ":" + candidate.id;
      const previous = bestById.get(key);
      // Finnish is first, so equal-score ties intentionally retain it.
      if (!previous || candidate.score > previous.score) bestById.set(key, candidate);
    }
    return [...bestById.values()].sort((a, b) => b.score - a.score || a.id - b.id);
  }
  async getMetadata(id: number, mediaType: TmdbMediaType): Promise<TmdbMetadata> {
    const localized = await this.get("/" + mediaType + "/" + encodeURIComponent(String(id)), { language: "fi-FI" });
    const localizedTitle = titleOf(localized); const localizedOverview = text(localized.overview);
    const fallback = !localizedTitle || !localizedOverview ? await this.get("/" + mediaType + "/" + encodeURIComponent(String(id)), { language: "en-US" }) : null;
    const item = fallback ? { ...fallback, ...localized, overview: localizedOverview || text(fallback.overview), title: localizedTitle || titleOf(fallback), name: localizedTitle || titleOf(fallback) } : localized;
    const rawGenres = Array.isArray(item.genres) ? item.genres : [];
    return { id, mediaType, title: titleOf(item), originalTitle: originalTitleOf(item), overview: text(item.overview), year: year(item.release_date ?? item.first_air_date), genres: rawGenres.flatMap((genre) => genre && typeof genre === "object" && text((genre as Raw).name) ? [text((genre as Raw).name)] : []), runtime: number(item.runtime) ?? (Array.isArray(item.episode_run_time) ? number(item.episode_run_time[0]) : null), rating: number(item.vote_average), posterUrl: image(item.poster_path), backdropUrl: image(item.backdrop_path), language: localizedOverview || localizedTitle ? "fi-FI" : "en-US" };
  }
  async resolve(query: string, mediaType: TmdbMediaType, yearHint?: number | null): Promise<{ kind: "match"; candidate: TmdbCandidate } | { kind: "ambiguous"; candidates: TmdbCandidate[] } | { kind: "none" }> {
    const candidates = (await this.search(query, mediaType, yearHint)).filter((item) => !yearHint || item.year === yearHint || item.year === null);
    if (!candidates.length) return { kind: "none" };
    const sorted = [...candidates].sort((a, b) => b.score - a.score);
    const best = sorted[0]; const second = sorted[1];
    if (best && best.score >= 0.96 && (!second || best.score > second.score)) return { kind: "match", candidate: best };
    return { kind: "ambiguous", candidates: sorted.slice(0, 8) };
  }
}
