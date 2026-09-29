import { finnishCategories } from "./locales/categories.fi.ts";

const COLLECTION_PREFIX = /^(movies|movie|series|tv\s*series)\s*[:|/·\-–—]\s*/i;

function categoryKey(value: string): string {
  return value.trim().toLocaleLowerCase().replace(/\s+/g, " ");
}

function localizeKnownCategory(value: string, language: "fi" | "en"): string {
  if (language !== "fi") return value;
  const key = categoryKey(value);
  if (finnishCategories[key]) return finnishCategories[key];
  const pieces = value.split(/(\s*[|/&,+]\s*|\s+-\s+)/);
  if (pieces.length > 1) {
    const mapped = pieces.map((piece) => {
      const separator = piece.match(/^\s*[|/&,+-]\s*$/);
      return separator ? piece : finnishCategories[categoryKey(piece)] ?? "";
    });
    if (mapped.every((piece, index) => piece || /^\s*[|/&,+-]\s*$/.test(pieces[index] ?? ""))) return mapped.join("");
  }
  return value;
}

function prefixKind(value: string): "movies" | "series" | "other" {
  const normalized = value.toLowerCase().replace(/\s+/g, " ");
  if (normalized === "movie" || normalized === "movies") return "movies";
  if (normalized === "series" || normalized === "tv series") return "series";
  return "other";
}

/** Formats provider group names for visual display without mutating records. */
export function formatGroupDisplayName(name: string, language: "fi" | "en" = "en"): string {
  const original = name.trim();
  if (!original) return original;
  const first = original.match(COLLECTION_PREFIX);
  if (!first) return localizeKnownCategory(original, language);

  const prefix = prefixKind(first[1] ?? "");
  let remainder = original.slice(first[0].length).trim();
  let repeated = false;
  while (remainder) {
    const next = remainder.match(COLLECTION_PREFIX);
    if (!next || prefixKind(next[1] ?? "") !== prefix) break;
    repeated = true;
    remainder = remainder.slice(next[0].length).trim();
  }
  const display = repeated && remainder ? remainder : original;
  const category = display.match(COLLECTION_PREFIX)?.[0] ? display.replace(COLLECTION_PREFIX, "").trim() : display;
  const localized = localizeKnownCategory(category, language);
  return localized !== category ? localized : display;
}

/** Compact provider category text for badges; the tab already states its type. */
export function formatCategoryBadge(name: string, language: "fi" | "en" = "en"): string {
  const value = formatGroupDisplayName(name, language);
  const category = value.replace(COLLECTION_PREFIX, "").trim() || value;
  return localizeKnownCategory(category, language);
}
