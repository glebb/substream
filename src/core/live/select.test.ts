import { describe, expect, it } from "vitest";
import { isFinnishLiveCategory, selectFinnishChannels, selectFinnishLiveCategories } from "./select.ts";

describe("Finnish live selection", () => {
  it("uses exact normalized aliases instead of broad substrings", () => {
    expect(isFinnishLiveCategory("FI | SUOMI")).toBe(true);
    expect(isFinnishLiveCategory("Finland")).toBe(true);
    expect(isFinnishLiveCategory("Finland - Kansalliset")).toBe(true);
    expect(isFinnishLiveCategory("FINLAND: Urheilu")).toBe(true);
    expect(isFinnishLiveCategory("Films")).toBe(false);
    expect(isFinnishLiveCategory("Nordic Finland Premium")).toBe(false);
  });

  it("keeps every Finland category in provider order", () => {
    expect(selectFinnishLiveCategories([
      { id: "1", name: "Sweden - Nationella" },
      { id: "2", name: "Finland - Kansalliset" },
      { id: "3", name: "Finland - Viaplay" },
      { id: "4", name: "Norway - Sport" },
    ])).toEqual([
      { id: "2", name: "Finland - Kansalliset" },
      { id: "3", name: "Finland - Viaplay" },
    ]);
  });

  it("keeps evidence, variants and unmatched channels while deduplicating stream ids", () => {
    const result = selectFinnishChannels(
      [{ id: "10", name: "SUOMI" }, { id: "20", name: "Sweden" }],
      [
        { streamId: "2", categoryId: "10", name: "Yle TV1 HD", order: 2 },
        { streamId: "2", categoryId: "10", name: "Duplicate", order: 3 },
        { streamId: "3", categoryId: "20", name: "SVT", order: 1 },
      ],
    );
    expect(result.channels).toMatchObject([{ name: "Yle TV1 HD", variant: "HD", country: "finland" }]);
    expect(result.channels[0]?.evidence[0]?.kind).toBe("category-alias");
    expect(result.unmatched).toMatchObject([{ name: "SVT", country: "unknown" }]);
  });
});
