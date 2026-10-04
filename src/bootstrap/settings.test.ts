import { describe, expect, it } from "vitest";
import { createDeviceSettings } from "./settings.ts";

function settings() {
  const data = new Map<string, string>();
  return { data, service: createDeviceSettings({ get: (key) => data.get(key) ?? null, set: (key, value) => { data.set(key, value); }, remove: (key) => { data.delete(key); } }) };
}

describe("device-owned settings", () => {
  it("persists existing keys through an injected store and isolates devices", () => {
    const first = settings();
    const second = settings();
    first.service.savePlaylistUrl("https://example.invalid/synthetic.m3u");
    first.service.saveUiLanguage("en");
    first.service.saveSubtitleLanguagePreference("en");
    first.service.setFavouriteGroup("synthetic-group", true);
    expect(first.data.get("substream.playlist-url")).toBe("https://example.invalid/synthetic.m3u");
    expect(first.service.loadUiLanguage()).toBe("en");
    expect(first.service.loadSubtitlePreferences().languagePreference).toBe("en");
    expect(first.service.loadFavouriteGroupIds()).toEqual(["synthetic-group"]);
    expect(second.service.loadFavouriteGroupIds()).toEqual([]);
    expect(second.service.loadUiLanguage()).toBe("fi");
  });

  it("retains bounded subtitle timing and credential-free resume records", () => {
    const { service, data } = settings();
    service.saveSubtitleTimingOffset("synthetic-movie", 9999);
    expect(service.loadSubtitleTimingOffset("synthetic-movie")).toBeLessThan(9999);
    service.savePlaybackProgress({ id: "synthetic-movie", title: "Synthetic Movie", group: "Synthetic", contentType: "movie", year: null, currentTimeSeconds: 100, durationSeconds: 1000, updatedAt: 1 });
    expect(service.loadPlaybackHistory()).toHaveLength(1);
    expect(data.get("substream.playback-progress")).not.toContain("streamUrl");
    service.clearPlaybackProgress();
    expect(service.loadPlaybackHistory()).toEqual([]);
  });
});
