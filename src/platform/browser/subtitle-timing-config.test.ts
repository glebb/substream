import { describe, expect, it } from "vitest";
import { clearSubtitleTimingOffsets, loadSubtitleTimingOffset, saveSubtitleTimingOffset } from "./subtitle-timing-config.ts";

function memoryStorage(): Storage & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => { data.set(key, value); },
    removeItem: (key) => { data.delete(key); },
    clear: () => data.clear(),
    key: (index) => [...data.keys()][index] ?? null,
    get length() { return data.size; },
  };
}

describe("subtitle timing persistence", () => {
  it("remembers a bounded offset by title ID without storing a stream URL", () => {
    const storage = memoryStorage();
    const titleId = "xtream:episode:1234";
    expect(saveSubtitleTimingOffset(titleId, 12.4, storage)).toBe(10);
    expect(loadSubtitleTimingOffset(titleId, storage)).toBe(10);
    const stored = [...storage.data.values()][0] ?? "";
    expect(stored).toContain(titleId);
    expect(stored).not.toContain("https://");
    expect(loadSubtitleTimingOffset("https://media.example/signed.mkv", storage)).toBe(0);
  });

  it("returns zero for invalid saved data and unavailable storage", () => {
    const storage = memoryStorage();
    storage.setItem("my-m3u.subtitle-timing-offsets", "not json");
    expect(loadSubtitleTimingOffset("vod_abc", storage)).toBe(0);
    expect(saveSubtitleTimingOffset("vod_abc", -0.5, null)).toBe(-0.5);
  });

  it("clears every saved title offset", () => {
    const storage = memoryStorage();
    saveSubtitleTimingOffset("vod_abc", 1, storage);
    clearSubtitleTimingOffsets(storage);
    expect(loadSubtitleTimingOffset("vod_abc", storage)).toBe(0);
  });
});
