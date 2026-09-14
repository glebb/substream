import { describe, expect, it } from "vitest";
import { rankSubtitleResults, type SubtitleCandidate } from "./rank.ts";

function candidate(overrides: Partial<SubtitleCandidate> = {}): SubtitleCandidate {
  return {
    id: "candidate",
    language: "en",
    releaseName: "Example Movie 2024 WEB-DL",
    fileId: 1,
    fileName: "example.srt",
    hearingImpaired: false,
    downloads: 10,
    ...overrides,
  };
}

describe("rankSubtitleResults", () => {
  it("ranks Finnish ahead of English, then release similarity and downloads", () => {
    const ranked = rankSubtitleResults({ title: "Example Movie", year: 2024, contentType: "movie" }, [
      candidate({ id: "english", language: "en", downloads: 1000 }),
      candidate({ id: "finnish", language: "fi", downloads: 1 }),
      candidate({ id: "swedish", language: "sv" }),
      candidate({ id: "finnish-popular", language: "fi", downloads: 20, releaseName: "Other Film 2024" }),
    ]);

    expect(ranked.map(({ id }) => id)).toEqual(["finnish", "english", "finnish-popular"]);
    expect(ranked[0]?.highConfidence).toBe(true);
    expect(ranked[1]?.highConfidence).toBe(true);
    expect(ranked[2]?.highConfidence).toBe(false);
  });

  it("filters known series and episode conflicts while retaining episode results with their own release year", () => {
    const ranked = rankSubtitleResults({ title: "Example Show", year: 2024, contentType: "series", season: 2, episode: 3, parentFeatureId: 55 }, [
      candidate({ id: "exact", releaseName: "Example Show S02E03", featureType: "episode", featureTitle: "Example Show", featureYear: 2024, parentFeatureId: 55, season: 2, episode: 3 }),
      candidate({ id: "episode-year", releaseName: "Example Show S02E03", featureType: "episode", featureTitle: "Example Show", featureYear: 2023, parentFeatureId: 55, season: 2, episode: 3 }),
      candidate({ id: "unknown", releaseName: "Example Show S02E03" }),
      candidate({ id: "wrong-episode", season: 2, episode: 4 }),
      candidate({ id: "wrong-parent", parentFeatureId: 99 }),
      candidate({ id: "wrong-type", featureType: "movie" }),
    ]);

    expect(ranked.map(({ id }) => id)).toEqual(["episode-year", "exact", "unknown"]);
    expect(ranked[0]?.highConfidence).toBe(true);
    expect(ranked[1]?.highConfidence).toBe(true);
    expect(ranked[2]?.highConfidence).toBe(false);
  });

  it("requires a title and year match before auto-selecting a movie subtitle", () => {
    const ranked = rankSubtitleResults({ title: "Example Movie", year: 2024, contentType: "movie" }, [
      candidate({ id: "metadata", featureType: "movie", featureTitle: "Example Movie", featureYear: 2024 }),
      candidate({ id: "no-year", releaseName: "Example Movie WEB-DL" }),
      candidate({ id: "wrong-year", releaseName: "Example Movie 2023 WEB-DL" }),
    ]);

    expect(ranked.find(({ id }) => id === "metadata")?.highConfidence).toBe(true);
    expect(ranked.find(({ id }) => id === "no-year")?.highConfidence).toBe(false);
    expect(ranked.find(({ id }) => id === "wrong-year")?.highConfidence).toBe(false);
  });
});
