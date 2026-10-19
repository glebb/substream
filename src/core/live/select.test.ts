import { describe, expect, it } from "vitest";
import { selectLiveCategoriesForCountries, selectLiveChannels } from "./select.ts";

describe("live selection", () => {
  it("keeps every category of the selected countries in provider order", () => {
    const categories = [
      { id: "1", name: "Sweden - Nationella" },
      { id: "2", name: "Finland - Kansalliset" },
      { id: "3", name: "Finland - Viaplay" },
      { id: "4", name: "Norway - Sport" },
      { id: "5", name: "Music" },
    ];
    expect(selectLiveCategoriesForCountries(categories, ["finland"]).map((category) => category.id)).toEqual(["2", "3"]);
    expect(selectLiveCategoriesForCountries(categories, ["norway", "finland"]).map((category) => category.id)).toEqual(["2", "3", "4"]);
    expect(selectLiveCategoriesForCountries(categories, ["unknown"]).map((category) => category.id)).toEqual(["5"]);
  });

  it("keeps evidence, variants and unmatched channels while deduplicating stream ids", () => {
    const result = selectLiveChannels(
      [{ id: "10", name: "SUOMI" }, { id: "20", name: "Sweden" }],
      [
        { streamId: "2", categoryId: "10", name: "Yle TV1 HD", order: 2 },
        { streamId: "2", categoryId: "10", name: "Duplicate", order: 3 },
        { streamId: "3", categoryId: "20", name: "SVT", order: 1 },
      ],
      ["finland"],
    );
    expect(result.channels).toMatchObject([{ name: "Yle TV1 HD", variant: "HD", country: "finland" }]);
    expect(result.channels[0]?.evidence[0]?.kind).toBe("category-name");
    expect(result.unmatched).toMatchObject([{ name: "SVT", country: "sweden" }]);
  });

  it("tags every channel with its country when no country filter is given", () => {
    const result = selectLiveChannels(
      [{ id: "7", name: "Radio" }],
      [{ streamId: "9", categoryId: "7", name: "Radio One", order: 1 }],
    );
    expect(result.channels).toMatchObject([{ name: "Radio One", country: "unknown", evidence: [{ kind: "unmatched" }] }]);
    expect(result.unmatched).toEqual([]);
  });
});
