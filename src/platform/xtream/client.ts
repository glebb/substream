import { normalizeTitle, searchTerms, stableId, type VodCatalogItem } from "../../core/catalog/index.ts";
import { providerRequestUrl } from "../provider-request.ts";
import type { EpgProgramme, LiveCategory, ProviderLiveStream } from "../../core/live/index.ts";

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
type XtreamLiveResponse = { stream_id?: string | number; category_id?: string | number; name?: string; stream_icon?: string; epg_channel_id?: string; num?: string | number };
type XtreamEpgResponse = {
  title?: string;
  description?: string;
  start?: string | number;
  end?: string | number;
  start_timestamp?: string | number;
  stop_timestamp?: string | number;
  end_timestamp?: string | number;
};
type XtreamShortEpgPayload = { epg_listings?: unknown };

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

  async liveCategories(): Promise<LiveCategory[]> {
    const records = await this.get<XtreamCategoryResponse[]>("get_live_categories");
    return (Array.isArray(records) ? records : []).flatMap((record) => {
      const id = String(record.category_id ?? "");
      const name = record.category_name?.trim();
      return id && name ? [{ id, name }] : [];
    });
  }

  async liveStreams(categoryId?: string): Promise<ProviderLiveStream[]> {
    const records = await this.get<XtreamLiveResponse[]>("get_live_streams", categoryId ? { category_id: categoryId } : {});
    return (Array.isArray(records) ? records : []).flatMap((record, index) => {
      const streamId = String(record.stream_id ?? "");
      const resolvedCategoryId = String(record.category_id ?? categoryId ?? "");
      const name = record.name?.trim();
      if (!/^\d{1,20}$/.test(streamId) || !resolvedCategoryId || !name) return [];
      const order = numberOrNull(record.num) ?? index;
      return [{ streamId, categoryId: resolvedCategoryId, name, order,
        ...(record.stream_icon?.trim() ? { logo: record.stream_icon.trim() } : {}),
        ...(record.epg_channel_id?.trim() ? { epgId: record.epg_channel_id.trim() } : {}),
      }];
    });
  }

  /** Returns the short guide for one channel, keyed by the provider stream ID. */
  async shortEpg(streamId: string, limit = 10): Promise<EpgProgramme[]> {
    if (!/^\d{1,20}$/.test(streamId)) throw new Error("Invalid provider stream identifier");
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error("Invalid EPG programme limit");
    const payload = await this.get<unknown>("get_short_epg", { stream_id: streamId, limit: String(limit) });
    const records = Array.isArray(payload)
      ? payload
      : payload && typeof payload === "object" && Array.isArray((payload as XtreamShortEpgPayload).epg_listings)
        ? (payload as XtreamShortEpgPayload).epg_listings as unknown[]
        : [];
    return records.flatMap((value) => {
      if (!value || typeof value !== "object") return [];
      const record = value as XtreamEpgResponse;
      const startTime = epgTime(record.start_timestamp ?? record.start);
      const endTime = epgTime(record.stop_timestamp ?? record.end_timestamp ?? record.end);
      const title = providerText(record.title);
      if (startTime === null || endTime === null || endTime <= startTime || !title) return [];
      const description = providerText(record.description);
      return [{
        channelId: streamId,
        title,
        startTime,
        endTime,
        ...(description ? { description } : {}),
      }];
    });
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

  liveStreamUrl(id: string, extension: "ts" | "m3u8" = "ts"): string {
    if (!/^\d{1,20}$/.test(id)) throw new Error("Invalid provider stream identifier");
    return this.connection.streamBaseUrl + "live/" + encodeURIComponent(this.connection.username) + "/" + encodeURIComponent(this.connection.password) + "/" + encodeURIComponent(id) + "." + extension;
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
    try {
      const response = await this.request(url.toString());
      if (!response.ok) throw new XtreamRequestError(response.status);
      return await response.json() as T;
    } catch (error) {
      if (error instanceof XtreamRequestError) throw error;
      // Request implementations often include the full credential-bearing URL in
      // their errors. Never let that URL escape the provider adapter.
      throw new XtreamRequestError();
    }
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

function epgTime(value: string | number | undefined): number | null {
  if (typeof value === "number" || (typeof value === "string" && /^\d+$/.test(value.trim()))) {
    const timestamp = numberOrNull(value);
    if (timestamp === null) return null;
    // Xtream commonly reports Unix seconds, though some providers send ms.
    return timestamp < 100_000_000_000 ? timestamp * 1000 : timestamp;
  }
  if (typeof value !== "string" || !value.trim()) return null;
  const parsed = Date.parse(value.trim().replace(" ", "T"));
  return Number.isFinite(parsed) ? parsed : null;
}

function providerText(value: unknown): string {
  if (typeof value !== "string") return "";
  const text = value.trim();
  if (!text || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(text)) return text;
  try {
    const binary = atob(text);
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    const decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes).trim();
    // Avoid interpreting ordinary short words as base64 by requiring padding,
    // non-ASCII decoded text, or a sufficiently long encoded value.
    if (decoded && (text.includes("=") || /[^\x20-\x7e]/.test(decoded) || text.length >= 12)) return decoded;
  } catch {
    // Keep provider text unchanged when it is not valid encoded UTF-8.
  }
  return text;
}
