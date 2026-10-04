import { describe, expect, it } from "vitest";
import { searchFocusTarget, searchResultFocusTarget } from "./search-navigation.ts";
import { browseGridColumnCount } from "./remote-navigation.ts";

describe("search remote navigation", () => {
  it("keeps a visible edit trigger between the collection tab and refresh action", () => {
    expect(searchFocusTarget("trigger", "ArrowUp", true)).toBe("tab");
    expect(searchFocusTarget("trigger", "ArrowDown", true)).toBe("refresh");
    expect(searchFocusTarget("refresh", "ArrowUp", true)).toBe("trigger");
  });

  it("routes the editor to refresh or results without stealing horizontal text editing", () => {
    expect(searchFocusTarget("editor", "ArrowDown", true)).toBe("refresh");
    expect(searchFocusTarget("editor", "ArrowLeft", true)).toBe("native");
    expect(searchFocusTarget("refresh", "ArrowDown", true)).toBe("results");
    expect(searchFocusTarget("refresh", "ArrowDown", false)).toBeNull();
  });

  it("connects the horizontal control row to the tab and top menu even without results", () => {
    expect(searchFocusTarget("trigger", "ArrowLeft", false)).toBe("tab");
    expect(searchFocusTarget("trigger", "ArrowRight", false)).toBe("refresh");
    expect(searchFocusTarget("refresh", "ArrowLeft", false)).toBe("trigger");
    expect(searchFocusTarget("refresh", "ArrowRight", false)).toBe("main-menu");
    expect(searchFocusTarget("trigger", "Enter", true)).toBeNull();
  });

  it("returns every first-row result to Refresh and preserves row boundaries", () => {
    for (let index = 0; index < 4; index++) {
      expect(searchResultFocusTarget("ArrowUp", index, 7, 4)).toBe("refresh");
    }
    expect(searchResultFocusTarget("ArrowDown", 2, 7, 4)).toBe(6);
    expect(searchResultFocusTarget("ArrowUp", 6, 7, 4)).toBe(2);
    expect(searchResultFocusTarget("ArrowRight", 3, 7, 4)).toBeNull();
    expect(searchResultFocusTarget("ArrowRight", 6, 7, 4)).toBeNull();
    expect(searchResultFocusTarget("ArrowDown", 3, 7, 4)).toBeNull();
  });

  it("matches the search grid at medium TV, compact and narrow widths", () => {
    const mediumTvColumns = browseGridColumnCount(false, false, false);
    expect(mediumTvColumns).toBe(4);
    expect(searchResultFocusTarget("ArrowDown", 0, 7, mediumTvColumns)).toBe(4);
    const compactColumns = browseGridColumnCount(false, true, false);
    expect(searchResultFocusTarget("ArrowDown", 0, 7, compactColumns)).toBe(2);
    const narrowColumns = browseGridColumnCount(false, true, true);
    expect(searchResultFocusTarget("ArrowDown", 0, 7, narrowColumns)).toBe(1);
    expect(searchResultFocusTarget("ArrowUp", 1, 7, narrowColumns)).toBe(0);
  });

  it("does not navigate missing or stale results", () => {
    expect(searchResultFocusTarget("ArrowUp", 0, 0, 4)).toBeNull();
    expect(searchResultFocusTarget("ArrowDown", 8, 7, 4)).toBeNull();
    expect(searchResultFocusTarget("ArrowLeft", -1, 7, 4)).toBeNull();
  });
});
