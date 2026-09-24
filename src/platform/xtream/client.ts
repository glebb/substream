import { normalizeTitle, searchTerms, stableId, type VodCatalogItem } from "../../core/catalog/index.ts";
import { providerRequestUrl } from "../provider-request.ts";

type Request = (url: string) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

export type XtreamCategory = {
  id: string;
  name: string;
  contentType: "movie" | "series";
};

type XtreamConnection = {
  apiUrl: URL;
  streamBaseUrl: string;
  username: string;
  password: string;
};

type XtreamCategoryResponse = { category_id?: string | number; category_name?: string };
type XtreamVodResponse = { stream_id?: string | number; name?: string; container_extension?: string; added?: string | number; year?: string | number };
type XtreamSeriesResponse = { series_id?: string | number; name?: string; year?: string | number; last_modified?: string | number };
type XtreamSeriesInfoResponse = { episodes?: Record<string, Array<{ id?: string | number; title?: string; episode_num?: string | number; container_extension?: string }>> };

export class XtreamRequestError extends Error {
  constructor(readonly status?: number) {
    super(status ? "Provider request failed (" + status + ")" : "Provider request failed");
  }
}

export class XtreamClient {
  private constructor(
    private readonly connection: XtreamConnection,
    private readonly request: Request,
  ) {}

  static fromPlaylistUrl(playlistUrl: string, request: Request = (url) => fetch(providerRequestUrl(url))): XtreamClient | null {
    let playlist: URL;
    try {
      playlist = new URL(playlistUrl);
    } catch {
      return null;
    }
    const username = playlist.searchParams.get("username");
    const password = playlist.searchParams.get("password");
    if (!username || !password || !/\/get\.php$/i.test(playlist.pathname)) return null;

    const apiUrl = new URL(playlist.toString());
    apiUrl.pathname = apiUrl.pathname.replace(/get\.php$/i, "player_api.php");
    apiUrl.search = "";
    const streamBaseUrl = playlist.origin + playlist.pathname.slice(0, playlist.pathname.lastIndexOf("/") + 1);
    return new XtreamClient({ apiUrl, streamBaseUrl, username, password }, request);
  }

  async categories(): Promise<XtreamCategory[]> {
    const [movies, series] = await Promise.all([
      this.get<XtreamCategoryResponse[]>("get_vod_categories"),
      this.get<XtreamCategoryResponse[]>("get_series_categories"),
    ]);
    return [
      ...this.categoriesFor(movies, "movie"),
      ...this.categoriesFor(series, "series"),
    ];
  }

  async movies(categoryId: string): Promise<VodCatalogItem[]> {
    const records = await this.get<XtreamVodResponse[]>("get_vod_streams", { category_id: categoryId });
    return records.flatMap((record) => {
      const id = String(record.stream_id ?? "");
      const name = record.name?.trim();
      if (!id || !name) return [];
      const normalized = normalizeTitle(name);
      return [{
        id: "xtream:movie:" + id,
        title: normalized.title,
        searchTitle: normalized.searchTitle,
        searchTerms: searchTerms(normalized.searchTitle),
        year: normalized.year ?? numberOrNull(record.year),
        group: "",
        contentType: "movie" as const,
        addedAt: numberOrNull(record.added) ?? 0,
        sourceLine: numberOrNull(record.stream_id) ?? 0,
        streamUrl: this.streamUrl("movie", id, record.container_extension),
      }];
    });
  }

  async series(categoryId: string): Promise<VodCatalogItem[]> {
    const records = await this.get<XtreamSeriesResponse[]>("get_series", { category_id: categoryId });
    return records.flatMap((record) => {
      const id = numberOrNull(record.series_id);
      const name = record.name?.trim();
      if (id === null || !name) return [];
      const normalized = normalizeTitle(name);
      return [{
        id: "xtream:series:" + id,
        title: normalized.title,
        searchTitle: normalized.searchTitle,
        searchTerms: searchTerms(normalized.searchTitle),
        year: normalized.year ?? numberOrNull(record.year),
        group: "",
        contentType: "series" as const,
        addedAt: numberOrNull(record.last_modified) ?? 0,
        sourceLine: id,
        streamUrl: "",
        providerSeriesId: id,
      }];
    });
  }

  async episodes(seriesId: number, seriesName: string): Promise<VodCatalogItem[]> {
    const payload = await this.get<XtreamSeriesInfoResponse>("get_series_info", { series_id: String(seriesId) });
    const episodes = Object.keys(payload.episodes ?? {}).sort((left, right) => Number(left) - Number(right))
      .flatMap((season) => payload.episodes?.[season] ?? []);
    return episodes.flatMap((record) => {
      const id = String(record.id ?? "");
      if (!id) return [];
      const episodeNumber = numberOrNull(record.episode_num);
      const title = record.title?.trim() || seriesName + (episodeNumber === null ? "" : " E" + episodeNumber);
      const normalized = normalizeTitle(title);
      return [{
        id: "xtream:episode:" + id,
        title,
        searchTitle: normalized.searchTitle,
        searchTerms: searchTerms(normalized.searchTitle),
        year: normalized.year,
        ...(normalized.season !== undefined ? { season: normalized.season } : {}),
        ...(normalized.episode !== undefined ? { episode: normalized.episode } : episodeNumber === null ? {} : { episode: episodeNumber }),
        group: seriesName,
        contentType: "series" as const,
        addedAt: 0,
        sourceLine: numberOrNull(record.id) ?? 0,
        streamUrl: this.streamUrl("series", id, record.container_extension),
      }];
    });
  }

  streamUrlFor(kind: "movie" | "series", id: string, extension?: string): string {
    if (!/^\d{1,20}$/.test(id)) throw new Error("Invalid provider stream identifier");
    return this.streamUrl(kind, id, extension);
  }

  /** Stable server/path fingerprint that deliberately excludes playlist credentials. */
  sourceFingerprint(): string {
    return stableId(this.connection.apiUrl.origin + this.connection.apiUrl.pathname);
  }

  /** Account-aware pairing identity; hashes the username without exposing it. */
  pairingFingerprint(): string {
    return stableId(this.connection.apiUrl.origin + this.connection.apiUrl.pathname + "\0" + this.connection.username);
  }

  private async get<T>(action: string, parameters: Record<string, string> = {}): Promise<T> {
    const url = new URL(this.connection.apiUrl.toString());
    url.searchParams.set("username", this.connection.username);
    url.searchParams.set("password", this.connection.password);
    url.searchParams.set("action", action);
    for (const [key, value] of Object.entries(parameters)) url.searchParams.set(key, value);
    const response = await this.request(url.toString());
    if (!response.ok) throw new XtreamRequestError(response.status);
    return response.json() as Promise<T>;
  }

  private categoriesFor(records: XtreamCategoryResponse[], contentType: XtreamCategory["contentType"]): XtreamCategory[] {
    return (Array.isArray(records) ? records : []).flatMap((record) => {
      const id = String(record.category_id ?? "");
      const name = record.category_name?.trim();
      return id && name ? [{ id, name, contentType }] : [];
    });
  }

  private streamUrl(kind: "movie" | "series", id: string, extension: string | undefined): string {
    const safeExtension = extension && /^[a-z0-9]+$/i.test(extension) ? extension : "mp4";
    return this.connection.streamBaseUrl + kind + "/" + encodeURIComponent(this.connection.username) + "/" + encodeURIComponent(this.connection.password) + "/" + encodeURIComponent(id) + "." + safeExtension;
  }
}

function numberOrNull(value: string | number | undefined): number | null {
  if (typeof value === "string" && value.trim() === "") return null;
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : null;
}
