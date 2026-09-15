const COLLECTION_PREFIX = /^(movies|movie|series|tv\s*series)\s*[:|/·\-–—]\s*/i;

function prefixKind(value: string): "movies" | "series" | "other" {
  const normalized = value.toLowerCase().replace(/\s+/g, " ");
  if (normalized === "movie" || normalized === "movies") return "movies";
  if (normalized === "series" || normalized === "tv series") return "series";
  return "other";
}

/** Formats provider group names for visual display without mutating records. */
export function formatGroupDisplayName(name: string): string {
  const original = name.trim();
  if (!original) return original;
  const first = original.match(COLLECTION_PREFIX);
  if (!first) return original;

  const prefix = prefixKind(first[1] ?? "");
  let remainder = original.slice(first[0].length).trim();
  let repeated = false;
  while (remainder) {
    const next = remainder.match(COLLECTION_PREFIX);
    if (!next || prefixKind(next[1] ?? "") !== prefix) break;
    repeated = true;
    remainder = remainder.slice(next[0].length).trim();
  }
  return repeated && remainder ? remainder : original;
}
