import { MATROSKA_METADATA_LIMIT, parseMatroskaSubtitleTracks, type MatroskaSubtitleTrack } from "../../core/subtitles/matroska.ts";
import { createAbortController } from "../abort-controller.ts";

export type EmbeddedSubtitleDiscoveryStatus = "pending" | "ready" | "unsupported" | "unavailable";
export interface EmbeddedSubtitleTrack extends MatroskaSubtitleTrack {}
export interface EmbeddedSubtitleDiscoveryResult { status: Exclude<EmbeddedSubtitleDiscoveryStatus, "pending">; tracks: EmbeddedSubtitleTrack[]; }
export type EmbeddedSubtitleFetcher = (url: string, init: RequestInit) => Promise<Response>;

/** Fetches bounded Matroska/WebM metadata directly from the provider. Track presence does not mean renderability. */
export async function discoverEmbeddedSubtitles(
  streamUrl: string,
  signal?: AbortSignal,
  fetcher: EmbeddedSubtitleFetcher = (url, init) => fetch(url, init),
): Promise<EmbeddedSubtitleDiscoveryResult> {
  if (signal?.aborted) return { status: "unavailable", tracks: [] };
  const controller = createAbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let removeAbort = () => {};
  let removeResultAbort = () => {};
  try {
    if (signal && controller) {
      const onAbort = () => controller.abort();
      signal.addEventListener("abort", onAbort, { once: true });
      removeAbort = () => signal.removeEventListener("abort", onAbort);
    }
    const operation = async (): Promise<EmbeddedSubtitleDiscoveryResult> => {
      const response = await fetcher(streamUrl, {
        method: "GET", headers: { Range: `bytes=0-${MATROSKA_METADATA_LIMIT - 1}` }, cache: "no-store",
        ...(controller ? { signal: controller.signal } : signal ? { signal } : {}),
      });
      if (!response.ok) return { status: "unavailable", tracks: [] };
      const contentLength = response.headers.get("content-length");
      if (!response.body && (!contentLength || !Number.isSafeInteger(Number(contentLength)) || Number(contentLength) > MATROSKA_METADATA_LIMIT)) {
        return { status: "unsupported", tracks: [] };
      }
      const bytes = await readBounded(response, MATROSKA_METADATA_LIMIT);
      if (!bytes) return { status: "unsupported", tracks: [] };
      const parsed = parseMatroskaSubtitleTracks(bytes);
      if (parsed.kind === "unsupported" || parsed.kind === "incomplete") return { status: "unsupported", tracks: [] };
      return { status: "ready", tracks: parsed.tracks };
    };
    const timeout = new Promise<EmbeddedSubtitleDiscoveryResult>((resolve) => {
      timer = setTimeout(() => { controller?.abort(); resolve({ status: "unavailable", tracks: [] }); }, 12_000);
    });
    const aborted = new Promise<EmbeddedSubtitleDiscoveryResult>((resolve) => {
      if (!signal) return;
      if (signal.aborted) { resolve({ status: "unavailable", tracks: [] }); return; }
      const onAbort = () => resolve({ status: "unavailable", tracks: [] });
      signal.addEventListener("abort", onAbort, { once: true });
      removeResultAbort = () => signal.removeEventListener("abort", onAbort);
    });
    return await Promise.race([operation(), timeout, aborted]);
  } catch {
    // Fetch exceptions can contain credential-bearing provider URLs.
    return { status: "unavailable", tracks: [] };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    removeAbort();
    removeResultAbort();
  }
}

const CACHE_KEY = "substream.embedded-subtitle-metadata";
export type EmbeddedSubtitleCacheStorage = Pick<Storage, "getItem" | "setItem">;
type CacheRecord = { savedAt: number; result: EmbeddedSubtitleDiscoveryResult };

/** Optional small device-local cache. Keys must be opaque catalog IDs/fingerprints, never stream URLs. */
export class EmbeddedSubtitleMetadataCache {
  constructor(
    private readonly storage: EmbeddedSubtitleCacheStorage | undefined = (() => { try { return globalThis.localStorage; } catch { return undefined; } })(),
    private readonly ttlMs = 24 * 60 * 60 * 1000,
    private readonly maxEntries = 200,
  ) {}
  private read(): Record<string, CacheRecord> {
    try { const value: unknown = JSON.parse(this.storage?.getItem(CACHE_KEY) ?? "{}"); return value && typeof value === "object" ? value as Record<string, CacheRecord> : {}; }
    catch { return {}; }
  }
  get(titleId: string, sourceFingerprint: string, now = Date.now()): EmbeddedSubtitleDiscoveryResult | null {
    const id = cacheId(titleId, sourceFingerprint); if (!id) return null;
    const candidate: unknown = this.read()[id];
    if (!isCacheRecord(candidate) || now < candidate.savedAt || now - candidate.savedAt > this.ttlMs) return null;
    const record = candidate;
    return record.result;
  }
  set(titleId: string, sourceFingerprint: string, result: EmbeddedSubtitleDiscoveryResult, now = Date.now()): void {
    if (!isCacheRecord({ savedAt: now, result })) return;
    const id = cacheId(titleId, sourceFingerprint); if (!id) return;
    const records = this.read(); records[id] = { savedAt: now, result };
    const keys = Object.keys(records).sort((a, b) => (records[b]?.savedAt ?? 0) - (records[a]?.savedAt ?? 0)).slice(0, Math.max(1, this.maxEntries));
    const bounded: Record<string, CacheRecord> = {};
    for (const key of keys) { const value = records[key]; if (value) bounded[key] = value; }
    try { this.storage?.setItem(CACHE_KEY, JSON.stringify(bounded)); } catch { /* optional cache */ }
  }
  clear(): void { try { this.storage?.setItem(CACHE_KEY, "{}"); } catch { /* optional cache */ } }
}

function cacheId(titleId: string, fingerprint: string): string {
  const safe = (value: string) => /^[a-zA-Z0-9._:-]{1,200}$/.test(value) ? value : "";
  const title = safe(titleId), source = safe(fingerprint);
  return title && source ? title + ":" + source : "";
}
function isCacheRecord(value: unknown): value is CacheRecord {
  if (!value || typeof value !== "object") return false;
  const record = value as Partial<CacheRecord>;
  if (!Number.isFinite(record.savedAt) || !record.result || typeof record.result !== "object") return false;
  const result = record.result as Partial<EmbeddedSubtitleDiscoveryResult>;
  // Unknown/unsupported checks can be temporary device/network limitations.
  // Never let a cached failure suppress a later successful check.
  if (result.status !== "ready") return false;
  if (!Array.isArray(result.tracks) || result.tracks.length > 128) return false;
  return result.tracks.every((track) => Boolean(track && typeof track === "object"
    && Number.isSafeInteger(track.trackNumber) && typeof track.label === "string" && track.label.length <= 512
    && typeof track.language === "string" && track.language.length <= 64
    && typeof track.codecId === "string" && track.codecId.length <= 128
    && typeof track.forced === "boolean" && typeof track.hearingImpaired === "boolean" && typeof track.default === "boolean"));
}
export const embeddedSubtitleMetadataCacheKey = CACHE_KEY;

async function readBounded(response: Response, limit: number): Promise<Uint8Array | undefined> {
  if (!response.body) {
    const buffer = await response.arrayBuffer();
    return buffer.byteLength <= limit ? new Uint8Array(buffer) : undefined;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const remaining = limit - total;
      if (value.byteLength > remaining) {
        if (remaining > 0) chunks.push(value.subarray(0, remaining));
        total = limit;
        await reader.cancel();
        break;
      }
      chunks.push(value);
      total += value.byteLength;
    }
  } finally { reader.releaseLock(); }
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.byteLength; }
  return result;
}
