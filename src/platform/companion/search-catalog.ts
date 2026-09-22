import { normalizeTitle, searchTerms, type VodCatalogItem } from "../../core/catalog/index.ts";
import { XtreamClient, XtreamRequestError, type XtreamCategory } from "../xtream/client.ts";

export type SafeSearchRecord = {
  id: string;
  kind: "movie" | "series";
  title: string;
  searchTitle: string;
  year: number | null;
  extension: string;
  category: string;
  sourceFingerprint: string;
};

export type SearchCatalogueStorage = {
  load(sourceFingerprint: string): Promise<SafeSearchRecord[]>;
  save(sourceFingerprint: string, records: SafeSearchRecord[], savedAt: number): Promise<void>;
};

export type BrowserSearchProgress = { completed: number; total: number; category: string };
export type BrowserSearchProvider = Pick<XtreamClient, "pairingFingerprint" | "categories" | "movies" | "series">;
export type BrowserSearchOptions = {
  playlistUrl: string;
  storage?: SearchCatalogueStorage;
  /** Injection point for deterministic tests; production uses the user's web playlist. */
  providerFactory?: (playlistUrl: string) => BrowserSearchProvider | null;
};

type FetchResponse = { ok: boolean; json(): Promise<unknown> };
type Fetcher = (url: string, init?: { method?: string; cache?: RequestCache }) => Promise<FetchResponse>;

const DATABASE_NAME = "substream-companion";
const STORE_NAME = "catalogues";

/**
 * Browser-owned catalogue search. Refresh talks directly to the Xtream provider
 * configured in the web app; the TV connection and relay are not involved.
 */
export function createBrowserSearchClient(options: BrowserSearchOptions) {
  const storage = options.storage ?? new IndexedDbSearchCatalogueStorage();
  const makeProvider = options.providerFactory ?? ((playlistUrl) => XtreamClient.fromPlaylistUrl(playlistUrl));
  const provider = makeProvider(options.playlistUrl);
  const sourceFingerprint = provider?.pairingFingerprint() ?? "";

  return {
    sourceFingerprint,
    async loadCached(fingerprint = sourceFingerprint): Promise<SafeSearchRecord[]> {
      if (!isFingerprint(fingerprint)) return [];
      try {
        return (await storage.load(fingerprint)).flatMap((record) => {
          const safe = sanitizeRecord(record);
          return safe && safe.sourceFingerprint === fingerprint ? [safe] : [];
        });
      } catch { return []; }
    },
    async refresh(options: { signal?: AbortSignal; onProgress?: (progress: BrowserSearchProgress) => void } = {}): Promise<{ records: SafeSearchRecord[]; refreshedAt: number }> {
      if (!provider || !isFingerprint(sourceFingerprint)) throw new Error("Add a valid Xtream playlist in the web app to search its catalogue.");
      const { signal, onProgress } = options;
      throwIfAborted(signal);
      let categories: XtreamCategory[];
      try { categories = await provider.categories(); }
      catch (error) { throw browserProviderError(error); }
      throwIfAborted(signal);

      const uniqueCategories = categories.filter((category, index) => categories.findIndex((item) => item.contentType === category.contentType && item.id === category.id) === index);
      const records: SafeSearchRecord[] = [];
      const seen = new Set<string>();
      let next = 0;
      let completed = 0;
      const worker = async () => {
        while (true) {
          throwIfAborted(signal);
          const index = next++;
          if (index >= uniqueCategories.length) return;
          const category = uniqueCategories[index];
          if (!category) return;
          try {
            const items = category.contentType === "movie" ? await provider.movies(category.id) : await provider.series(category.id);
            for (const item of items) {
              const kind = category.contentType;
              const id = item.id.startsWith(`xtream:${kind}:`) ? item.id.slice(`xtream:${kind}:`.length) : "";
              if (!/^\d{1,20}$/.test(id)) continue;
              const key = `${kind}:${id}`;
              if (seen.has(key)) continue;
              const safe = sanitizeRecord({
                id, kind, title: item.title, year: item.year, extension: kind === "movie" ? safeExtensionFromUrl(item.streamUrl) : "mp4",
                category: category.name, sourceFingerprint,
              });
              if (safe) { seen.add(key); records.push(safe); }
            }
          } catch (error) { throw browserProviderError(error); }
          completed++;
          try { onProgress?.({ completed, total: uniqueCategories.length, category: category.name }); } catch { /* Progress reporting is optional. */ }
        }
      };
      try { await Promise.all(Array.from({ length: Math.min(4, uniqueCategories.length) }, worker)); }
      catch (error) {
        if (error instanceof Error && (error.message === "Search catalogue refresh was cancelled." || error.message.startsWith("The Xtream provider could not be reached") || error.message.startsWith("Search catalogue refresh failed"))) throw error;
        throw browserProviderError(error);
      }
      throwIfAborted(signal);
      const refreshedAt = Date.now();
      // Save only a complete catalogue. A failed category must never replace a good cache.
      try { await storage.save(sourceFingerprint, records, refreshedAt); } catch { /* The live result is still usable. */ }
      return { records, refreshedAt };
    },
  };
}

/** Browser adapter for the relay's credential-free catalogue and its offline cache. */
export function createCompanionSearchClient(options: {
  baseUrl: string;
  fetcher?: Fetcher;
  storage?: SearchCatalogueStorage;
}) {
  const baseUrl = safeBaseUrl(options.baseUrl);
  const fetcher = options.fetcher ?? ((url, init) => fetch(url, init));
  const storage = options.storage ?? new IndexedDbSearchCatalogueStorage();

  return {
    async loadCached(sourceFingerprint: string): Promise<SafeSearchRecord[]> {
      if (!isFingerprint(sourceFingerprint)) return [];
      try {
        const records = await storage.load(sourceFingerprint);
        return records.flatMap((record) => {
          const valid = sanitizeRecord(record);
          return valid && valid.sourceFingerprint === sourceFingerprint ? [valid] : [];
        });
      } catch { return []; }
    },

    async refresh(sourceFingerprint: string, sessionId: string): Promise<{ records: SafeSearchRecord[]; refreshedAt: number }> {
      if (!baseUrl || !isFingerprint(sourceFingerprint) || !isSafeSessionId(sessionId)) {
        throw new Error("Search catalogue connection is unavailable.");
      }
      const url = new URL("/api/catalogue", baseUrl);
      url.searchParams.set("sessionId", sessionId);
      url.searchParams.set("refresh", "1");
      let response: FetchResponse;
      let payload: unknown;
      try {
        response = await fetcher(url.toString(), { cache: "no-store" });
        payload = await response.json();
      } catch { throw new Error("Search catalogue refresh failed."); }
      const body = isObject(payload) ? payload : {};
      if (!response.ok || !Array.isArray(body.records)) throw new Error("Search catalogue refresh failed.");
      const records = body.records.flatMap((item) => {
        const record = sanitizeRecord(item);
        return record && record.sourceFingerprint === sourceFingerprint ? [record] : [];
      });
      const refreshedAt = typeof body.refreshedAt === "number" && Number.isFinite(body.refreshedAt) ? body.refreshedAt : Date.now();
      try { await storage.save(sourceFingerprint, records, refreshedAt); } catch { /* Cache is optional; fresh results remain usable. */ }
      return { records, refreshedAt };
    },
  };
}

export function searchSafeRecords(records: readonly SafeSearchRecord[], query: string, limit = 50): SafeSearchRecord[] {
  const terms = normalizeSearch(query).split(" ").filter(Boolean);
  if (!terms.length) return [];
  return records
    .filter((record) => terms.every((term) => record.searchTitle.includes(term)))
    .sort((left, right) => left.searchTitle.localeCompare(right.searchTitle) || left.id.localeCompare(right.id))
    .slice(0, Math.max(1, Math.min(100, Math.floor(limit))))
    .map((record) => ({ ...record }));
}

/** Makes a details candidate without introducing any provider URL or credential. */
export function toVodCatalogItem(record: SafeSearchRecord): VodCatalogItem | null {
  const safe = sanitizeRecord(record);
  if (!safe) return null;
  const normalized = normalizeTitle(safe.title);
  const item: VodCatalogItem = {
    id: `xtream:${safe.kind}:${safe.id}`,
    title: normalized.title,
    searchTitle: safe.searchTitle,
    searchTerms: searchTerms(safe.searchTitle),
    year: safe.year ?? normalized.year,
    group: safe.category,
    contentType: safe.kind,
    addedAt: 0,
    streamUrl: "",
    sourceLine: Number(safe.id),
  };
  if (safe.kind === "series") item.providerSeriesId = Number(safe.id);
  return item;
}

export class IndexedDbSearchCatalogueStorage implements SearchCatalogueStorage {
  async load(sourceFingerprint: string): Promise<SafeSearchRecord[]> {
    const database = await this.open();
    try {
      const value = await new Promise<unknown>((resolve, reject) => {
        const request = database.transaction(STORE_NAME, "readonly").objectStore(STORE_NAME).get(sourceFingerprint);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      const records = isObject(value) && Array.isArray(value.records) ? value.records : [];
      return records.flatMap((record) => { const safe = sanitizeRecord(record); return safe ? [safe] : []; });
    } finally { database.close(); }
  }

  async save(sourceFingerprint: string, records: SafeSearchRecord[], savedAt: number): Promise<void> {
    if (!isFingerprint(sourceFingerprint)) return;
    const database = await this.open();
    try {
      await new Promise<void>((resolve, reject) => {
        const transaction = database.transaction(STORE_NAME, "readwrite");
        transaction.objectStore(STORE_NAME).put({ sourceFingerprint, records, savedAt });
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error);
        transaction.onabort = () => reject(transaction.error);
      });
    } finally { database.close(); }
  }

  private open(): Promise<IDBDatabase> {
    if (typeof indexedDB === "undefined") return Promise.reject(new Error("IndexedDB unavailable"));
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(DATABASE_NAME, 1);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains(STORE_NAME)) request.result.createObjectStore(STORE_NAME, { keyPath: "sourceFingerprint" });
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }
}

function sanitizeRecord(value: unknown): SafeSearchRecord | null {
  if (!isObject(value)) return null;
  const id = typeof value.id === "string" ? value.id : "";
  const kind = value.kind;
  const title = typeof value.title === "string" ? value.title.trim().slice(0, 300) : "";
  const sourceFingerprint = typeof value.sourceFingerprint === "string" ? value.sourceFingerprint : "";
  if (!/^\d{1,20}$/.test(id) || (kind !== "movie" && kind !== "series") || !title || !isFingerprint(sourceFingerprint)) return null;
  const yearValue = value.year;
  const year = typeof yearValue === "number" && Number.isSafeInteger(yearValue) && yearValue >= 1800 && yearValue <= 2200 ? yearValue : null;
  const extension = typeof value.extension === "string" && /^[a-z0-9]{1,10}$/i.test(value.extension) ? value.extension.toLowerCase() : "mp4";
  const category = typeof value.category === "string" ? value.category.trim().slice(0, 160) : "";
  const normalized = normalizeTitle(title);
  return { id, kind, title: normalized.title, searchTitle: normalized.searchTitle, year: year ?? normalized.year, extension, category, sourceFingerprint };
}

function safeBaseUrl(value: string): string {
  try { const url = new URL(value); return url.protocol === "http:" || url.protocol === "https:" ? url.origin : ""; } catch { return ""; }
}
function isSafeSessionId(value: string): boolean { return /^[A-Za-z0-9_-]{8,160}$/.test(value); }
function isFingerprint(value: string): boolean { return /^[A-Za-z0-9_-]{3,128}$/.test(value); }
function isObject(value: unknown): value is Record<string, unknown> { return !!value && typeof value === "object" && !Array.isArray(value); }
function normalizeSearch(value: string): string { return value.normalize("NFKD").replace(/\p{Diacritic}/gu, "").toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim(); }
function safeExtensionFromUrl(value: string): string {
  try {
    const extension = new URL(value).pathname.split("/").pop()?.split(".").pop() ?? "";
    return /^[a-z0-9]{1,10}$/i.test(extension) ? extension.toLowerCase() : "mp4";
  } catch { return "mp4"; }
}
function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Error("Search catalogue refresh was cancelled.");
}
function browserProviderError(error: unknown): Error {
  if (error instanceof XtreamRequestError && error.status) return new Error(`Search catalogue refresh failed (HTTP ${error.status}).`);
  // Fetch commonly reports blocked CORS and network failures as TypeError. Never
  // pass provider URLs or raw error messages through to the UI.
  if (error instanceof TypeError) return new Error("The Xtream provider could not be reached from this browser. Check provider access and try again.");
  return new Error("Search catalogue refresh failed. Check the provider connection and try again.");
}
