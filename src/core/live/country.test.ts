import { describe, expect, it } from "vitest";
import { UNKNOWN_LIVE_COUNTRY, detectLiveCountry, groupLiveCategoriesByCountry, liveCountryLabel } from "./country.ts";

describe("live country detection", () => {
  it("recognizes separated country prefixes and strips them for display", () => {
    expect(detectLiveCountry("Finland - Kansalliset")).toMatchObject({ country: "finland", displayName: "Kansalliset", evidence: { kind: "category-prefix" } });
    expect(detectLiveCountry("FI | SUOMI")).toMatchObject({ country: "finland", displayName: "SUOMI" });
    expect(detectLiveCountry("FINLAND: Urheilu")).toMatchObject({ country: "finland", displayName: "Urheilu" });
    expect(detectLiveCountry("United Kingdom - Sports")).toMatchObject({ country: "united-kingdom", displayName: "Sports" });
    expect(detectLiveCountry("EX YU - Sport")).toMatchObject({ country: "ex-yu" });
    expect(detectLiveCountry("Netherland - Algemeen")).toMatchObject({ country: "netherlands" });
    expect(detectLiveCountry("Turkiye - Ulusal")).toMatchObject({ country: "turkiye" });
    expect(detectLiveCountry("SE: Barn")).toMatchObject({ country: "sweden", displayName: "Barn" });
  });

  it("recognizes bare country names, native names and multi-word names", () => {
    expect(detectLiveCountry("Sweden")).toMatchObject({ country: "sweden", evidence: { kind: "category-name" } });
    expect(detectLiveCountry("Hrvatska")).toMatchObject({ country: "croatia" });
    expect(detectLiveCountry("Srbija")).toMatchObject({ country: "serbia" });
    expect(detectLiveCountry("Crna Gora")).toMatchObject({ country: "montenegro" });
    expect(detectLiveCountry("Hong Kong")).toMatchObject({ country: "hong-kong" });
    expect(detectLiveCountry("Sri Lanka")).toMatchObject({ country: "sri-lanka" });
    expect(detectLiveCountry("Finland Movies")).toMatchObject({ country: "finland" });
  });

  it("keeps unrecognized or ambiguous categories as unknown with evidence", () => {
    for (const name of ["24/7 Movies", "Music", "Radio", "Films", "IT Crowd Marathon", "NO Limits"]) {
      expect(detectLiveCountry(name)).toMatchObject({ country: UNKNOWN_LIVE_COUNTRY, evidence: { kind: "unmatched", value: name } });
    }
    expect(detectLiveCountry("Nordic Finland Premium").country).not.toBe("finland");
  });

  it("groups categories by country in provider order with Other last", () => {
    const groups = groupLiveCategoriesByCountry([
      { id: "1", name: "Sweden - Nationella" },
      { id: "2", name: "Radio" },
      { id: "3", name: "Finland - Viaplay" },
      { id: "4", name: "Sweden" },
      { id: "5", name: "Finland - Kansalliset" },
    ]);
    expect(groups.map((group) => [group.country, group.categories.map((category) => category.id)])).toEqual([
      ["finland", ["3", "5"]],
      ["sweden", ["1", "4"]],
      [UNKNOWN_LIVE_COUNTRY, ["2"]],
    ]);
    expect(liveCountryLabel(UNKNOWN_LIVE_COUNTRY)).toBe("Other");
  });
});
