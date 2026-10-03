import { afterEach, describe, expect, it, vi } from "vitest";
import { loadPreferredLocalSubtitle, type LocalSubtitleClient } from "./local-subtitle-match.ts";

function subtitle(language: string, fileId: number, downloads: number) {
  return { id: String(fileId), language, releaseName: `Cape Fear S01E10 ${language}`, fileId, fileName: `${language}.srt`, hearingImpaired: false, downloads, featureType: "episode", featureTitle: "Cape Fear", featureYear: 1991, parentFeatureId: 55, season: 1, episode: 10 };
}

describe("local subtitle matching", () => {
  afterEach(() => vi.useRealTimers());
  it("searches a parsed series episode and loads the preferred-language exact match", async () => {
    const search = vi.fn(async () => [subtitle("en", 1, 100), subtitle("fi", 2, 10)]);
    const client: LocalSubtitleClient = {
      findSeriesFeature: vi.fn(async (title) => ({ id: 55, title, year: 1991 })),
      search,
      download: vi.fn(async (fileId) => ({ fileName: `${fileId}.srt`, link: "synthetic://subtitle" })),
      fetchSubtitleText: vi.fn(async () => "1\n00:00:01,000 --> 00:00:02,000\nCaption\n"),
    };
    const loaded = await loadPreferredLocalSubtitle(client, { title: "Cape Fear", year: null, contentType: "series", season: 1, episode: 10 }, "fi");
    expect(client.findSeriesFeature).toHaveBeenCalledWith("Cape Fear", null);
    expect(search).toHaveBeenCalledWith({ languages: ["fi", "en"], parentFeatureId: 55, season: 1, episode: 10, type: "episode" });
    expect(client.download).toHaveBeenCalledWith(2);
    expect(loaded).toMatchObject({ language: "fi", enabled: true, result: { season: 1, episode: 10, highConfidence: true } });
  });

  it("does not auto-download a merely similar or wrong-episode result", async () => {
    const client: LocalSubtitleClient = {
      findSeriesFeature: vi.fn(async () => null),
      search: vi.fn(async () => [subtitle("fi", 1, 1)]),
      download: vi.fn(async () => ({ fileName: "wrong.srt", link: "synthetic://subtitle" })),
      fetchSubtitleText: vi.fn(async () => "text"),
    };
    await expect(loadPreferredLocalSubtitle(client, { title: "Other show", year: null, contentType: "series", season: 1, episode: 10 }, "fi")).resolves.toBeNull();
    expect(client.download).not.toHaveBeenCalled();
  });

  it("bounds a hung automatic lookup and aborts its request", async () => {
    vi.useFakeTimers();
    const abortRequest = vi.fn();
    const client: LocalSubtitleClient = {
      findSeriesFeature: vi.fn(() => new Promise<{ id: number; title: string; year: number | null } | null>(() => {})),
      search: vi.fn(async () => []),
      download: vi.fn(async () => ({ fileName: "unused.srt", link: "synthetic://subtitle" })),
      fetchSubtitleText: vi.fn(async () => ""),
    };
    const result = loadPreferredLocalSubtitle(client, { title: "Cape Fear", year: null, contentType: "series", season: 1, episode: 10 }, "fi", { timeoutMs: 100, abortRequest });
    await vi.advanceTimersByTimeAsync(100);
    await expect(result).resolves.toBeNull();
    expect(abortRequest).toHaveBeenCalledOnce();
    expect(client.search).not.toHaveBeenCalled();
  });
});
