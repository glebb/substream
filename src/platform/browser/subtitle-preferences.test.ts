import { afterEach, describe, expect, it } from "vitest";
import { clearSubtitlePreferences, loadSubtitlePreferences, saveLastSubtitleLanguage, saveSubtitleFontSize, saveSubtitleLanguagePreference } from "./subtitle-preferences.ts";

const values = new Map<string, string>();
const store = {
  getItem: (key: string) => values.get(key) ?? null,
  setItem: (key: string, value: string) => values.set(key, value),
  removeItem: (key: string) => values.delete(key),
};

afterEach(() => { values.clear(); });

describe("subtitle preferences", () => {
  it("defaults to Finnish first and a readable font size", () => {
    expect(loadSubtitlePreferences(store)).toEqual({ languagePreference: "fi", lastLanguage: "fi", fontSize: 2.3 });
  });

  it("persists language and clamps font size", () => {
    saveSubtitleLanguagePreference("en", store);
    saveLastSubtitleLanguage("en", store);
    expect(saveSubtitleFontSize(99, store)).toBe(3.5);
    expect(loadSubtitlePreferences(store)).toEqual({ languagePreference: "en", lastLanguage: "en", fontSize: 3.5 });
  });

  it("ignores malformed values and clears only its own record", () => {
    values.set("substream.subtitle-preferences", "not json");
    expect(loadSubtitlePreferences(store).languagePreference).toBe("fi");
    values.set("other", "keep");
    clearSubtitlePreferences(store);
    expect(values.has("substream.subtitle-preferences")).toBe(false);
    expect(values.get("other")).toBe("keep");
  });
});
