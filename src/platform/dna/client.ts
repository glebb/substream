import type { DnaChannel } from "../../core/live/dna.ts";
import type { EpgProgramme } from "../../core/live/types.ts";

type Response = { ok: boolean; status: number; json(): Promise<unknown> };
type Request = (url: string) => Promise<Response>;
const BASE = "https://mts-pro-envoy-vip.dna.fi/hbx/api/pub/xrtv/g/media";
const GENERIC_LOGO = "https://www.dna.fi/o/dna-fi-theme/images/dna/dna_logo.png";
const CATALOG_TTL = 6 * 60 * 60 * 1000;

export class DnaRequestError extends Error {
  constructor(readonly status?: number) {
    super(status ? `DNA guide request failed (${status})` : "DNA guide request failed");
  }
}

/** Public DNA Finland channel catalog and programme guide adapter. */
export class DnaGuideClient {
  private catalogCache: { savedAt: number; channels: DnaChannel[] } | null = null;

  constructor(private readonly request: Request = (url) => fetch(url)) {}

  async channels(): Promise<DnaChannel[]> {
    if (this.catalogCache && Date.now() - this.catalogCache.savedAt < CATALOG_TTL) return this.catalogCache.channels;
    const url = new URL(BASE);
    url.searchParams.set("q", "profile:ch");
    url.searchParams.set("limit", "1000");
    const payload = await this.get(url);
    const embedded = object(payload)._embedded;
    const records = object(embedded)["xrtv:media-item"];
    const channels = Array.isArray(records) ? records.flatMap((value): DnaChannel[] => {
      const record = object(value);
      const name = text(record.name);
      const id = text(record.datalistTerm);
      if (!name || !/^ch-[a-z0-9-]+$/i.test(id)) return [];
      const imageRecords = object(record._embedded)["xrtv:image"];
      const image = Array.isArray(imageRecords) ? object(imageRecords[0]) : {};
      const src = text(image.src);
      const logo = safeImageUrl(src);
      return [{ id, name, logo: logo && logo !== GENERIC_LOGO ? logo : null }];
    }) : [];
    this.catalogCache = { savedAt: Date.now(), channels };
    return channels;
  }

  async schedule(channelId: string, startTime = Date.now() - 6 * 60 * 60 * 1000, endTime = startTime + 24 * 60 * 60 * 1000): Promise<EpgProgramme[]> {
    if (!/^ch-[a-z0-9-]+$/i.test(channelId)) throw new Error("Invalid DNA channel identifier");
    if (!Number.isFinite(startTime) || !Number.isFinite(endTime) || endTime <= startTime || endTime - startTime > 48 * 60 * 60 * 1000) {
      throw new Error("Invalid DNA guide interval");
    }
    const url = new URL(BASE);
    url.searchParams.append("q", `channel:${channelId}`);
    url.searchParams.append("q", "profile:pr");
    url.searchParams.append("q", `start-interval:${Math.floor(startTime)}/${Math.floor(endTime)}`);
    url.searchParams.set("view", "web-aggregated");
    url.searchParams.set("limit", "100");
    const payload = await this.get(url);
    const records = object(object(payload)._embedded)["xrtv:media-item"];
    return (Array.isArray(records) ? records : []).flatMap((value): EpgProgramme[] => {
      const record = object(value);
      const metadata = object(object(record._embedded)["xrtv:meta"]);
      const data = object(metadata.data);
      const start = finite(data.start);
      const end = finite(data.end);
      const title = localizedText(data.title);
      if (start === null || end === null || end <= start || !title) return [];
      const description = localizedText(data.description);
      return [{ channelId, title, startTime: start, endTime: end, ...(description ? { description } : {}) }];
    }).sort((a, b) => a.startTime - b.startTime || a.endTime - b.endTime);
  }

  private async get(url: URL): Promise<unknown> {
    try {
      const response = await this.request(url.toString());
      if (!response.ok) throw new DnaRequestError(response.status);
      return await response.json();
    } catch (error) {
      if (error instanceof DnaRequestError) throw error;
      throw new DnaRequestError();
    }
  }
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function text(value: unknown): string { return typeof value === "string" ? value.trim() : ""; }
function localizedText(value: unknown): string {
  if (typeof value === "string") return value.trim();
  return text(object(value).value);
}
function finite(value: unknown): number | null {
  const result = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(result) && result > 0 ? result : null;
}
function safeImageUrl(value: string): string | null {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && (url.hostname === "www.dna.fi" || url.hostname.endsWith(".dna.fi")) ? url.toString() : null;
  } catch { return null; }
}
