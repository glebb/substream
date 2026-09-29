import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchProviderPlaylist, ProviderFetchAbortedError, ProviderFetchError } from "./provider-fetch.ts";

describe("fetchProviderPlaylist", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("aborts a request at its deadline with a sanitized error", async () => {
    let requestSignal: AbortSignal | undefined;
    const request = vi.fn((_url: string, init: { signal?: AbortSignal }) => {
      requestSignal = init.signal;
      return new Promise<never>(() => {});
    });

    await expect(fetchProviderPlaylist("https://provider.test/list.m3u?token=secret", { timeoutMs: 5 }, request))
      .rejects.toBeInstanceOf(ProviderFetchError);
    expect(requestSignal?.aborted).toBe(true);
  });

  it("supports caller cancellation", async () => {
    const controller = new AbortController();
    let requestSignal: AbortSignal | undefined;
    const request = vi.fn((_url: string, init: { signal?: AbortSignal }) => {
      requestSignal = init.signal;
      return new Promise<never>(() => {});
    });
    const pending = fetchProviderPlaylist("https://provider.test/list.m3u", { signal: controller.signal }, request);
    controller.abort(new Error("secret URL https://provider.test/list.m3u?token=secret"));

    await expect(pending).rejects.toBeInstanceOf(ProviderFetchAbortedError);
    expect(requestSignal?.aborted).toBe(true);
  });

  it("sanitizes fetch failures that contain the playlist URL", async () => {
    const request = vi.fn(async () => { throw new Error("failed https://provider.test/list.m3u?token=secret"); });

    await expect(fetchProviderPlaylist("https://provider.test/list.m3u?token=secret", {}, request))
      .rejects.toMatchObject({ message: "Playlist request failed" });
  });

  it("loads on Chromium 47 when AbortController is unavailable", async () => {
    vi.stubGlobal("AbortController", undefined);
    const response = { ok: true } as Response;
    const request = vi.fn(async (_url: string, init: { cache: "no-store"; signal?: AbortSignal }) => {
      expect(init).toEqual({ cache: "no-store" });
      return response;
    });

    await expect(fetchProviderPlaylist("https://provider.test/list.m3u", {}, request)).resolves.toBe(response);
  });
});
