import { AsyncGunzip, Gunzip } from "fflate";

import type { LiveChannel } from "../../core/live/types.ts";
import type { EpgProgramme } from "../../core/live/types.ts";
import { parseSkyShowtimeXmltv, parseSkyShowtimeXmltvAsync } from "./skyshowtime-epg-parser.ts";

type Response = { ok: boolean; status: number; arrayBuffer(): Promise<ArrayBuffer> };
type Request = (url: string) => Promise<Response>;

/**
 * The Swedish EPGShare feed carries the Nordic linear SkyShowtime schedules.
 * It uses UTC timestamps; XMLTV offsets are parsed rather than inferred from
 * the device's locale, so Finland's daylight-saving changes stay correct.
 */
export const NORDIC_SKYSHOWTIME_EPG_URL = "https://epgshare01.online/epgshare01/epg_ripper_SE1.xml.gz";

/**
 * Tizen must fetch the public feed directly so guide availability does not
 * depend on the optional web-to-TV companion. Browsers can use that relay as a
 * CORS bridge when it is explicitly configured.
 */
export function nordicGuideSourceUrl(options: { canFetchDirectly?: boolean; isTizen?: boolean; relayUrl?: string; development: boolean }): string {
  if (options.canFetchDirectly ?? options.isTizen) return NORDIC_SKYSHOWTIME_EPG_URL;
  if (options.relayUrl) return `${options.relayUrl}/api/nordic-epg`;
  return options.development ? "/api/nordic-epg" : NORDIC_SKYSHOWTIME_EPG_URL;
}

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
      const decoded = await gunzipAsync(compressed);
      if (decoded.byteLength > MAX_DECOMPRESSED_BYTES) throw new NordicEpgRequestError();
      return await parseOffMainThread(decoded);
    } catch (error) {
      if (error instanceof NordicEpgRequestError) throw error;
      throw new NordicEpgRequestError();
    }
  }
}

function gunzipAsync(compressed: Uint8Array): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    let stream: AsyncGunzip | null = null;
    let settled = false;
    let total = 0;
    const chunks: Uint8Array[] = [];
    let fallbackStarted = false;
    let watchdog: ReturnType<typeof setTimeout> | null = null;
    async function fallback(): Promise<void> {
      if (settled || fallbackStarted) return;
      fallbackStarted = true;
      if (watchdog) clearTimeout(watchdog);
      stream?.terminate?.();
      try {
        const result = await gunzipWithYielding(compressed);
        settled = true;
        resolve(result);
      } catch (error) {
        settled = true;
        reject(error);
      }
    }

    try {
      stream = new AsyncGunzip((error, chunk, final) => {
        if (settled) return;
        if (error) { void fallback(); return; }
        if (chunk?.byteLength) {
          total += chunk.byteLength;
          if (total > MAX_DECOMPRESSED_BYTES) {
            settled = true;
            if (watchdog) clearTimeout(watchdog);
            stream?.terminate?.();
            reject(new NordicEpgRequestError());
            return;
          }
          chunks.push(chunk);
        }
        if (final) {
          settled = true;
          if (watchdog) clearTimeout(watchdog);
          resolve(joinChunks(chunks, total));
        }
      });
    } catch {
      void fallback();
      return;
    }
    watchdog = setTimeout(() => { void fallback(); }, 10_000);

    try {
      const chunkSize = 64 * 1024;
      for (let offset = 0; offset < compressed.byteLength; offset += chunkSize) {
        const end = Math.min(compressed.byteLength, offset + chunkSize);
        const copy = compressed.slice(offset, end);
        stream.push(copy, end === compressed.byteLength);
      }
    } catch {
      void fallback();
    }
  });
}

async function gunzipWithYielding(compressed: Uint8Array): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  const stream = new Gunzip((chunk, final) => {
    if (!chunk?.byteLength) return;
    total += chunk.byteLength;
    if (total > MAX_DECOMPRESSED_BYTES) throw new NordicEpgRequestError();
    chunks.push(chunk);
  });
  const chunkSize = 32 * 1024;
  for (let offset = 0; offset < compressed.byteLength; offset += chunkSize) {
    const end = Math.min(compressed.byteLength, offset + chunkSize);
    stream.push(compressed.subarray(offset, end), end === compressed.byteLength);
    if (end < compressed.byteLength) await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
  return joinChunks(chunks, total);
}

function joinChunks(chunks: Uint8Array[], length: number): Uint8Array {
  const result = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.byteLength; }
  return result;
}

function parseOffMainThread(decoded: Uint8Array): Promise<EpgProgramme[]> {
  if (typeof Worker === "undefined" || typeof Blob === "undefined" || typeof URL === "undefined" || !URL.createObjectURL) {
    return decodeAndParseAsync(decoded);
  }
  let worker: Worker;
  let objectUrl: string | null = null;
  try {
    // A function-backed Blob keeps the worker classic and self-contained. This
    // is required by Tizen 3's Chromium 47, which cannot run module workers.
    objectUrl = URL.createObjectURL(new Blob([createNordicEpgWorkerSource()], { type: "text/javascript" }));
    worker = new Worker(objectUrl);
  } catch {
    if (objectUrl) URL.revokeObjectURL(objectUrl);
    return decodeAndParseAsync(decoded);
  }
  return new Promise((resolve, reject) => {
    let settled = false;
    let watchdog: ReturnType<typeof setTimeout>;
    const cleanup = () => {
      clearTimeout(watchdog);
      worker.terminate();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
    watchdog = setTimeout(() => {
      if (settled) return;
      settled = true;
      cleanup();
      void decodeAndParseAsync(decoded).then(resolve, reject);
    }, 30_000);
    worker.onmessage = (event: MessageEvent) => {
      if (settled) return;
      settled = true;
      cleanup();
      const response = event.data as { programmes?: EpgProgramme[]; error?: boolean };
      if (response?.error || !Array.isArray(response?.programmes)) void decodeAndParseAsync(decoded).then(resolve, reject);
      else resolve(response.programmes);
    };
    worker.onerror = () => {
      if (settled) return;
      settled = true;
      cleanup();
      // Security policies and older webviews can reject Blob workers. Keep the
      // guide usable by parsing in small tasks on the UI thread.
      void decodeAndParseAsync(decoded).then(resolve, reject);
    };
    try {
      const buffer = decoded.buffer.slice(decoded.byteOffset, decoded.byteOffset + decoded.byteLength) as ArrayBuffer;
      worker.postMessage(buffer, [buffer]);
    }
    catch {
      settled = true;
      cleanup();
      void decodeAndParseAsync(decoded).then(resolve, reject);
    }
  });
}

function workerEntrypoint(parse: (xml: string) => EpgProgramme[]): void {
  const workerScope = self as unknown as { onmessage: ((event: MessageEvent<ArrayBuffer>) => void) | null; postMessage(value: unknown): void };
  workerScope.onmessage = (event) => {
    try { workerScope.postMessage({ programmes: parse(new TextDecoder().decode(new Uint8Array(event.data))) }); }
    catch { workerScope.postMessage({ error: true }); }
  };
}

export function createNordicEpgWorkerSource(): string {
  return `(${workerEntrypoint.toString()})(${parseSkyShowtimeXmltv.toString()});`;
}

async function decodeAndParseAsync(decoded: Uint8Array): Promise<EpgProgramme[]> {
  const decoder = new TextDecoder();
  const parts: string[] = [];
  const chunkSize = 256 * 1024;
  for (let offset = 0; offset < decoded.byteLength; offset += chunkSize) {
    const end = Math.min(decoded.byteLength, offset + chunkSize);
    parts.push(decoder.decode(decoded.subarray(offset, end), { stream: end < decoded.byteLength }));
    if (end < decoded.byteLength) await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
  parts.push(decoder.decode());
  return parseSkyShowtimeXmltvAsync(parts.join(""));
}

export { parseSkyShowtimeXmltv, parseSkyShowtimeXmltvAsync };

/* Parser implementations live in a separate file so synthetic fixtures can
 * exercise both worker-compatible and yielding paths without any TV data. */
