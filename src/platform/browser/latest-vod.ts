import { orderLatestVodItems } from "../../core/catalog/latest.ts";
import type { VodCatalogItem, VodContentType } from "../../core/catalog/types.ts";

export interface VodGroup {
  id: string;
  name: string;
  count: number;
  contentType: VodContentType | "mixed";
  providerCategoryId?: string;
  providerContentType?: "movie" | "series";
}

export interface LatestVodLoadOptions {
  sourceKey: string;
  contentType: "movie" | "series";
  groups: readonly VodGroup[];
  favouriteIds: readonly string[];
  loadGroup: (group: VodGroup) => Promise<VodCatalogItem[]>;
  force?: boolean;
}

export interface LatestVodLoadResult {
  items: VodCatalogItem[];
  failedGroups: number;
  groupCount: number;
}

const CACHE_TTL_MS = 5 * 60 * 1000;
const MAX_CONCURRENT_GROUPS = 3;

interface CacheEntry {
  items: VodCatalogItem[];
  savedAt: number;
}

export class LatestVodLoader {
  private readonly cache = new Map<string, CacheEntry>();
  private generation = 0;
  private activeSourceKey: string | null = null;

  invalidate(): void {
    this.generation += 1;
    this.activeSourceKey = null;
    this.cache.clear();
  }

  /** Returns any cached snapshot immediately, including stale rows during refresh. */
  peek(options: Pick<LatestVodLoadOptions, "sourceKey" | "contentType" | "groups" | "favouriteIds">): LatestVodLoadResult | null {
    const favouriteIds = new Set(options.favouriteIds);
    const groups = options.groups.filter((group) => {
      if (!favouriteIds.has(group.id)) return false;
      const type = group.providerContentType ?? group.contentType;
      return type === "mixed" || type === options.contentType;
    });
    if (!groups.length) return { items: [], failedGroups: 0, groupCount: 0 };
    const values: VodCatalogItem[] = [];
    let found = false;
    for (const group of groups) {
      const cached = this.cache.get(this.cacheKey(options.sourceKey, group));
      if (!cached) continue;
      found = true;
      // Avoid the browser's function-argument limit on large VOD categories.
      for (const item of cached.items) values.push(item);
    }
    return found ? {
      items: orderLatestVodItems(values, options.contentType),
      failedGroups: 0,
      groupCount: groups.length,
    } : null;
  }

  async load(options: LatestVodLoadOptions): Promise<LatestVodLoadResult> {
    this.activeSourceKey = options.sourceKey;
    // A newer load must also supersede unfinished requests for the same source.
    const requestGeneration = ++this.generation;
    const favouriteIds = new Set(options.favouriteIds);
    const groups = options.groups.filter((group) => {
      if (!favouriteIds.has(group.id)) return false;
      const type = group.providerContentType ?? group.contentType;
      return type === "mixed" || type === options.contentType;
    });
    const now = Date.now();
    const failed = new Set<string>();
    const results = new Map<string, VodCatalogItem[]>();
    const pending: VodGroup[] = [];

    for (const group of groups) {
      const key = this.cacheKey(options.sourceKey, group);
      const cached = this.cache.get(key);
      if (!options.force && cached && now - cached.savedAt < CACHE_TTL_MS) {
        results.set(group.id, cached.items);
      } else {
        pending.push(group);
      }
    }

    let nextIndex = 0;
    const workers = Array.from({ length: Math.min(MAX_CONCURRENT_GROUPS, pending.length) }, async () => {
      while (nextIndex < pending.length && this.isCurrent(requestGeneration, options.sourceKey)) {
        const group = pending[nextIndex++];
        if (!group) continue;
        const key = this.cacheKey(options.sourceKey, group);
        const old = this.cache.get(key);
        try {
          const items = await options.loadGroup(group);
          results.set(group.id, items);
          if (this.isCurrent(requestGeneration, options.sourceKey)) {
            this.cache.set(key, { items, savedAt: Date.now() });
          }
        } catch {
          failed.add(group.id);
          if (old) results.set(group.id, old.items);
        }
      }
    });
    await Promise.all(workers);

    // Preserve category order so ties and duplicate records resolve the same
    // way regardless of which request finishes first.
    const allItems = groups.flatMap((group) => results.get(group.id) ?? []);
    return {
      items: orderLatestVodItems(allItems, options.contentType),
      failedGroups: failed.size,
      groupCount: groups.length,
    };
  }

  private isCurrent(generation: number, sourceKey: string): boolean {
    return this.generation === generation && this.activeSourceKey === sourceKey;
  }

  private cacheKey(sourceKey: string, group: VodGroup): string {
    return `${sourceKey}\u0000${group.providerContentType ?? group.contentType}\u0000${group.id}`;
  }
}
