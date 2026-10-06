import { describe, expect, it, vi } from "vitest";
import { discoverEmbeddedSubtitles, EmbeddedSubtitleMetadataCache } from "./embedded-subtitle-discovery.ts";
import { parseMatroskaSubtitleTracks } from "../../core/subtitles/matroska.ts";

function fixture(): Uint8Array {
  const id = (n: number) => { const out: number[] = []; do { out.unshift(n & 255); n = Math.floor(n / 256); } while (n); return out; };
  const el = (n: number, payload: number[]) => [...id(n), 0x80 | payload.length, ...payload];
  const uint = (n: number, value: number) => el(n, [value]);
  const txt = (n: number, value: string) => el(n, [...new TextEncoder().encode(value)]);
  const entry = el(0xae, [...uint(0xd7, 1), ...uint(0x83, 17), ...txt(0x86, "S_TEXT/UTF8"), ...txt(0x22b59c, "eng")]);
  const tracks = el(0x1654ae6b, entry);
  return new Uint8Array([...el(0x1a45dfa3, []), ...id(0x18538067), 0xff, ...tracks]);
}

describe("discoverEmbeddedSubtitles", () => {
  it("requests a bounded range directly at the provider with no helper routing", async () => {
    let requestedUrl = "";
    let request: RequestInit | undefined;
    const result = await discoverEmbeddedSubtitles("https://provider.invalid/movie?token=synthetic", undefined, async (url, init) => {
      requestedUrl = url; request = init;
      return new Response(fixture().buffer as ArrayBuffer, { status: 206 });
    });
    expect(requestedUrl).toBe("https://provider.invalid/movie?token=synthetic");
    expect(request?.headers).toEqual({ Range: "bytes=0-1048575" });
    expect(request?.method).toBe("GET");
    expect(request?.body).toBeUndefined();
    expect(result).toEqual({ status: "ready", tracks: [{
      trackNumber: 1, label: "", language: "eng", codecId: "S_TEXT/UTF8", forced: false, hearingImpaired: false, default: false,
    }] });
  });
  it("does not read a response exceeding the prefix bound", async () => {
    const result = await discoverEmbeddedSubtitles("https://provider.invalid/x", undefined, async () => new Response(new ReadableStream({
      start(controller) { controller.enqueue(new Uint8Array(1024 * 1024)); controller.enqueue(new Uint8Array([1])); controller.close(); },
    }), { status: 200 }));
    expect(result.status).toBe("unsupported");
  });
  it("handles aborts and provider failures without exposing request URLs", async () => {
    const controller = new AbortController(); controller.abort();
    expect(await discoverEmbeddedSubtitles("https://provider.invalid/secret?token=x", controller.signal, vi.fn())).toEqual({ status: "unavailable", tracks: [] });
    expect(await discoverEmbeddedSubtitles("https://provider.invalid/secret?token=x", undefined, async () => { throw new Error("secret URL"); })).toEqual({ status: "unavailable", tracks: [] });
  });
  it("cancels a pending provider fetch when the caller aborts", async () => {
    const controller = new AbortController();
    const call = discoverEmbeddedSubtitles("https://provider.invalid/x", controller.signal, (_url, init) => new Promise((_resolve, reject) => {
      init.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    }));
    controller.abort();
    expect(await call).toEqual({ status: "unavailable", tracks: [] });
  });
  it("returns unsupported for non-Matroska media", async () => {
    const result = await discoverEmbeddedSubtitles("https://provider.invalid/movie.mp4", undefined, async () => new Response(new Uint8Array([0, 0, 0, 1]), { status: 206 }));
    expect(result.status).toBe("unsupported");
    expect(parseMatroskaSubtitleTracks(new Uint8Array([0, 0, 0, 1])).kind).toBe("unsupported");
  });
  it("caches metadata by opaque title and source identity, never by a stream URL", () => {
    const values = new Map<string, string>();
    const cache = new EmbeddedSubtitleMetadataCache({ getItem: (key) => values.get(key) ?? null, setItem: (key, value) => { values.set(key, value); } });
    const result = { status: "ready" as const, tracks: [] };
    cache.set("movie-42", "vod_abc", result, 100);
    expect(cache.get("movie-42", "vod_abc", 101)).toEqual(result);
    expect(cache.get("movie-42", "vod_other", 101)).toBeNull();
    expect([...values.values()][0]).not.toContain("https://");
    cache.set("https://provider.invalid/movie?token=secret", "vod_abc", result, 100);
    expect([...values.values()][0]).not.toContain("secret");
  });
  it("does not retain unsupported checks or reuse older cached failures", () => {
    const values = new Map<string, string>();
    const cache = new EmbeddedSubtitleMetadataCache({ getItem: (key) => values.get(key) ?? null, setItem: (key, value) => { values.set(key, value); } });
    cache.set("movie-42", "media", { status: "unsupported", tracks: [] }, 100);
    expect(cache.get("movie-42", "media", 101)).toBeNull();
    values.set("substream.embedded-subtitle-metadata", JSON.stringify({ "movie-42:media": { savedAt: 100, result: { status: "unsupported", tracks: [] } } }));
    expect(cache.get("movie-42", "media", 101)).toBeNull();
  });

  it("ignores corrupt cache records and expires old metadata", () => {
    const values = new Map<string, string>();
    const cache = new EmbeddedSubtitleMetadataCache({ getItem: (key) => values.get(key) ?? null, setItem: (key, value) => { values.set(key, value); } }, 100);
    values.set("substream.embedded-subtitle-metadata", JSON.stringify({ "movie-42:vod_abc": { savedAt: 99 } }));
    expect(cache.get("movie-42", "vod_abc", 100)).toBeNull();
    cache.set("movie-42", "vod_abc", { status: "ready", tracks: [] }, 100);
    expect(cache.get("movie-42", "vod_abc", 201)).toBeNull();
    values.set("substream.embedded-subtitle-metadata", "{bad-json");
    expect(cache.get("movie-42", "vod_abc", 101)).toBeNull();
  });
});
