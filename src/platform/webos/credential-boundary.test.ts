import { afterEach, expect, it, vi } from "vitest";
import { createAppRuntime } from "../../bootstrap/runtime.ts";
import { fetchProviderPlaylist } from "../browser/provider-fetch.ts";
import { TmdbClient } from "../tmdb/client.ts";
import { OpenSubtitlesClient } from "../opensubtitles/client.ts";

afterEach(() => vi.unstubAllGlobals());

it("routes LG client credentials only to their intended services on success and failure", async () => {
  vi.stubGlobal("PalmSystem", {});
  const calls: Array<{ url: URL; headers: Headers; body: string }> = [];
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    calls.push({ url, headers: new Headers(init?.headers), body: String(init?.body ?? "") });
    if (url.hostname === "provider.example.test") {
      if (calls.length === 1) throw new Error("synthetic private request error");
      return new Response("#EXTM3U");
    }
    return new Response(JSON.stringify({ data: [], results: [] }), { headers: { "Content-Type": "application/json" } });
  });
  vi.stubGlobal("fetch", fetch);
  const runtime = createAppRuntime();
  const playlist = "https://provider.example.test/list?username=fixture-user&password=fixture-password";
  await expect(fetchProviderPlaylist(playlist, {}, runtime.transport.fetch)).rejects.toThrow("Playlist request failed");
  await fetchProviderPlaylist(playlist, {}, runtime.transport.fetch);
  await new TmdbClient({ readAccessToken: "fixture-tmdb-token" }, runtime.transport.fetch).resolve("Example", "movie");
  await new OpenSubtitlesClient("fixture-subtitle-key", runtime.transport.fetch).search({ query: "Example", languages: ["en"] });

  expect(runtime.platform).toBe("webos");
  expect(runtime.capabilities.supportsCompanion).toBe(false);
  expect(runtime.capabilities.supportsLiveRelay).toBe(false);
  expect(calls.length).toBeGreaterThanOrEqual(4);
  for (const { url, headers, body } of calls) {
    expect(["provider.example.test", "api.themoviedb.org", "api.opensubtitles.com"]).toContain(url.hostname);
    if (url.hostname === "provider.example.test") {
      expect(url.searchParams.get("password")).toBe("fixture-password");
      expect(headers.has("Authorization")).toBe(false);
      expect(headers.has("Api-Key")).toBe(false);
    } else {
      expect(url.searchParams.has("password")).toBe(false);
      expect(body).not.toContain("fixture-password");
      if (url.hostname === "api.themoviedb.org") {
        expect(headers.get("Authorization")).toBe("Bearer fixture-tmdb-token");
        expect(headers.has("Api-Key")).toBe(false);
      } else {
        expect(headers.get("Api-Key")).toBe("fixture-subtitle-key");
        expect(headers.has("Authorization")).toBe(false);
      }
    }
  }
});
