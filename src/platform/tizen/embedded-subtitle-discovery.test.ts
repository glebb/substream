import { describe, expect, it, vi } from "vitest";
import { discoverTizenEmbeddedSubtitles } from "./embedded-subtitle-discovery.ts";
import { MATROSKA_METADATA_LIMIT } from "../../core/subtitles/matroska.ts";

function fixture(): ArrayBuffer {
  const id = (n: number) => { const out: number[] = []; do { out.unshift(n & 255); n = Math.floor(n / 256); } while (n); return out; };
  const el = (n: number, payload: number[]) => [...id(n), 0x80 | payload.length, ...payload];
  const txt = (n: number, value: string) => el(n, [...new TextEncoder().encode(value)]);
  const tracks = el(0x1654ae6b, el(0xae, [...el(0xd7, [1]), ...el(0x83, [17]), ...txt(0x86, "S_TEXT/UTF8"), ...txt(0x22b59c, "fin")]));
  return new Uint8Array([...el(0x1a45dfa3, []), ...id(0x18538067), 0xff, ...tracks]).buffer;
}
function request() {
  return {
    open: vi.fn(), setRequestHeader: vi.fn(), send: vi.fn(), abort: vi.fn(),
    getResponseHeader: vi.fn(() => null as string | null), readyState: 0, status: 206, response: fixture(),
    responseType: "", timeout: 0, onreadystatechange: null as null | (() => void),
    onprogress: null as null | ((event: { loaded: number; total: number; lengthComputable: boolean }) => void),
    onload: null as null | (() => void), onerror: null as null | (() => void),
    ontimeout: null as null | (() => void), onabort: null as null | (() => void),
  };
}

describe("Tizen embedded subtitle discovery", () => {
  it("reads bounded binary metadata directly from its provider without streaming Fetch or exposed length headers", async () => {
    const xhr = request();
    const result = discoverTizenEmbeddedSubtitles("https://provider.invalid/movie?token=synthetic", undefined, () => xhr as unknown as XMLHttpRequest);
    expect(xhr.open).toHaveBeenCalledExactlyOnceWith("GET", "https://provider.invalid/movie?token=synthetic", true);
    expect(xhr.setRequestHeader.mock.calls).toEqual([["Range", "bytes=0-1048575"]]);
    expect(xhr.responseType).toBe("arraybuffer");
    expect(xhr.send).toHaveBeenCalledWith();
    xhr.onload?.();
    expect(await result).toMatchObject({ status: "ready", tracks: [{ language: "fin", codecId: "S_TEXT/UTF8" }] });
  });
  it.each(["headers", "progress", "body"])("rejects an oversized response at %s", async (stage) => {
    const xhr = request();
    const result = discoverTizenEmbeddedSubtitles("https://provider.invalid/movie", undefined, () => xhr as unknown as XMLHttpRequest);
    if (stage === "headers") {
      xhr.readyState = 2; xhr.getResponseHeader.mockReturnValue(String(MATROSKA_METADATA_LIMIT + 1)); xhr.onreadystatechange?.();
    } else if (stage === "progress") xhr.onprogress?.({ loaded: MATROSKA_METADATA_LIMIT + 1, total: 0, lengthComputable: false });
    else { xhr.response = new ArrayBuffer(MATROSKA_METADATA_LIMIT + 1); xhr.onload?.(); }
    expect(await result).toEqual({ status: "unsupported", tracks: [] });
    expect(xhr.abort).toHaveBeenCalledOnce();
  });
  it("aborts on cancellation and ignores late success", async () => {
    const xhr = request(), controller = new AbortController();
    const result = discoverTizenEmbeddedSubtitles("https://provider.invalid/movie", controller.signal, () => xhr as unknown as XMLHttpRequest);
    controller.abort(); xhr.onload?.();
    expect(await result).toEqual({ status: "unavailable", tracks: [] });
    expect(xhr.abort).toHaveBeenCalledOnce();
  });
  it("bounds a stalled request and sanitizes network failures", async () => {
    vi.useFakeTimers();
    try {
      const xhr = request();
      const result = discoverTizenEmbeddedSubtitles("https://provider.invalid/movie", undefined, () => xhr as unknown as XMLHttpRequest);
      await vi.advanceTimersByTimeAsync(12_000);
      expect(await result).toEqual({ status: "unavailable", tracks: [] });
      expect(xhr.abort).toHaveBeenCalledOnce();
      expect(await discoverTizenEmbeddedSubtitles("https://provider.invalid/movie", undefined, () => { throw new Error("private URL"); })).toEqual({ status: "unavailable", tracks: [] });
    } finally { vi.useRealTimers(); }
  });
});
