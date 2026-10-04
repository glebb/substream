import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { TitleMetadataExtras } from "./TitleMetadataExtras.tsx";
import type { TmdbMetadata } from "../platform/tmdb/client.ts";

const metadata: TmdbMetadata = { id: 1, mediaType: "movie", title: "Example", overview: "", year: 2024, genres: [], runtime: null, rating: null, posterUrl: null, backdropUrl: null, language: "en-US" };

describe("detail metadata sections", () => {
  it("hides empty sections and series-only facts for movies", () => {
    const html = renderToStaticMarkup(<TitleMetadataExtras metadata={{ ...metadata, status: "Released", seasonCount: 2 }} language="en" />);
    expect(html).not.toContain("<section");
    expect(html).not.toContain("Released");
  });
  it("localizes headings and series status while preserving actor and character names", () => {
    const html = renderToStaticMarkup(<TitleMetadataExtras metadata={{ ...metadata, mediaType: "tv", cast: [{ name: "Story", character: "Pilot" }], creators: ["Example Creator"], status: "Ended", seasonCount: 3, episodeCount: 24, networks: ["Example Network"] }} language="fi" />);
    expect(html).toContain("Näyttelijät");
    expect(html).toContain("Luojat");
    expect(html).toContain("Päättynyt");
    expect(html).toContain("3 / 24");
    expect(html).toContain(">Story</strong>");
    expect(html).toContain(">Pilot</span>");
    expect(html).not.toContain(">Studio</dt>");
  });
});
