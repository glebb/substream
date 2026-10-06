const MAX_CACHED_BYTES = 2 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 15_000;

export class VodRangeSourceError extends Error {
  constructor(readonly reason: "request" | "redirect" | "timeout" | "status" | "metadata" | "range" | "size" | "disposed") {
    const messages: Record<VodRangeSourceError["reason"], string> = {
      request: "Video range request failed",
      redirect: "Video provider redirected the media request",
      timeout: "Video provider range request timed out",
      status: "Video provider does not support byte ranges",
      metadata: "Video provider range metadata is missing or hidden",
      range: "Video provider returned an invalid byte range",
      size: "Video range request exceeds the 2 MiB limit",
      disposed: "Video range source has been disposed",
    };
    super(messages[reason]);
    this.name = "VodRangeSourceError";
  }
}

export class VodRangeSourceAbortedError extends Error {
  constructor() {
    super("Video range request was cancelled");
    this.name = "AbortError";
  }
}

type RangeRequest = typeof fetch;
type CacheEntry = { start: number; end: number; bytes: Uint8Array };

/** Reads bounded byte ranges directly from a provider URL without exposing request errors or URLs. */
export class VodRangeSource {
  private readonly request: RangeRequest;
  private cache: CacheEntry | undefined;
  private size?: number;
  private disposed = false;
  private activeController: AbortController | undefined;
  private removeExternalAbort = () => {};
  private cancelActive: (() => void) | undefined;
  private readQueue: Promise<void> = Promise.resolve();

  constructor(
    private readonly url: string,
    private readonly options: { signal?: AbortSignal; request?: typeof fetch } = {},
  ) {
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error("protocol");
    } catch {
      throw new VodRangeSourceError("request");
    }
    this.request = options.request ?? fetch.bind(globalThis);
  }

  async read(start: number, end: number): Promise<Uint8Array> {
    const predecessor = this.readQueue;
    let unlock!: () => void;
    this.readQueue = new Promise<void>((resolve) => { unlock = resolve; });
    await predecessor;
    try {
      this.assertUsable();
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start) {
        throw new VodRangeSourceError("range");
      }
      if (end === start) return new Uint8Array(0);
      if (end - start > MAX_CACHED_BYTES) throw new VodRangeSourceError("size");
      if (this.size !== undefined) {
        if (start >= this.size) return new Uint8Array(0);
        end = Math.min(end, this.size);
      }
      const cached = this.cache;
      if (cached && start >= cached.start && end <= cached.end) {
        return cached.bytes.slice(start - cached.start, end - cached.start);
      }

      const result = await this.fetchRange(start, end);
      this.assertUsable();
      this.size = result.total;
      this.cache = { start: result.start, end: result.start + result.bytes.length, bytes: result.bytes };
      if (start >= result.start + result.bytes.length) return new Uint8Array(0);
      return result.bytes.slice(start - result.start, Math.min(end, result.start + result.bytes.length) - result.start);
    } finally {
      unlock();
    }
  }

  async getSize(): Promise<number> {
    this.assertUsable();
    if (this.size !== undefined) return this.size;
    await this.read(0, 1);
    this.assertUsable();
    if (this.size === undefined) throw new VodRangeSourceError("range");
    return this.size;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.activeController?.abort();
    this.cancelActive?.();
    this.removeExternalAbort();
    this.cache = undefined;
  }

  private assertUsable(): void {
    if (this.disposed) throw new VodRangeSourceError("disposed");
    if (this.options.signal?.aborted) throw new VodRangeSourceAbortedError();
  }

  private async fetchRange(start: number, requestedEnd: number): Promise<{ start: number; bytes: Uint8Array; total: number }> {
    const controller = typeof AbortController === "function" ? new AbortController() : undefined;
    this.activeController = controller;
    const init: RequestInit = {
      method: "GET",
      headers: { Range: `bytes=${start}-${requestedEnd - 1}` },
      credentials: "omit",
      referrerPolicy: "no-referrer",
      cache: "no-store",
      redirect: "follow",
      ...(controller ? { signal: controller.signal } : {}),
    };
    let rejectCancelled!: (error: Error) => void;
    const cancelled = new Promise<never>((_resolve, reject) => { rejectCancelled = reject; });
    const timeout = setTimeout(() => {
      controller?.abort();
      rejectCancelled(new VodRangeSourceError("timeout"));
    }, REQUEST_TIMEOUT_MS);
    const onExternalAbort = () => {
      controller?.abort();
      rejectCancelled(new VodRangeSourceAbortedError());
    };
    this.cancelActive = () => rejectCancelled(this.disposed ? new VodRangeSourceError("disposed") : new VodRangeSourceAbortedError());
    this.options.signal?.addEventListener("abort", onExternalAbort, { once: true });
    this.removeExternalAbort = () => this.options.signal?.removeEventListener("abort", onExternalAbort);
    try {
      if (this.options.signal?.aborted) throw new VodRangeSourceAbortedError();
      const response = await Promise.race([this.request(this.url, init), cancelled]);
      this.assertUsable();
      if (response.type === "opaqueredirect" || (response.status >= 300 && response.status < 400)) {
        await cancelBody(response);
        throw new VodRangeSourceError("redirect");
      }
      if (response.status !== 206) {
        await cancelBody(response);
        throw new VodRangeSourceError("status");
      }
      const contentRange = response.headers.get("content-range");
      let parsed = parseContentRange(contentRange);
      if (contentRange === null) {
        try {
          let total = this.size;
          if (total === undefined) {
            // Content-Length is CORS-safelisted; Content-Range is not. A HEAD
            // request can discover the whole-file size without downloading it.
            const { headers: _rangeHeaders, ...headInit } = init;
            // Some media gateways reject HEAD. In that case, obtain the
            // whole-file headers with GET and cancel its body immediately.
            for (const method of ["HEAD", "GET"] as const) {
              try {
                const probe = await Promise.race([this.request(this.url, { ...headInit, method }), cancelled]);
                const length = probe.headers.get("content-length");
                const probeSize = length && /^\d+$/.test(length) ? Number(length) : NaN;
                const type = probe.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase();
                await cancelBody(probe);
                if (probe.status === 200 && Number.isSafeInteger(probeSize) && probeSize > 0
                  && type !== "text/html" && type !== "application/json") {
                  total = probeSize;
                  break;
                }
              } catch (error) {
                this.assertUsable();
                if (controller?.signal.aborted) throw new VodRangeSourceError("timeout");
                if (error instanceof VodRangeSourceError || error instanceof VodRangeSourceAbortedError) throw error;
                // Browser network errors expose no safe response details.
                // Try the header-only GET before reporting missing metadata.
              }
            }
            if (total === undefined) throw new VodRangeSourceError("metadata");
          }
          if (start >= total) throw new VodRangeSourceError("range");
          parsed = { start, end: Math.min(requestedEnd, total) - 1, total };
          const partialLength = response.headers.get("content-length");
          if (partialLength !== null && (!/^\d+$/.test(partialLength) || Number(partialLength) !== parsed.end - start + 1)) {
            throw new VodRangeSourceError("range");
          }
        } catch (error) {
          await cancelBody(response);
          throw error;
        }
      }
      if (!parsed || parsed.start !== start || parsed.end > requestedEnd - 1
        || (parsed.end < requestedEnd - 1 && parsed.end + 1 !== parsed.total)) {
        await cancelBody(response);
        throw new VodRangeSourceError("range");
      }
      const expectedLength = parsed.end - parsed.start + 1;
      if (expectedLength > MAX_CACHED_BYTES) {
        await cancelBody(response);
        throw new VodRangeSourceError("size");
      }
      const bytes = await Promise.race([readBoundedBody(response, expectedLength), cancelled]);
      this.assertUsable();
      return { start: parsed.start, bytes, total: parsed.total };
    } catch (error) {
      if (error instanceof VodRangeSourceError || error instanceof VodRangeSourceAbortedError) throw error;
      if (this.disposed) throw new VodRangeSourceError("disposed");
      if (this.options.signal?.aborted) throw new VodRangeSourceAbortedError();
      throw new VodRangeSourceError("request");
    } finally {
      this.removeExternalAbort();
      clearTimeout(timeout);
      this.removeExternalAbort = () => {};
      this.cancelActive = undefined;
      this.activeController = undefined;
    }
  }
}

function parseContentRange(value: string | null): { start: number; end: number; total: number } | undefined {
  const match = value?.trim().match(/^bytes (\d+)-(\d+)\/(\d+)$/i);
  if (!match) return undefined;
  const start = Number(match[1]);
  const end = Number(match[2]);
  const total = Number(match[3]);
  if (![start, end, total].every(Number.isSafeInteger) || start < 0 || end < start || total <= end) return undefined;
  return { start, end, total };
}

async function readBoundedBody(response: Response, expectedLength: number): Promise<Uint8Array> {
  const reader = response.body?.getReader();
  if (!reader) throw new VodRangeSourceError("range");
  const chunks: Uint8Array[] = [];
  let received = 0;
  let completed = false;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) { completed = true; break; }
      if (!value) continue;
      received += value.byteLength;
      if (received > expectedLength || received > MAX_CACHED_BYTES) throw new VodRangeSourceError("range");
      chunks.push(value);
    }
    if (received !== expectedLength) throw new VodRangeSourceError("range");
    const bytes = new Uint8Array(received);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return bytes;
  } finally {
    if (!completed) {
      try { await reader.cancel(); } catch { /* preserve the original safe error */ }
    }
    reader.releaseLock();
  }
}

async function cancelBody(response: Response): Promise<void> {
  try { await response.body?.cancel(); } catch { /* response is rejected regardless */ }
}
