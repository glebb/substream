import { gunzipSync } from "fflate";

import type { LiveChannel } from "../../core/live/types.ts";
import type { EpgProgramme } from "../../core/live/types.ts";

type Response = { ok: boolean; status: number; arrayBuffer(): Promise<ArrayBuffer> };
type Request = (url: string) => Promise<Response>;

/**
 * The Swedish EPGShare feed carries the Nordic linear SkyShowtime schedules.
 * It uses UTC timestamps; XMLTV offsets are parsed rather than inferred from
 * the device's locale, so Finland's daylight-saving changes stay correct.
 */
export const NORDIC_SKYSHOWTIME_EPG_URL = "https://epgshare01.online/epgshare01/epg_ripper_SE1.xml.gz";

const SKYSHOWTIME_XMLTV_IDS: Record<string, string> = {
  "skyshowtime1.se": "[SKYS1SV].SkyShowtime.1.se",
  "skyshowtime2.se": "[SKYS2SV].SkyShowtime.2.se",
};
const MAX_COMPRESSED_BYTES = 8 * 1024 * 1024;
const MAX_DECOMPRESSED_BYTES = 32 * 1024 * 1024;

export class NordicEpgRequestError extends Error {
  constructor(readonly status?: number) {
    super(status ? `Nordic EPG request failed (${status})` : "Nordic EPG request failed");
  }
}

/** Maps only the Finnish provider entries to their matching Nordic XMLTV IDs. */
export function skyShowtimeNordicXmltvId(channel: Pick<LiveChannel, "country" | "epgId" | "name">): string | null {
  if (channel.country !== "finland") return null;
  const key = channel.epgId?.trim().toLocaleLowerCase().replace(/\s+/g, "");
  if (key && SKYSHOWTIME_XMLTV_IDS[key]) return SKYSHOWTIME_XMLTV_IDS[key];
  // Older saved channel records can predate provider EPG IDs. Keep this name
  // fallback narrow enough that it cannot apply a Nordic schedule elsewhere.
  const name = channel.name.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLocaleLowerCase()
    .replace(/\[[^\]]*\]/g, " ").replace(/\b(?:fhd|uhd|hd|sd)\b/g, " ").replace(/[^a-z0-9]+/g, " ").trim();
  const match = /^fi sky showtime ([12])$/.exec(name);
  return match ? SKYSHOWTIME_XMLTV_IDS[`skyshowtime${match[1]}.se`] ?? null : null;
}

/** Browser/Tizen adapter for the public compressed XMLTV feed. */
export class NordicSkyShowtimeEpgClient {
  private programmesPromise: Promise<EpgProgramme[]> | null = null;

  constructor(
    private readonly request: Request = (url) => fetch(url),
    private readonly sourceUrl = NORDIC_SKYSHOWTIME_EPG_URL,
  ) {}

  async schedule(xmltvId: string, outputChannelId: string): Promise<EpgProgramme[]> {
    if (!Object.values(SKYSHOWTIME_XMLTV_IDS).includes(xmltvId)) throw new Error("Unsupported Nordic EPG channel");
    if (!outputChannelId.trim()) throw new Error("A channel identifier is required");
    const programmes = await this.load();
    return programmes
      .filter((programme) => programme.channelId === xmltvId)
      .map((programme) => ({ ...programme, channelId: outputChannelId }));
  }

  private load(): Promise<EpgProgramme[]> {
    if (!this.programmesPromise) this.programmesPromise = this.fetchProgrammes();
    return this.programmesPromise;
  }

  private async fetchProgrammes(): Promise<EpgProgramme[]> {
    try {
      const response = await this.request(this.sourceUrl);
      if (!response.ok) throw new NordicEpgRequestError(response.status);
      const compressed = new Uint8Array(await response.arrayBuffer());
      if (compressed.byteLength > MAX_COMPRESSED_BYTES) throw new NordicEpgRequestError();
      const decoded = gunzipSync(compressed);
      if (decoded.byteLength > MAX_DECOMPRESSED_BYTES) throw new NordicEpgRequestError();
      return parseSkyShowtimeXmltv(new TextDecoder().decode(decoded));
    } catch (error) {
      if (error instanceof NordicEpgRequestError) throw error;
      throw new NordicEpgRequestError();
    }
  }
}

function parseSkyShowtimeXmltv(xml: string): EpgProgramme[] {
  const programmes: EpgProgramme[] = [];
  const supported = new Set(Object.values(SKYSHOWTIME_XMLTV_IDS));
  for (const match of xml.matchAll(/<programme\b([^>]*)>([\s\S]*?)<\/programme>/g)) {
    const attributes = match[1] ?? "";
    const body = match[2] ?? "";
    const channelId = attribute(attributes, "channel");
    const startTime = xmltvTime(attribute(attributes, "start"));
    const endTime = xmltvTime(attribute(attributes, "stop"));
    const title = elementText(body, "title");
    if (!channelId || !supported.has(channelId) || startTime === null || endTime === null || endTime <= startTime || !title) continue;
    const description = elementText(body, "desc");
    programmes.push({ channelId, title, startTime, endTime, ...(description ? { description } : {}) });
  }
  return programmes.sort((left, right) => left.startTime - right.startTime || left.endTime - right.endTime);
}

function attribute(source: string, name: string): string {
  return new RegExp(`\\b${name}="([^"]*)"`, "i").exec(source)?.[1] ?? "";
}

function elementText(source: string, name: string): string {
  const raw = new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)<\\/${name}>`, "i").exec(source)?.[1] ?? "";
  return decodeXml(raw.replace(/<[^>]+>/g, "")).trim();
}

function decodeXml(value: string): string {
  return value.replace(/&(?:amp|lt|gt|quot|apos);/g, (entity) => ({ "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&apos;": "'" })[entity] ?? entity);
}

function xmltvTime(value: string): number | null {
  const match = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})\s+([+-])(\d{2})(\d{2})$/.exec(value.trim());
  if (!match) return null;
  const [, year, month, day, hour, minute, second, sign, offsetHour, offsetMinute] = match;
  const utc = Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second));
  const offset = (Number(offsetHour) * 60 + Number(offsetMinute)) * 60_000;
  return Number.isFinite(utc) ? utc + (sign === "+" ? -offset : offset) : null;
}
