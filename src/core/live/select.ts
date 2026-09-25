import type { LiveCategory, LiveChannel, ProviderLiveStream } from "./types.ts";

const FINLAND_CATEGORY_ALIASES = new Set([
  "finland", "finnish", "suomi", "suomalaiset", "finlande", "finlandia",
  "fi finland", "fi suomi", "finland channels", "suomi kanavat",
]);

export function normalizeLiveMetadata(value: string): string {
  return value.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLocaleLowerCase()
    .replace(/[^a-z0-9]+/g, " ").trim();
}

export function isFinnishLiveCategory(name: string, extraAliases: readonly string[] = []): boolean {
  const normalized = normalizeLiveMetadata(name);
  return FINLAND_CATEGORY_ALIASES.has(normalized)
    || normalized.startsWith("finland ")
    || extraAliases.some((alias) => normalizeLiveMetadata(alias) === normalized);
}

export function selectFinnishLiveCategories(categories: readonly LiveCategory[]): LiveCategory[] {
  return categories.filter((category) => isFinnishLiveCategory(category.name));
}

export function selectFinnishChannels(
  categories: readonly LiveCategory[],
  streams: readonly ProviderLiveStream[],
  extraAliases: readonly string[] = [],
  sourceId = "provider",
): { channels: LiveChannel[]; unmatched: LiveChannel[] } {
  const categoryNames = new Map(categories.map((category) => [category.id, category.name]));
  const finnishIds = new Set(categories.filter((category) => isFinnishLiveCategory(category.name, extraAliases)).map((category) => category.id));
  const seen = new Set<string>();
  const channels: LiveChannel[] = [];
  const unmatched: LiveChannel[] = [];
  for (const stream of streams) {
    if (seen.has(stream.streamId)) continue;
    seen.add(stream.streamId);
    const categoryName = categoryNames.get(stream.categoryId) ?? "Unknown category";
    const country = finnishIds.has(stream.categoryId) ? "finland" as const : "unknown" as const;
    const variant = detectVariant(stream.name);
    const channel: LiveChannel = {
      id: `xtream:${sourceId}:live:${stream.streamId}`,
      providerStreamId: stream.streamId,
      providerCategoryId: stream.categoryId,
      name: stream.name,
      logo: stream.logo?.trim() || null,
      providerOrder: stream.order,
      ...(stream.epgId ? { epgId: stream.epgId } : {}),
      ...(variant ? { variant } : {}),
      country,
      evidence: [{
        kind: country === "finland" ? "category-alias" : "unmatched",
        value: categoryName,
        detail: country === "finland" ? "Provider category matched the configured Finland category rule" : "Provider category did not match a configured Finland category rule",
      }],
    };
    (country === "finland" ? channels : unmatched).push(channel);
  }
  channels.sort((left, right) => left.providerOrder - right.providerOrder);
  unmatched.sort((left, right) => left.providerOrder - right.providerOrder);
  return { channels, unmatched };
}

function detectVariant(name: string): string | undefined {
  const match = name.match(/(?:^|[\s([])(4K|UHD|FHD|HD|SD)(?:$|[\s)\]])/i);
  return match?.[1]?.toUpperCase();
}
