import { detectLiveCountry } from "./country.ts";
import type { LiveCategory, LiveChannel, ProviderLiveStream } from "./types.ts";

export { normalizeLiveMetadata } from "./country.ts";

/** Keeps provider categories whose detected country is selected, in provider order. */
export function selectLiveCategoriesForCountries(categories: readonly LiveCategory[], countries: readonly string[]): LiveCategory[] {
  const selected = new Set(countries);
  return categories.filter((category) => selected.has(detectLiveCountry(category.name).country));
}

/**
 * Builds channels for streams in the given categories. With `countries`, streams
 * from other countries are kept separately as `unmatched` instead of discarded.
 */
export function selectLiveChannels(
  categories: readonly LiveCategory[],
  streams: readonly ProviderLiveStream[],
  countries: readonly string[] | null = null,
  sourceId = "provider",
): { channels: LiveChannel[]; unmatched: LiveChannel[] } {
  const matches = new Map(categories.map((category) => [category.id, detectLiveCountry(category.name)]));
  const selected = countries ? new Set(countries) : null;
  const seen = new Set<string>();
  const channels: LiveChannel[] = [];
  const unmatched: LiveChannel[] = [];
  for (const stream of streams) {
    if (seen.has(stream.streamId)) continue;
    seen.add(stream.streamId);
    const match = matches.get(stream.categoryId) ?? detectLiveCountry("");
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
      country: match.country,
      evidence: [match.evidence],
    };
    (!selected || selected.has(match.country) ? channels : unmatched).push(channel);
  }
  channels.sort((left, right) => left.providerOrder - right.providerOrder);
  unmatched.sort((left, right) => left.providerOrder - right.providerOrder);
  return { channels, unmatched };
}

function detectVariant(name: string): string | undefined {
  const match = name.match(/(?:^|[\s([])(4K|UHD|FHD|HD|SD)(?:$|[\s)\]])/i);
  return match?.[1]?.toUpperCase();
}
