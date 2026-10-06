import { MATROSKA_METADATA_LIMIT, parseMatroskaSubtitleTracks } from "../../core/subtitles/matroska.ts";
import type { EmbeddedSubtitleDiscoveryResult } from "../browser/embedded-subtitle-discovery.ts";

/** Device-local bounded binary request: no Fetch streaming APIs or server proxy. */
export function discoverTizenEmbeddedSubtitles(
  url: string,
  signal?: AbortSignal,
  createRequest: () => XMLHttpRequest = () => new XMLHttpRequest(),
): Promise<EmbeddedSubtitleDiscoveryResult> {
  if (signal?.aborted) return Promise.resolve({ status: "unavailable", tracks: [] });
  return new Promise((resolve) => {
    let request: XMLHttpRequest | undefined;
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (result: EmbeddedSubtitleDiscoveryResult, abort = false) => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      if (abort) { try { request?.abort(); } catch { /* Already closed. */ } }
      resolve(result);
    };
    const unavailable = () => finish({ status: "unavailable", tracks: [] }, true);
    const unsupported = () => finish({ status: "unsupported", tracks: [] }, true);
    const onAbort = unavailable;
    try {
      request = createRequest();
      request.open("GET", url, true);
      request.responseType = "arraybuffer";
      request.timeout = 12_000;
      request.setRequestHeader("Range", `bytes=0-${MATROSKA_METADATA_LIMIT - 1}`);
      request.onreadystatechange = () => {
        if (request?.readyState !== 2 || settled) return;
        // Reject whole-file responses before buffering; progress enforces the
        // same limit when a provider does not expose Content-Length.
        const length = Number(request.getResponseHeader("Content-Length"));
        if (Number.isFinite(length) && length > MATROSKA_METADATA_LIMIT) unsupported();
      };
      request.onprogress = (event) => {
        if (event.loaded > MATROSKA_METADATA_LIMIT || event.lengthComputable && event.total > MATROSKA_METADATA_LIMIT) unsupported();
      };
      request.onload = () => {
        if (settled || !request) return;
        if (request.status < 200 || request.status >= 300) { unavailable(); return; }
        const bytes: unknown = request.response;
        if (!(bytes instanceof ArrayBuffer) || bytes.byteLength > MATROSKA_METADATA_LIMIT) { unsupported(); return; }
        const parsed = parseMatroskaSubtitleTracks(bytes);
        finish(parsed.kind === "tracks" ? { status: "ready", tracks: parsed.tracks } : { status: "unsupported", tracks: [] });
      };
      request.onerror = unavailable;
      request.ontimeout = unavailable;
      request.onabort = () => finish({ status: "unavailable", tracks: [] });
      signal?.addEventListener("abort", onAbort);
      timer = setTimeout(unavailable, 12_000);
      request.send();
    } catch {
      // Native errors can contain the credential-bearing URL; never expose them.
      unavailable();
    }
  });
}
