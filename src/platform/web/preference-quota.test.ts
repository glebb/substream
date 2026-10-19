import { describe, expect, it } from "vitest";
import { removeObsoleteCaches, setPreferenceWithEviction } from "./preference-quota.ts";

/** Synthetic localStorage that throws once its total value length exceeds a quota. */
function quotaStorage(quota: number) {
  const values = new Map<string, string>();
  const used = () => [...values.values()].reduce((sum, value) => sum + value.length, 0);
  return {
    values,
    get length() { return values.size; },
    key: (index: number) => [...values.keys()][index] ?? null,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      const previous = values.get(key)?.length ?? 0;
      if (used() - previous + value.length > quota) throw new DOMException("full", "QuotaExceededError");
      values.set(key, value);
    },
    removeItem: (key: string) => { values.delete(key); },
  };
}

describe("preference writes under a full storage quota", () => {
  it("clears guide caches before giving up on a settings write", () => {
    const storage = quotaStorage(100);
    storage.setItem("substream.epg.v2.account.1", "x".repeat(40));
    storage.setItem("substream.epg.v2.account.2", "x".repeat(40));
    storage.setItem("substream.playlist-url", "x".repeat(10));

    expect(setPreferenceWithEviction(storage, "substream.live-countries", '["finland","sweden","norway"]')).toBe(true);
    expect(storage.getItem("substream.live-countries")).toBe('["finland","sweden","norway"]');
    expect(storage.getItem("substream.playlist-url")).toBe("x".repeat(10));
    expect(storage.getItem("substream.epg.v2.account.1")).toBeNull();
  });

  it("clears the live list cache only when guide caches are not enough", () => {
    const storage = quotaStorage(100);
    storage.setItem("substream.live.v3.account", "x".repeat(70));
    storage.setItem("substream.epg.v2.account.1", "x".repeat(20));

    expect(setPreferenceWithEviction(storage, "substream.live-countries", "y".repeat(40))).toBe(true);
    expect(storage.getItem("substream.live.v3.account")).toBeNull();
  });

  it("keeps user settings and reports failure when nothing regenerable can be freed", () => {
    const storage = quotaStorage(20);
    storage.setItem("substream.playlist-url", "x".repeat(20));

    expect(setPreferenceWithEviction(storage, "substream.live-countries", '["finland"]')).toBe(false);
    expect(storage.getItem("substream.playlist-url")).toBe("x".repeat(20));
  });

  it("removes the obsolete Finland-only live cache", () => {
    const storage = quotaStorage(1000);
    storage.setItem("substream.live.v2.account", "old");
    storage.setItem("substream.live.v3.account", "new");
    removeObsoleteCaches(storage);
    expect([...storage.values.keys()]).toEqual(["substream.live.v3.account"]);
  });
});
