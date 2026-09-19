import { describe, expect, it } from "vitest";
import { clearFavouriteGroups, defaultFavouriteGroupIds, hasSavedFavouriteGroupIds, loadFavouriteGroupIds, saveFavouriteGroupIds, setFavouriteGroup } from "./favourites-config.ts";

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

  it("distinguishes no saved selection from an explicitly empty selection", () => {
    const local = storage();
    expect(hasSavedFavouriteGroupIds(local)).toBe(false);
    saveFavouriteGroupIds([], local);
    expect(hasSavedFavouriteGroupIds(local)).toBe(true);
    expect(loadFavouriteGroupIds(local)).toEqual([]);
  });

  it("resolves first-run defaults from both single and double-prefixed provider names", () => {
    const groups = [
      { id: "movie-action", name: "Movies: Movies: Action", providerContentType: "movie" as const },
      { id: "series-netflix", name: "Series: Series: Netflix", providerContentType: "series" as const },
      { id: "movie-uncategorized", name: "Movies: Other", providerContentType: "movie" as const },
      { id: "local-action", name: "Action", contentType: "movie" as const },
    ];
    expect(defaultFavouriteGroupIds(groups)).toEqual(["movie-action", "series-netflix", "local-action"]);
  });
});
