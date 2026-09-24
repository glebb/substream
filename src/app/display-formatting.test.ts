import { describe, expect, it } from "vitest";
import { formatCategoryBadge, formatGroupDisplayName } from "./display-formatting.ts";

describe("formatGroupDisplayName", () => {
  it("removes repeated collection prefixes without changing the stored name", () => {
    expect(formatGroupDisplayName("Movies: Movies: Action")).toBe("Action");
    expect(formatGroupDisplayName("Movie: Movies: Action")).toBe("Action");
    expect(formatGroupDisplayName("Series - Series - Drama")).toBe("Drama");
    expect(formatGroupDisplayName("TV Series: TV Series: Mystery")).toBe("Mystery");
  });
  it("keeps a legitimate single prefix", () => {
    expect(formatGroupDisplayName("Movies: Action")).toBe("Movies: Action");
    expect(formatGroupDisplayName("Series: Drama")).toBe("Series: Drama");
  });
  it("preserves punctuation and unknown group formats", () => {
    expect(formatGroupDisplayName("Movies: Movies | Action / Classics")).toBe("Action / Classics");
    expect(formatGroupDisplayName("Kids / Movies: Movies: Animated")).toBe("Kids / Movies: Movies: Animated");
    expect(formatGroupDisplayName("  Curated · 2024  ")).toBe("Curated · 2024");
    expect(formatGroupDisplayName("")).toBe("");
  });
});

describe("formatCategoryBadge", () => {
  it("removes a collection prefix from a compact source badge", () => {
    expect(formatCategoryBadge("Series: Apple TV+")).toBe("Apple TV+");
    expect(formatCategoryBadge("Movies: Movies: Action")).toBe("Action");
    expect(formatCategoryBadge("Nordic 4K")).toBe("Nordic 4K");
  });
});
