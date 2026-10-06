import { describe, expect, it, vi } from "vitest";
import { createServer, type Server } from "node:http";
import { VodRangeSource, VodRangeSourceAbortedError, VodRangeSourceError } from "./vod-range-source.ts";

const providerUrl = "https://provider.example.invalid/movie.mkv?token=synthetic-token";

function rangeResponse(start: number, total: number, bytes: Uint8Array, options: { end?: number; status?: number; url?: string } = {}): Response {
  const end = options.end ?? start + bytes.length - 1;
  return new Response(bytes as unknown as BodyInit, {
    status: options.status ?? 206,
    headers: { "content-range": `bytes ${start}-${end}/${total}` },
  });
}

describe("VodRangeSource", () => {
  it("requests only the original provider URL with privacy-safe fetch options and caches one bounded range", async () => {
    const request = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => rangeResponse(0, 8, new Uint8Array([0, 1, 2, 3])));
    const source = new VodRangeSource(providerUrl, { request: request as typeof fetch });

    expect(Array.from(await source.read(0, 4))).toEqual([0, 1, 2, 3]);
    expect(Array.from(await source.read(1, 3))).toEqual([1, 2]);
    expect(await source.getSize()).toBe(8);
    expect(request).toHaveBeenCalledOnce();
    const [url, init] = request.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(providerUrl);
    expect(init).toMatchObject({
      method: "GET",
      headers: { Range: "bytes=0-3" },
      credentials: "omit",
      referrerPolicy: "no-referrer",
      cache: "no-store",
      redirect: "follow",
    });
  });

  it("binds the native worker fetch receiver", async () => {
    const nativeRequest = vi.fn(async function (this: unknown) {
      expect(this).toBe(globalThis);
      return rangeResponse(0, 7, new Uint8Array([42]));
    });
    vi.stubGlobal("fetch", nativeRequest);
    const source = new VodRangeSource(providerUrl);
    expect(await source.getSize()).toBe(7);
    vi.unstubAllGlobals();
  });

  it("discovers the size with a one-byte range probe", async () => {
    const request = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => rangeResponse(0, 7, new Uint8Array([42])));
    const source = new VodRangeSource(providerUrl, { request: request as typeof fetch });
    expect(await source.getSize()).toBe(7);
    expect((request.mock.calls[0]?.[1] as RequestInit).headers).toEqual({ Range: "bytes=0-0" });
  });

  it("uses a credential-safe HEAD size probe when CORS hides Content-Range and validates subsequent range byte counts", async () => {
    const request = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "HEAD") return new Response(null, { status: 200, headers: { "Content-Length": "4" } });
      const range = new Headers(init?.headers).get("Range");
      const bytes = range === "bytes=0-0" ? new Uint8Array([42]) : new Uint8Array([43, 44]);
      return new Response(bytes, { status: 206, headers: { "Content-Length": String(bytes.length) } });
    });
    const source = new VodRangeSource(providerUrl, { request: request as typeof fetch });
    expect(await source.getSize()).toBe(4);
    expect(Array.from(await source.read(1, 3))).toEqual([43, 44]);
    expect(request.mock.calls.map(call=>call[1]?.method)).toEqual(["GET", "HEAD", "GET"]);
    expect(request.mock.calls[1]).toEqual([providerUrl, expect.objectContaining({ method: "HEAD", credentials: "omit", referrerPolicy: "no-referrer", redirect: "follow" })]);
    expect(request.mock.calls[1]?.[1]).not.toHaveProperty("headers");
  });

  it("falls back from a rejected HEAD to whole-file GET headers and cancels that body without reading it", async () => {
    const cancel = vi.fn(async () => undefined);
    const request = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "HEAD") throw new TypeError("synthetic HEAD rejection");
      if (!init?.headers) return { status: 200, headers: new Headers({ "Content-Length": "4", "Content-Type": "video/x-matroska" }), body: { cancel } } as unknown as Response;
      return new Response(new Uint8Array([42]), { status: 206, headers: { "Content-Length": "1" } });
    });
    const source = new VodRangeSource(providerUrl, { request: request as typeof fetch });
    expect(await source.getSize()).toBe(4);
    expect(cancel).toHaveBeenCalledOnce();
    expect(request.mock.calls.map(call=>call[1]?.method)).toEqual(["GET", "HEAD", "GET"]);
    expect(request.mock.calls[2]?.[1]).not.toHaveProperty("headers");
    expect(request.mock.calls.every(call=>call[0]===providerUrl && call[1]?.credentials==="omit" && call[1]?.referrerPolicy==="no-referrer")).toBe(true);
  });

  it("rejects hidden range metadata when HEAD cannot establish a safe whole-file size", async () => {
    const request = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => new Response(init?.method === "HEAD" ? null : new Uint8Array([1]), { status: init?.method === "HEAD" ? 200 : 206 }));
    const source = new VodRangeSource(providerUrl, { request: request as typeof fetch });
    await expect(source.getSize()).rejects.toMatchObject({ reason: "metadata" });
  });

  it("rejects a hidden-header partial response whose Content-Length disagrees with the requested range", async () => {
    const request = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => init?.method === "HEAD"
      ? new Response(null, { status: 200, headers: { "Content-Length": "8" } })
      : new Response(new Uint8Array([1, 2]), { status: 206, headers: { "Content-Length": "2" } }));
    const source = new VodRangeSource(providerUrl, { request: request as typeof fetch });
    await expect(source.getSize()).rejects.toMatchObject({ reason: "range" });
  });

  it("accepts a provider response shortened exactly at EOF", async () => {
    const request = vi.fn(async () => rangeResponse(4, 6, new Uint8Array([4, 5]), { end: 5 }));
    const source = new VodRangeSource(providerUrl, { request: request as typeof fetch });
    expect(Array.from(await source.read(4, 10))).toEqual([4, 5]);
    expect(await source.getSize()).toBe(6);
  });

  it("fails safely when the provider ignores Range and cancels its body immediately", async () => {
    const cancel = vi.fn();
    const response = {
      status: 200,
      url: "https://provider.example.invalid/movie.mkv",
      headers: new Headers(),
      body: { cancel },
    } as unknown as Response;
    const source = new VodRangeSource(providerUrl, { request: vi.fn(async () => response) as typeof fetch });
    await expect(source.read(0, 2)).rejects.toMatchObject({ reason: "status" });
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("accepts readable media from a provider-directed media origin without rewriting credentials", async () => {
    const response = rangeResponse(0, 4, new Uint8Array([1]));
    Object.defineProperty(response, "url", { value: "https://provider-cdn.example.invalid/media?ticket=synthetic-cdn-ticket" });
    const request = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => response);
    const source = new VodRangeSource(providerUrl, { request: request as typeof fetch });
    expect(Array.from(await source.read(0, 1))).toEqual([1]);
    expect(request).toHaveBeenCalledWith(providerUrl, expect.objectContaining({
      credentials: "omit", referrerPolicy: "no-referrer", redirect: "follow", headers: { Range: "bytes=0-0" },
    }));
    expect(JSON.stringify(request.mock.calls)).not.toContain("synthetic-cdn-ticket");
  });

  it("follows a synthetic provider redirect without copying source tokens, cookies or authorization to the media endpoint", async () => {
    const received: Array<{ destination: string; path: string; authorization?: string | undefined; cookie?: string | undefined; referrer?: string | undefined }> = [];
    const media = createServer((request, response) => {
      received.push({ destination: "provider media", path: request.url!, authorization: request.headers.authorization, cookie: request.headers.cookie, referrer: request.headers.referer });
      response.writeHead(206, { "Content-Range": "bytes 0-0/4", "Content-Length": "1" });
      response.end(new Uint8Array([42]));
    });
    const listen = async (server: Server) => {
      await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("synthetic listener unavailable");
      return `http://127.0.0.1:${address.port}`;
    };
    const mediaOrigin = await listen(media);
    const provider = createServer((request, response) => {
      received.push({ destination: "provider authentication", path: request.url! });
      response.writeHead(302, { Location: `${mediaOrigin}/media.mkv?ticket=synthetic-media-ticket` });
      response.end();
    });
    let source: VodRangeSource | undefined;
    try {
      const providerOrigin = await listen(provider);
      source = new VodRangeSource(`${providerOrigin}/movie.mkv?token=synthetic-provider-token`);
      expect(await source.getSize()).toBe(4);
      expect(received).toEqual([
        { destination: "provider authentication", path: "/movie.mkv?token=synthetic-provider-token" },
        { destination: "provider media", path: "/media.mkv?ticket=synthetic-media-ticket", authorization: undefined, cookie: undefined, referrer: undefined },
      ]);
    } finally {
      source?.dispose();
      for (const server of [provider, media]) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
    }
  });

  it("recognizes an opaque browser redirect without following it", async () => {
    const request = vi.fn(async (_url: RequestInfo | URL) => ({ type: "opaqueredirect", status: 0, body: null }) as Response);
    const source = new VodRangeSource(providerUrl, { request: request as typeof fetch });
    await expect(source.getSize()).rejects.toMatchObject({ reason: "redirect" });
    expect(request).toHaveBeenCalledOnce();
    expect(request.mock.calls[0]?.[0]).toBe(providerUrl);
  });

  it("sanitizes network errors containing signed URLs", async () => {
    const source = new VodRangeSource(providerUrl, {
      request: vi.fn(async () => { throw new Error(`failed ${providerUrl}`); }) as typeof fetch,
    });
    await expect(source.read(0, 1)).rejects.toMatchObject({ message: "Video range request failed" });
  });

  it("rejects malformed ranges and premature short bodies", async () => {
    const malformed = new VodRangeSource(providerUrl, {
      request: vi.fn(async () => rangeResponse(1, 8, new Uint8Array([0]))) as typeof fetch,
    });
    await expect(malformed.read(0, 1)).rejects.toMatchObject({ reason: "range" });

    const short = new VodRangeSource(providerUrl, {
      request: vi.fn(async () => rangeResponse(0, 8, new Uint8Array([0]))) as typeof fetch,
    });
    await expect(short.read(0, 2)).rejects.toMatchObject({ reason: "range" });
  });

  it("rejects an EOF response that includes bytes beyond the requested range", async () => {
    const source = new VodRangeSource(providerUrl, {
      request: vi.fn(async () => rangeResponse(0, 2, new Uint8Array([0, 1]), { end: 1 })) as typeof fetch,
    });
    await expect(source.read(0, 1)).rejects.toMatchObject({ reason: "range" });
  });

  it("rejects a request larger than the cache bound before fetching", async () => {
    const request = vi.fn();
    const source = new VodRangeSource(providerUrl, { request: request as typeof fetch });
    await expect(source.read(0, 2 * 1024 * 1024 + 1)).rejects.toMatchObject({ reason: "size" });
    expect(request).not.toHaveBeenCalled();
  });

  it("supports caller abort and dispose without leaking fetch errors", async () => {
    const abort = new AbortController();
    const source = new VodRangeSource(providerUrl, {
      signal: abort.signal,
      request: vi.fn((_url: RequestInfo | URL, init?: RequestInit) => new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("provider URL leaked in fetch error")), { once: true });
      })) as typeof fetch,
    });
    const pending = source.read(0, 1);
    abort.abort();
    await expect(pending).rejects.toBeInstanceOf(VodRangeSourceAbortedError);

    const disposed = new VodRangeSource(providerUrl, { request: vi.fn(async () => rangeResponse(0, 1, new Uint8Array([0]))) as typeof fetch });
    disposed.dispose();
    await expect(disposed.read(0, 1)).rejects.toMatchObject({ reason: "disposed" });
  });

  it("serializes concurrent reads so caller abort cancels the only active request", async () => {
    const abort = new AbortController();
    const request = vi.fn((_url: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new Error("synthetic transport abort")), { once: true });
    }));
    const source = new VodRangeSource(providerUrl, { signal: abort.signal, request: request as typeof fetch });
    const first = source.read(0, 1);
    const second = source.read(4, 5);
    await Promise.resolve();
    abort.abort();
    await expect(first).rejects.toBeInstanceOf(VodRangeSourceAbortedError);
    await expect(second).rejects.toBeInstanceOf(VodRangeSourceAbortedError);
    expect(request).toHaveBeenCalledOnce();
  });

  it("exposes fixed typed errors only", () => {
    expect(new VodRangeSourceError("request").message).toBe("Video range request failed");
  });
});
