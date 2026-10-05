import { describe, expect, it } from "vitest";
import { VodSubtitlePreferences } from "./vod-subtitle-preferences.ts";
import type { PreferencesRepository } from "../../contracts/repository.ts";

function memoryStore(): PreferencesRepository {
  const values = new Map<string, string>();
  return { get: (key) => values.get(key) ?? null, set: (key, value) => { values.set(key, value); }, remove: (key) => { values.delete(key); } };
}

describe("VodSubtitlePreferences", () => {
  it("persists validated choices without storing URLs", () => {
    const preferences = new VodSubtitlePreferences(memoryStore());
    preferences.setChoice("movie-123", { mode: "embedded", language: "fi", label: "Finnish" });
    expect(preferences.getChoice("movie-123")).toEqual({ mode: "embedded", language: "fi", label: "Finnish" });
    preferences.setChoice("movie-123", { mode: "embedded", language: "swe", label: "Swedish" });
    expect(preferences.getChoice("movie-123")).toEqual({ mode: "embedded", language: "swe", label: "Swedish" });
    preferences.setChoice("movie-123", { mode: "embedded", language: "eng", label: "English", forced: true, hearingImpaired: false, codec: "S_TEXT/UTF8", occurrence: 2 });
    expect(preferences.getChoice("movie-123")).toEqual({ mode: "embedded", language: "eng", label: "English", forced: true, hearingImpaired: false, codec: "S_TEXT/UTF8", occurrence: 2 });
    preferences.setChoice("movie-123", { mode: "external", language: "en", id: "result-1", fileId: "file-9" });
    expect(preferences.getChoice("movie-123")).toEqual({ mode: "external", language: "en", id: "result-1", fileId: "file-9" });
    preferences.setChoice("https://private.example/media?token=secret", { mode: "off" });
    expect(preferences.getChoice("https://private.example/media?token=secret")).toBeNull();
  });

  it("keeps timing offsets separate by source and clamps values", () => {
    const preferences = new VodSubtitlePreferences(memoryStore());
    preferences.setOffset("movie-123", "embedded:fin", 3.25);
    preferences.setOffset("movie-123", "external:result-1", -2);
    expect(preferences.getOffset("movie-123", "embedded:fin")).toBe(3.5);
    expect(preferences.getOffset("movie-123", "external:result-1")).toBe(-2);
    expect(preferences.getOffset("movie-123", "embedded:eng")).toBe(0);
    preferences.clear();
    expect(preferences.getOffset("movie-123", "embedded:fin")).toBe(0);
    expect(preferences.getChoice("movie-123")).toBeNull();
  });

  it("drops invalid embedded track metadata", () => {
    const preferences = new VodSubtitlePreferences(memoryStore());
    preferences.setChoice("movie", { mode: "embedded", language: "eng", label: "English", occurrence: 128, codec: "https://invalid.test" });
    expect(preferences.getChoice("movie")).toEqual({ mode: "embedded", language: "eng", label: "English" });
  });
});
