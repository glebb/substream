const DEFAULT_BASE_URL = "https://api.opensubtitles.com/api/v1";

export class OpenSubtitlesRequestError extends Error {
  constructor(readonly status?: number) {
    super(status ? "OpenSubtitles request failed (" + status + ")" : "OpenSubtitles network request failed");
  }
}

export type SubtitleSearch = {
  query?: string;
  languages: string[];
  year?: number;
  season?: number;
  episode?: number;
  parentFeatureId?: number;
  type?: "movie" | "episode";
};

export type SeriesFeature = {
  id: number;
  title: string;
  year: number | null;
};

export type SubtitleResult = {
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

export type SubtitleDownload = {
  fileName: string;
  link: string;
};

export type HttpResponse = {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
  text(): Promise<string>;
};

export type HttpRequest = (url: string, init: RequestInit) => Promise<HttpResponse>;

type SearchResponse = {
  data?: Array<{
    id?: string;
    attributes?: {
      language?: string;
      release?: string;
      hearing_impaired?: boolean;
      download_count?: number;
      files?: Array<{ file_id?: number; file_name?: string }>;
      feature_details?: {
        feature_type?: string;
        title?: string;
        movie_name?: string;
        year?: number | string | null;
        parent_feature_id?: number;
        season_number?: number;
        episode_number?: number;
      };
    };
  }>;
};

export class OpenSubtitlesClient {
  private readonly request: HttpRequest;

  constructor(
    private readonly apiKey: string,
    request?: HttpRequest,
    private baseUrl = DEFAULT_BASE_URL,
  ) {
    this.request = request ?? ((url, init) => fetch(url, init));
  }

  async search(input: SubtitleSearch): Promise<SubtitleResult[]> {
    const searchParams = new URLSearchParams();
    const parameters: Record<string, string | undefined> = {
      episode_number: input.episode?.toString(),
      languages: input.languages.join(","),
      parent_feature_id: input.parentFeatureId?.toString(),
      query: input.query?.toLowerCase(),
      season_number: input.season?.toString(),
      type: input.type,
      year: input.year?.toString(),
    };
    for (const key of Object.keys(parameters).sort()) {
      const value = parameters[key];
      if (value) searchParams.set(key, value);
    }

    const response = await this.request(this.baseUrl + "/subtitles?" + searchParams.toString(), {
      headers: { Accept: "application/json", "Api-Key": this.apiKey },
      method: "GET",
    });
    if (!response.ok) throw new OpenSubtitlesRequestError(response.status);

    const payload = await response.json() as SearchResponse;
    return (payload.data ?? []).flatMap((item) => {
      const attributes = item.attributes;
      const file = attributes?.files?.[0];
      if (!item.id || !attributes?.language || !file?.file_id || !file.file_name) return [];
      const feature = attributes.feature_details;
      if (input.parentFeatureId !== undefined && feature?.parent_feature_id !== undefined
        && feature.parent_feature_id !== input.parentFeatureId) return [];
      if (input.season !== undefined && feature?.season_number !== undefined && feature.season_number !== input.season) return [];
      if (input.episode !== undefined && feature?.episode_number !== undefined && feature.episode_number !== input.episode) return [];
      const featureYear = feature?.year == null ? null : Number(feature.year);
      return [{
        id: item.id,
        language: attributes.language,
        releaseName: attributes.release ?? file.file_name,
        fileId: file.file_id,
        fileName: file.file_name,
        hearingImpaired: attributes.hearing_impaired ?? false,
        downloads: attributes.download_count ?? 0,
        ...(feature?.feature_type ? { featureType: feature.feature_type } : {}),
        ...(feature?.title || feature?.movie_name ? { featureTitle: feature.title ?? feature.movie_name } : {}),
        ...(feature?.year !== undefined ? { featureYear: Number.isSafeInteger(featureYear) ? featureYear : null } : {}),
        ...(feature?.parent_feature_id !== undefined ? { parentFeatureId: feature.parent_feature_id } : {}),
        ...(feature?.season_number !== undefined ? { season: feature.season_number } : {}),
        ...(feature?.episode_number !== undefined ? { episode: feature.episode_number } : {}),
      }];
    });
  }

  async findSeriesFeature(query: string, year: number | null): Promise<SeriesFeature | null> {
    const parameters = new URLSearchParams({ query: query.toLowerCase() });
    if (year !== null) parameters.set("year", year.toString());
    const response = await this.request(this.baseUrl + "/features?" + parameters.toString(), {
      headers: { Accept: "application/json", "Api-Key": this.apiKey },
      method: "GET",
    });
    if (!response.ok) throw new OpenSubtitlesRequestError(response.status);
    const payload = await response.json() as {
      data?: Array<{ attributes?: { feature_id?: number | string; feature_type?: string; title?: string; year?: number | string } }>;
    };
    const normalizedQuery = query.toLocaleLowerCase();
    for (const item of payload.data ?? []) {
      const feature = item.attributes;
      const id = Number(feature?.feature_id);
      if (!Number.isSafeInteger(id) || feature?.feature_type?.toLocaleLowerCase() !== "tvshow") continue;
      if (feature.title?.toLocaleLowerCase() !== normalizedQuery) continue;
      const featureYear = feature.year === undefined ? null : Number(feature.year);
      if (year !== null && featureYear !== year) continue;
      return { id, title: feature.title, year: Number.isSafeInteger(featureYear) ? featureYear : null };
    }
    return null;
  }

  async login(username: string, password: string): Promise<string> {
    const response = await this.request(this.baseUrl + "/login", {
      body: JSON.stringify({ password, username }),
      headers: {
        Accept: "application/json",
        "Api-Key": this.apiKey,
        "Content-Type": "application/json",
      },
      method: "POST",
    });
    if (!response.ok) throw new OpenSubtitlesRequestError(response.status);
    const payload = await response.json() as { base_url?: string; token?: string };
    if (!payload.token) throw new OpenSubtitlesRequestError();
    if (payload.base_url) {
      const origin = payload.base_url.startsWith("http") ? payload.base_url : "https://" + payload.base_url;
      this.baseUrl = origin.replace(/\/$/, "").replace(/\/api\/v1$/, "") + "/api/v1";
    }
    return payload.token;
  }

  async download(fileId: number, accessToken?: string): Promise<SubtitleDownload> {
    const headers: Record<string, string> = {
      Accept: "application/json",
      "Api-Key": this.apiKey,
      "Content-Type": "application/json",
    };
    if (accessToken) headers.Authorization = "Bearer " + accessToken;
    const response = await this.request(this.baseUrl + "/download", {
      body: JSON.stringify({ file_id: fileId, sub_format: "srt" }),
      headers,
      method: "POST",
    });
    if (!response.ok) throw new OpenSubtitlesRequestError(response.status);
    const payload = await response.json() as { file_name?: string; link?: string };
    if (!payload.file_name || !payload.link) throw new OpenSubtitlesRequestError();
    return { fileName: payload.file_name, link: payload.link };
  }

  async fetchSubtitleText(downloadUrl: string): Promise<string> {
    const response = await this.request(downloadUrl, { method: "GET" });
    if (!response.ok) throw new OpenSubtitlesRequestError(response.status);
    return response.text();
  }
}
