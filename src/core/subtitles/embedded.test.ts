import { describe, expect, it } from "vitest";
import { preferredEmbeddedSubtitleTrack } from "./embedded.ts";

describe("preferredEmbeddedSubtitleTrack", () => {
  it("chooses Finnish before English regardless of provider ordering", () => {
    expect(preferredEmbeddedSubtitleTrack([
      { id: "2", label: "English", language: "eng", selected: false },
      { id: "7", label: "Finnish", language: "fin", selected: false },
    ])?.id).toBe("7");
  });

  it("falls back to English and otherwise leaves subtitles disabled", () => {
    expect(preferredEmbeddedSubtitleTrack([{ id: "2", label: "English", language: "en", selected: false }])?.id).toBe("2");
    expect(preferredEmbeddedSubtitleTrack([{ id: "3", label: "Swedish", language: "swe", selected: false }])).toBeUndefined();
  });
});
