import { describe, expect, it } from "vitest";
import { BrowseRequestGate, browseGroupsForCollection, browsePageCount, sortAndPageBrowseItems } from "./browse.ts";
import type { VodCatalogItem } from "../core/catalog/index.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (cause?: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function items(prefix: string, count: number): VodCatalogItem[] {
  return Array.from({ length: count }, (_, index) => ({
    id: prefix + "-" + String(index).padStart(3, "0"),
    title: "Title " + String(index).padStart(3, "0"),
    searchTitle: "title " + String(index).padStart(3, "0"),
    searchTerms: [],
    group: prefix,
    contentType: "movie",
    streamUrl: "https://example.invalid/" + prefix + "/" + index,
    year: index % 9 === 0 ? null : 2000 + index % 20,
    addedAt: 1,
    sourceLine: index + 1,
  }));
}

describe("browse helpers", () => {
  it("shows matching provider/local groups and keeps mixed groups reachable", () => {
    const groups = [
      { id: "movie", name: "Films", count: 3, contentType: "movie" as const },
      { id: "series", name: "Shows", count: 2, contentType: "series" as const },
      { id: "mixed", name: "Unsorted", count: 4, contentType: "mixed" as const },
      { id: "provider", name: "Provider films", count: 1, contentType: "other" as const, providerContentType: "movie" as const },
    ];
    expect(browseGroupsForCollection(groups, "movies").map((group) => group.id)).toEqual(["movie", "mixed", "provider"]);
    expect(browseGroupsForCollection(groups, "series").map((group) => group.id)).toEqual(["series", "mixed"]);
  });

  it("sorts and paginates provider categories and episode lists beyond 100 entries", () => {
    for (const source of [items("provider", 237), items("episodes", 143)]) {
      expect(browsePageCount(source.length, 100)).toBeGreaterThan(1);
      const first = sortAndPageBrowseItems(source, 0, 100, "title");
      const second = sortAndPageBrowseItems(source, 1, 100, "title");
      const last = sortAndPageBrowseItems(source, browsePageCount(source.length, 100) - 1, 100, "title");
      expect(first).toHaveLength(100);
      expect(second).toHaveLength(Math.min(100, source.length - 100));
      expect(last).toHaveLength(source.length % 100);
      expect(new Set([...first, ...second, ...last].map((item) => item.id)).size).toBe(source.length);
      expect(first[0]?.title).toBe("Title 000");
    }
  });

  it("keeps unknown release years last and preserves playlist order", () => {
    const source = items("catalog", 30);
    const byYear = sortAndPageBrowseItems(source, 0, 100, "year");
    const firstUnknown = byYear.findIndex((item) => item.year === null);
    expect(firstUnknown).toBeGreaterThan(0);
    expect(byYear.slice(firstUnknown).every((item) => item.year === null)).toBe(true);
    expect(sortAndPageBrowseItems(source, 0, 100, "playlist").map((item) => item.id))
      .toEqual(source.map((item) => item.id));
  });

  it("does not allow an older request to replace a newer category or episode result", async () => {
    const gate = new BrowseRequestGate();
    const older = deferred<string>();
    const newer = deferred<string>();
    const oldResult = gate.run(() => older.promise, "provider failed");
    const newResult = gate.run(() => newer.promise, "episodes failed");
    newer.resolve("episodes");
    older.resolve("provider");
    await expect(newResult).resolves.toEqual({ kind: "ready", value: "episodes" });
    await expect(oldResult).resolves.toEqual({ kind: "stale" });
  });

  it("invalidates a pending request when Back is pressed", async () => {
    const gate = new BrowseRequestGate();
    const pending = deferred<string>();
    const result = gate.run(() => pending.promise, "load failed");
    gate.invalidate();
    pending.resolve("late category");
    await expect(result).resolves.toEqual({ kind: "stale" });
  });

  it("returns a safe local-storage message when IndexedDB rejects", async () => {
    const gate = new BrowseRequestGate();
    const result = await gate.run(async () => { throw new Error("private database details and URL"); }, "Local catalogue could not be loaded. Try again.");
    expect(result).toEqual({ kind: "error", message: "Local catalogue could not be loaded. Try again." });
  });
});
