import { describe, expect, it } from "vitest";
import { preferredAudioTrackIndex } from "./audio.ts";

describe("preferredAudioTrackIndex", () => {
  it("prefers Finnish ahead of English and provider order", () => {
    expect(preferredAudioTrackIndex([
      { language: "dan", label: "Danish" },
      { language: "eng", label: "English" },
      { language: "fin", label: "Finnish" },
    ])).toBe(2);
  });

  it("uses English, then the first track when Finnish is absent", () => {
    expect(preferredAudioTrackIndex([{ language: "swe", label: "Swedish" }, { language: "en-US", label: "English" }])).toBe(1);
    expect(preferredAudioTrackIndex([{ language: "swe", label: "Swedish" }, { language: "dan", label: "Danish" }])).toBe(0);
  });

  it("retains a supplied stream-default track when no preferred language exists", () => {
    expect(preferredAudioTrackIndex([
      { language: "swe", label: "Swedish" },
      { language: "dan", label: "Danish" },
    ], 1)).toBe(1);
  });

  it("recognizes language text in a label and handles no tracks", () => {
    expect(preferredAudioTrackIndex([{ label: "Audio 1" }, { label: "Finnish · AAC" }])).toBe(1);
    expect(preferredAudioTrackIndex([])).toBe(-1);
  });
});
