import { describe, expect, it } from "vitest";
import { chooseEmbeddedSubtitleTrack, choosePreferredEmbeddedSubtitleTrack, normalizeVodSubtitleLanguage } from "./vod-selection.ts";

describe("VOD embedded subtitle selection", () => {
  it("does not retain a selected hearing-impaired track ahead of an ordinary full track", () => {
    const tracks = [{ id: "hi", label: "English HI", language: "eng", hearingImpaired: true, selected: true }, { id: "full", label: "English", language: "eng", selected: false }];
    expect(chooseEmbeddedSubtitleTrack(tracks, "en")?.id).toBe("full");
  });

  it("normalizes ISO-639-1/2 codes and language labels", () => {
    expect(normalizeVodSubtitleLanguage("fin-FI")).toBe("fi");
    expect(normalizeVodSubtitleLanguage("English SDH")).toBe("en");
    expect(normalizeVodSubtitleLanguage("swe")).toBeUndefined();
    expect(normalizeVodSubtitleLanguage("fil")).toBeUndefined();
    expect(normalizeVodSubtitleLanguage("French" )).toBeUndefined();
  });

  it("prefers playable, full ordinary subtitles and excludes forced-only tracks", () => {
    const tracks = [
      { id: "forced", label: "Finnish forced", language: "fin", forced: true },
      { id: "hi", label: "Finnish SDH", language: "fi", hearingImpaired: true },
      { id: "unsupported", label: "Finnish", language: "fi", playable: false },
      { id: "ordinary", label: "Finnish", language: "fi" },
    ];
    expect(chooseEmbeddedSubtitleTrack(tracks, "fi")?.id).toBe("ordinary");
    expect(chooseEmbeddedSubtitleTrack(tracks, "fi", { includeHearingImpaired: true })?.id).toBe("hi");
  });

  it("falls back to the other supported language", () => {
    expect(choosePreferredEmbeddedSubtitleTrack([{ id: "en", label: "English", language: "eng" }], "fi")?.id).toBe("en");
  });
});
