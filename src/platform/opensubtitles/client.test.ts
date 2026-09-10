import { describe, expect, it, vi } from "vitest";
import { OpenSubtitlesClient } from "./client.ts";

describe("OpenSubtitlesClient", () => {
  it("searches with deterministic, title-based parameters and maps usable files", async () => {
    const request = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        data: [{
          id: "123",
          attributes: {
            language: "en",
            release: "Example WEB",
            download_count: 42,
            hearing_impaired: true,
            files: [{ file_id: 456, file_name: "example.srt" }],
          },
        }],
      }),
      text: async () => "",
    });
    const client = new OpenSubtitlesClient("test-key", request);

    await expect(client.search({
      query: "Example",
      languages: ["en", "fi"],
      year: 2026,
      type: "movie",
    })).resolves.toEqual([{
      id: "123",
      language: "en",
      releaseName: "Example WEB",
      fileId: 456,
      fileName: "example.srt",
      hearingImpaired: true,
      downloads: 42,
    }]);

    const [url, init] = request.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.opensubtitles.com/api/v1/subtitles?languages=en%2Cfi&query=example&type=movie&year=2026");
    expect(init.headers).toEqual({ Accept: "application/json", "Api-Key": "test-key" });
  });

  it("does not return incomplete search records", async () => {
    const client = new OpenSubtitlesClient("test-key", async () => ({
      ok: true,
      status: 200,
      json: async () => ({ data: [{ id: "missing-file", attributes: { language: "en" } }] }),
      text: async () => "",
    }));
    await expect(client.search({ query: "Example", languages: ["en"], type: "movie" })).resolves.toEqual([]);
  });

  it("supports the relative URL used by the local development proxy", async () => {
    const request = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ data: [] }), text: async () => "" });
    const client = new OpenSubtitlesClient("test-key", request, "/opensubtitles-api/api/v1");
    await client.search({ query: "Example", languages: ["en"], type: "movie" });
    expect(request.mock.calls[0]?.[0]).toBe("/opensubtitles-api/api/v1/subtitles?languages=en&query=example&type=movie");
  });

  it("sends episode identifiers for a series subtitle search", async () => {
    const request = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ data: [] }), text: async () => "" });
    const client = new OpenSubtitlesClient("test-key", request);
    await client.search({ query: "Example Show", languages: ["en"], type: "episode", season: 1, episode: 2 });
    expect(request.mock.calls[0]?.[0]).toBe("https://api.opensubtitles.com/api/v1/subtitles?episode_number=2&languages=en&query=example+show&season_number=1&type=episode");
  });

  it("allows a title-only series fallback search", async () => {
    const request = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ data: [] }), text: async () => "" });
    const client = new OpenSubtitlesClient("test-key", request);
    await client.search({ query: "Silo", languages: ["en"] });
    expect(request.mock.calls[0]?.[0]).toBe("https://api.opensubtitles.com/api/v1/subtitles?languages=en&query=silo");
  });

  it("resolves a canonical TV show and searches its exact episode", async () => {
    const request = vi.fn()
      .mockResolvedValueOnce({
        ok: true, status: 200, text: async () => "",
        json: async () => ({ data: [{ attributes: { feature_id: "1463176", feature_type: "Tvshow", title: "silo", year: "2023" } }] }),
      })
      .mockResolvedValueOnce({ ok: true, status: 200, text: async () => "", json: async () => ({ data: [] }) });
    const client = new OpenSubtitlesClient("test-key", request);
    await expect(client.findSeriesFeature("Silo", 2023)).resolves.toEqual({ id: 1463176, title: "silo", year: 2023 });
    await client.search({ languages: ["en"], parentFeatureId: 1463176, season: 3, episode: 1, type: "episode" });
    expect(request.mock.calls[1]?.[0]).toBe("https://api.opensubtitles.com/api/v1/subtitles?episode_number=1&languages=en&parent_feature_id=1463176&season_number=3&type=episode");
  });

  it("requests an authenticated SRT download", async () => {
    const request = vi.fn()
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ file_name: "example.srt", link: "https://download.example/subtitle" }), text: async () => "" })
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({}), text: async () => "1\n00:00:01,000 --> 00:00:02,000\nHi" });
    const client = new OpenSubtitlesClient("test-key", request);

    await expect(client.download(456, "test-token")).resolves.toEqual({ fileName: "example.srt", link: "https://download.example/subtitle" });
    await expect(client.fetchSubtitleText("https://download.example/subtitle")).resolves.toContain("Hi");
    expect(request.mock.calls[0]?.[1]).toMatchObject({
      body: JSON.stringify({ file_id: 456, sub_format: "srt" }),
      headers: { Authorization: "Bearer test-token" },
      method: "POST",
    });
  });

  it("logs in without exposing credentials in URLs", async () => {
    const request = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ token: "test-token" }),
      text: async () => "",
    });
    const client = new OpenSubtitlesClient("test-key", request);
    await expect(client.login("person@example.com", "test-password")).resolves.toBe("test-token");
    expect(request.mock.calls[0]?.[0]).toBe("https://api.opensubtitles.com/api/v1/login");
    expect(request.mock.calls[0]?.[1]).toMatchObject({ body: JSON.stringify({ password: "test-password", username: "person@example.com" }) });
  });

  it("allows anonymous downloads with only an API key", async () => {
    const request = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ file_name: "example.srt", link: "https://download.example/subtitle" }),
      text: async () => "",
    });
    const client = new OpenSubtitlesClient("test-key", request);
    await expect(client.download(456)).resolves.toEqual({ fileName: "example.srt", link: "https://download.example/subtitle" });
    expect(request.mock.calls[0]?.[1]).toMatchObject({
      headers: { "Api-Key": "test-key" },
    });
    expect((request.mock.calls[0]?.[1] as RequestInit).headers).not.toHaveProperty("Authorization");
  });
});
