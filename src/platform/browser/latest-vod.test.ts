import { describe, expect, it, vi } from "vitest";
import { LatestVodLoader, type VodGroup } from "./latest-vod.ts";
import type { VodCatalogItem } from "../../core/catalog/types.ts";

const groups: VodGroup[] = [
  { id: "m1", name: "Movies", count: 1, contentType: "movie" },
  { id: "s1", name: "Series", count: 1, contentType: "series" },
  { id: "mixed", name: "Mixed", count: 1, contentType: "mixed" },
  { id: "m2", name: "Other movies", count: 1, contentType: "movie" },
  { id: "m3", name: "More movies", count: 1, contentType: "movie" },
];
function item(id: string, type: "movie" | "series", addedAt: number, url = id): VodCatalogItem {
  return { id, title: id, searchTitle: id, searchTerms: [id], year: null, group: "g", contentType: type, addedAt, streamUrl: url, sourceLine: 1 };
}
const base = { sourceKey: "account", contentType: "movie" as const, groups, favouriteIds: ["m1", "s1", "mixed"], loadGroup: async (group: VodGroup) => group.id === "s1" ? [item("series", "series", 9)] : group.id === "mixed" ? [item("movie", "movie", 8), item("show", "series", 10)] : [item("movie", "movie", 7)] };

describe("LatestVodLoader", () => {
  it("loads only favorite type-compatible groups and filters mixed group items", async () => {
    const loader = new LatestVodLoader();
    const result = await loader.load(base);
    expect(result.groupCount).toBe(2);
    expect(result.items.map(({ id }) => id)).toEqual(["movie"]); // duplicate stream identity is emitted once
  });

  it("uses cache, retains cached rows on failures, and force refreshes", async () => {
    const loader = new LatestVodLoader();
    const loadGroup = vi.fn(async () => [item("x", "movie", 10)]);
    await loader.load({ ...base, favouriteIds: ["m1"], loadGroup });
    await loader.load({ ...base, favouriteIds: ["m1"], loadGroup });
    expect(loadGroup).toHaveBeenCalledTimes(1);
    const failed = await loader.load({ ...base, favouriteIds: ["m1"], loadGroup: async () => { throw new Error("synthetic"); }, force: true });
    expect(failed.failedGroups).toBe(1);
    expect(failed.items.map(({ id }) => id)).toEqual(["x"]);
  });

  it("limits concurrency and does not cache late results after invalidation", async () => {
    const loader = new LatestVodLoader();
    let active = 0;
    let maximum = 0;
    let started = 0;
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const loadGroup = async (group: VodGroup) => {
      started += 1;
      active += 1; maximum = Math.max(maximum, active);
      await blocked;
      active -= 1;
      return [item(group.id, "movie", 1)];
    };
    const running = loader.load({ ...base, favouriteIds: ["m1", "m2", "m3", "mixed"], loadGroup });
    await Promise.resolve();
    loader.invalidate();
    release();
    await running;
    expect(maximum).toBeLessThanOrEqual(3);
    expect(active).toBe(0);
    expect(maximum).toBe(3);
    expect(started).toBe(3); // the queued fourth group was never dispatched
    const next = await loader.load({ ...base, favouriteIds: ["m1"], loadGroup: async () => [item("fresh", "movie", 2)] });
    expect(next.items.map(({ id }) => id)).toEqual(["fresh"]);
  });

  it("assembles equal records in group order despite reverse request completion", async () => {
    const loader = new LatestVodLoader();
    const orderedGroups = [groups[0]!, groups[3]!];
    const result = await loader.load({
      ...base,
      groups: orderedGroups,
      favouriteIds: orderedGroups.map(({ id }) => id),
      loadGroup: async (group) => {
        await new Promise((resolve) => setTimeout(resolve, group.id === "m1" ? 10 : 0));
        return [item("same", "movie", 5, `stream:${group.id}`)];
      },
    });
    expect(result.items.map(({ streamUrl }) => streamUrl)).toEqual(["stream:m1", "stream:m2"]);
  });

  it("does not let an older same-source request replace the refreshed cache", async () => {
    const loader = new LatestVodLoader();
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const options = { ...base, favouriteIds: ["m1"] };
    const older = loader.load({ ...options, loadGroup: async () => {
      await blocked;
      return [item("old", "movie", 1)];
    } });
    await loader.load({ ...options, force: true, loadGroup: async () => [item("new", "movie", 2)] });
    release();
    await older;
    expect(loader.peek(options)?.items.map(({ id }) => id)).toEqual(["new"]);
  });
});
