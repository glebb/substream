import { providerRequestUrl } from "../provider-request.ts";

const DEFAULT_TIMEOUT_MS = 20_000;

type Request = (url: string, init: { cache: "no-store"; signal: AbortSignal }) => Promise<Response>;

export class ProviderFetchError extends Error {
  constructor(readonly status?: number) {
    super(status ? "Playlist request failed (" + status + ")" : "Playlist request failed");
    this.name = "ProviderFetchError";
  }
}

export class ProviderFetchAbortedError extends Error {
  constructor() {
    super("Playlist request was cancelled");
    this.name = "AbortError";
  }
}

/** Fetches playlist headers with a finite deadline; never exposes provider URL errors. */
export async function fetchProviderPlaylist(
  url: string,
  options: { signal?: AbortSignal; timeoutMs?: number } = {},
  request: Request = (requestUrl, init) => fetch(requestUrl, init),
): Promise<Response> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new Error("Invalid playlist request timeout");
  if (options.signal?.aborted) throw new ProviderFetchAbortedError();

  const controller = new AbortController();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let removeAbortListener = () => {};
  const cancelled = new Promise<never>((_resolve, reject) => {
    if (!options.signal) return;
    const onAbort = () => {
      controller.abort();
      reject(new ProviderFetchAbortedError());
    };
    options.signal.addEventListener("abort", onAbort, { once: true });
    removeAbortListener = () => options.signal?.removeEventListener("abort", onAbort);
  });
  const deadline = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => {
      controller.abort();
      reject(new ProviderFetchError());
    }, timeoutMs);
  });
  try {
    return await Promise.race([
      request(providerRequestUrl(url), { cache: "no-store", signal: controller.signal }),
      cancelled,
      deadline,
    ]);
  } catch (error) {
    if (error instanceof ProviderFetchError || error instanceof ProviderFetchAbortedError) throw error;
    if (options.signal?.aborted) throw new ProviderFetchAbortedError();
    // Fetch errors commonly include credential-bearing playlist URLs.
    throw new ProviderFetchError();
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
    removeAbortListener();
  }
}
