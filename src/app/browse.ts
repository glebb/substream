import type { VodCatalogItem } from "../core/catalog/index.ts";
import type { VodGroup, VodSort } from "../platform/web/indexed-db-catalog.ts";

export type BrowseCollection = "recent" | "movies" | "series" | "favourites";

/** Mixed local groups remain reachable from either typed collection. */
export function browseGroupsForCollection(groups: readonly VodGroup[], collection: Exclude<BrowseCollection, "recent">): VodGroup[] {
  const type = collection === "movies" ? "movie" : "series";
  return groups.filter((group) => group.providerContentType === type || group.contentType === type || group.contentType === "mixed");
}

export type BrowseRequestResult<T> =
  | { kind: "ready"; value: T }
  | { kind: "stale" }
  | { kind: "error"; message: string };

/** Keeps older asynchronous browse operations from replacing the current view. */
export class BrowseRequestGate {
  private revision = 0;

  invalidate() {
    this.revision += 1;
  }

  async run<T>(load: () => Promise<T>, errorMessage: string): Promise<BrowseRequestResult<T>> {
    const request = ++this.revision;
    try {
      const value = await load();
      return request === this.revision ? { kind: "ready", value } : { kind: "stale" };
    } catch {
      return request === this.revision ? { kind: "error", message: errorMessage } : { kind: "stale" };
    }
  }
}

export function sortAndPageBrowseItems(items: VodCatalogItem[], page: number, pageSize: number, sort: VodSort) {
  const ordered = items.map((item, index) => ({ item, index }));
  if (sort === "title") {
    ordered.sort((a, b) => a.item.title.localeCompare(b.item.title) || a.index - b.index);
  } else if (sort === "year") {
    ordered.sort((a, b) => {
      if (a.item.year === null) return b.item.year === null ? a.index - b.index : 1;
      if (b.item.year === null) return -1;
      return b.item.year - a.item.year || a.item.title.localeCompare(b.item.title) || a.index - b.index;
    });
  }
  const offset = Math.max(0, page) * pageSize;
  return ordered.slice(offset, offset + pageSize).map(({ item }) => item);
}

export function browsePageCount(count: number, pageSize: number) {
  return Math.max(1, Math.ceil(count / pageSize));
}
