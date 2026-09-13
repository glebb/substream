import { describe, expect, it } from "vitest";
import { clearPlaybackProgress, loadPlaybackHistory, removePlaybackProgress, savePlaybackProgress, type PlaybackHistoryItem } from "./playback-progress-config.ts";

class MemoryStorage {
  values = new Map<string, string>();
  getItem(key: string): string | null { return this.values.get(key) ?? null; }
  setItem(key: string, value: string): void { this.values.set(key, value); }
  removeItem(key: string): void { this.values.delete(key); }
}

function historyItem(id: string, updatedAt: number, currentTimeSeconds = 120): PlaybackHistoryItem {
  return { id, title: "Synthetic film", group: "Test", contentType: "movie", year: 2024,
    currentTimeSeconds, durationSeconds: 3_600, updatedAt };
}

describe("playback progress persistence", () => {
  it("orders unfinished titles by latest playback and omits completed titles", () => {
    const storage = new MemoryStorage();
    savePlaybackProgress(historyItem("title-a", 10), storage);
    savePlaybackProgress(historyItem("title-b", 20), storage);
    savePlaybackProgress(historyItem("finished", 30, 3_500), storage);

    expect(loadPlaybackHistory(storage).map((item) => item.id)).toEqual(["title-b", "title-a"]);
  });

  it("updates and explicitly removes a title without storing a media URL", () => {
    const storage = new MemoryStorage();
    savePlaybackProgress(historyItem("title-a", 10), storage);
    savePlaybackProgress({ ...historyItem("title-a", 20), providerId: "42", providerKind: "movie", providerExtension: "mkv" }, storage);

    expect(loadPlaybackHistory(storage)[0]?.updatedAt).toBe(20);
    expect(storage.getItem("my-m3u.playback-progress")).not.toContain("streamUrl");
    expect(storage.getItem("my-m3u.playback-progress")).not.toContain("http");
    removePlaybackProgress("title-a", storage);
    expect(loadPlaybackHistory(storage)).toEqual([]);
  });

  it("clears all saved history", () => {
    const storage = new MemoryStorage();
    savePlaybackProgress(historyItem("title-a", 10), storage);
    clearPlaybackProgress(storage);
    expect(loadPlaybackHistory(storage)).toEqual([]);
  });
});
