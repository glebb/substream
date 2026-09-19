import type { VodCatalogItem } from "../core/catalog/index.ts";
import type { VodGroup, VodSort } from "../platform/web/indexed-db-catalog.ts";

export type BrowseCollection = "recent" | "movies" | "series" | "favourites";
export const BROWSE_COLLECTION_ORDER: readonly BrowseCollection[] = ["favourites", "recent", "movies", "series"];

/** Mixed local groups remain reachable from either typed collection. */
export function browseGroupsForCollection(groups: readonly VodGroup[], collection: Exclude<BrowseCollection, "recent">): VodGroup[] {
  const type = collection === "movies" ? "movie" : "series";
  return groups.filter((group) => group.providerContentType === type || group.contentType === type || group.contentType === "mixed");
}

/** Prioritizes favourites while keeping the catalogue's existing order for ties. */
export function favouriteGroupsFirst(groups: readonly VodGroup[], favouriteIds: readonly string[]): VodGroup[] {
  const favourites = new Set(favouriteIds);
  return groups.map((group, index) => ({ group, index }))
    .sort((left, right) => Number(favourites.has(right.group.id)) - Number(favourites.has(left.group.id)) || left.index - right.index)
    .map(({ group }) => group);
}

/** Keeps focus on the toggled group after reordering, or clamps it when removed from Favourites. */
export function favouriteToggleFocusIndex(
  groups: readonly VodGroup[],
  collection: Exclude<BrowseCollection, "recent">,
  favouriteIds: readonly string[],
  toggledGroupId: string,
  currentIndex: number,
): number {
  const source = collection === "favourites"
    ? groups.filter((group) => favouriteIds.includes(group.id))
    : browseGroupsForCollection(groups, collection);
  const ordered = favouriteGroupsFirst(source, favouriteIds);
  const toggledIndex = ordered.findIndex((group) => group.id === toggledGroupId);
  if (toggledIndex >= 0) return toggledIndex;
  return Math.max(0, Math.min(currentIndex, ordered.length - 1));
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
