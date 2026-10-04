import type { VodCatalogItem, VodContentType } from "./types.ts";

/** Selects, de-duplicates, and orders items for the Latest virtual category. */
export function orderLatestVodItems(
  items: readonly VodCatalogItem[],
  contentType: Exclude<VodContentType, "other">,
): VodCatalogItem[] {
  const selectedByIdentity = new Map<string, { item: VodCatalogItem; index: number }>;

  items.forEach((item, index) => {
    if (item.contentType !== contentType) return;
    // Provider stream IDs can have variant URLs/extensions. Local M3U entries
    // use stream identity because their catalogue IDs may include line numbers.
    const key = item.id.startsWith("xtream:")
      ? `provider:${item.id}`
      : item.streamUrl ? `stream:${item.streamUrl}` : `id:${item.id}`;
    const previous = selectedByIdentity.get(key);
    if (!previous || compareItems(item, previous.item) < 0) selectedByIdentity.set(key, { item, index });
  });

  const selected = [...selectedByIdentity.values()];
  selected.sort((a, b) => compareItems(a.item, b.item) || a.index - b.index);
  return selected.map(({ item }) => item);
}

/** Negative means a belongs before b in newest-first ordering. */
function compareItems(a: VodCatalogItem, b: VodCatalogItem): number {
  const aDate = Number.isFinite(a.addedAt) && a.addedAt > 0 ? a.addedAt : 0;
  const bDate = Number.isFinite(b.addedAt) && b.addedAt > 0 ? b.addedAt : 0;
  if (aDate !== bDate) return bDate - aDate;
  const byTitle = a.title.localeCompare(b.title);
  return byTitle || a.id.localeCompare(b.id);
}
