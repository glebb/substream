import { describe, expect, it } from "vitest";
import { clearFavouriteGroups, loadFavouriteGroupIds, saveFavouriteGroupIds, setFavouriteGroup } from "./favourites-config.ts";

function storage() {
  const values = new Map<string, string>();
  return { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value), removeItem: (key: string) => values.delete(key) };
}

describe("favourite group persistence", () => {
  it("deduplicates and rejects malformed ids", () => {
    const local = storage();
    saveFavouriteGroupIds(["local:Drama", "local:Drama", "https://secret.example/x", ""], local);
    expect(loadFavouriteGroupIds(local)).toEqual(["local:Drama"]);
  });

  it("toggles a group without losing other favourites", () => {
    const local = storage();
    setFavouriteGroup("provider:movie:1", true, local);
    expect(setFavouriteGroup("provider:series:2", true, local)).toEqual(["provider:movie:1", "provider:series:2"]);
    expect(setFavouriteGroup("provider:movie:1", false, local)).toEqual(["provider:series:2"]);
  });

  it("clears stored groups", () => {
    const local = storage();
    saveFavouriteGroupIds(["local:Drama"], local);
    clearFavouriteGroups(local);
    expect(loadFavouriteGroupIds(local)).toEqual([]);
  });
});
