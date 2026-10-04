import { describe, expect, it } from "vitest";
import { TmdbClient } from "./client.ts";

const response = (body: unknown, ok = true, status = 200) => ({ ok, status, json: async () => body });
describe("TmdbClient", () => {
  it("uses bearer token and resolves an exact Finnish-first match", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const client = new TmdbClient({ readAccessToken: "secret-token", apiKey: "fallback" }, async (url, init) => { calls.push({ url, init }); return response({ results: [{ id: 7, title: "Testielokuva", original_title: "Test Movie", release_date: "2024-01-01", poster_path: "/poster.jpg" }] }); });
    const result = await client.resolve("Testielokuva", "movie", 2024);
    expect(result.kind).toBe("match"); const call = calls[0]; expect(call?.init.headers).toEqual({ Accept: "application/json", Authorization: "Bearer secret-token" }); expect(call?.url).toContain("language=fi-FI");
  });
  it("returns ambiguity instead of guessing between equally plausible candidates", async () => {
    const client = new TmdbClient({ apiKey: "key" }, async () => response({ results: [{ id: 1, name: "The Office", first_air_date: "2005-01-01" }, { id: 2, name: "The Office", first_air_date: "1990-01-01" }] }));
    const result = await client.resolve("The Office", "tv"); expect(result.kind).toBe("ambiguous");
  });
  it("falls back from an unrelated localized result to an exact English result", async () => {
    const languages: string[] = [];
    const client = new TmdbClient({ apiKey: "key" }, async (url) => {
      const language = new URL(url).searchParams.get("language")!; languages.push(language);
      return response({ results: language === "fi-FI"
        ? [{ id: 99, title: "데시벨", original_title: "Decibel", release_date: "2022-01-01" }]
        : [{ id: 99, title: "Decibel", original_title: "Decibel", release_date: "2022-01-01" }] });
    });
    const result = await client.resolve("Decibel", "movie", 2022);
    expect(result.kind).toBe("match"); if (result.kind === "match") expect(result.candidate.id).toBe(99);
    expect(languages).toEqual(["fi-FI", "en-US"]);
  });
  it("falls back to English when localized details are incomplete", async () => {
    let count = 0; const client = new TmdbClient({ apiKey: "key" }, async (url) => { count++; return response(url.includes("en-US") ? { id: 3, title: "Movie", overview: "English synopsis", genres: [{ name: "Drama" }], runtime: 90, vote_average: 8 } : { id: 3, title: "Elokuva", overview: "" }); });
    const metadata = await client.getMetadata(3, "movie"); expect(count).toBe(2); expect(metadata.overview).toBe("English synopsis"); expect(metadata.genres).toEqual(["Drama"]);
  });
  it("includes bounded, ordered movie cast and production details in the detail request", async () => {
    const client = new TmdbClient({ apiKey: "synthetic" }, async (url) => {
      expect(new URL(url).searchParams.get("append_to_response")).toBe("credits");
      return response({ title: "Example", overview: "A story", tagline: "An adventure", spoken_languages: [{ english_name: "Finnish" }],
        production_countries: [{ name: "Finland" }], production_companies: [{ name: "Example Studio" }],
        credits: { cast: [null, { name: "" }, ...Array.from({ length: 8 }, (_, i) => ({ name: `Actor ${i}`, character: `Role ${i}`, order: 7 - i }))],
          crew: [{ name: "Director A", job: "Director" }, { name: "Writer A", job: "Screenplay" }, { name: "Writer A", job: "Story" }, { name: "Editor A", job: "Editor" }] } });
    });
    const metadata = await client.getMetadata(7, "movie");
    expect(metadata.cast).toHaveLength(6);
    expect(metadata.cast?.[0]).toEqual({ name: "Actor 7", character: "Role 7" });
    expect(metadata).toMatchObject({ detailsVersion: 1, directors: ["Director A"], writers: ["Writer A"], spokenLanguages: ["Finnish"], countries: ["Finland"], studios: ["Example Studio"], tagline: "An adventure" });
  });
  it("uses all-season series credits and handles missing or malformed optional fields", async () => {
    const client = new TmdbClient({ apiKey: "synthetic" }, async (url) => {
      expect(new URL(url).searchParams.get("append_to_response")).toBe("aggregate_credits");
      return response({ name: "Example series", overview: "A story", created_by: [null, { name: "Creator A" }], networks: [{ name: "Network A" }],
        number_of_seasons: 3, number_of_episodes: 24, status: "Ended", production_countries: "invalid",
        aggregate_credits: { cast: [{ name: "Actor A", roles: [{ character: "Character A" }] }], crew: null } });
    });
    expect(await client.getMetadata(8, "tv")).toMatchObject({ cast: [{ name: "Actor A", character: "Character A" }], creators: ["Creator A"], networks: ["Network A"], seasonCount: 3, episodeCount: 24, status: "Ended", countries: [], directors: [], writers: [] });
  });
});
