import { describe, expect, it } from "vitest";
import { attachDnaFallback, fillMissingGuideSlots, matchDnaChannel } from "./dna.ts";
import { selectCurrentAndNextProgramme } from "./epg.ts";
import type { EpgProgramme, LiveChannel } from "./types.ts";

const channel: LiveChannel = {
  id: "provider:1", providerStreamId: "1", providerCategoryId: "fi", name: "Yle TV1 HD", logo: null,
  providerOrder: 0, country: "finland", evidence: [{ kind: "category-alias", value: "Finland", detail: "fixture" }],
};

describe("DNA channel fallback mapping", () => {
  it("matches exact normalized names, attaches DNA metadata and records evidence", () => {
    const match = matchDnaChannel(channel, [{ id: "ch-1118", name: "Yle TV1", logo: "https://img.dna.fi/yle.png" }]);
    expect(match?.evidence.kind).toBe("normalized-exact-name");
    expect(attachDnaFallback(channel, match)).toMatchObject({ dnaChannelId: "ch-1118", dnaLogo: "https://img.dna.fi/yle.png" });
  });

  it("leaves ambiguous or merely similar names unmatched", () => {
    expect(matchDnaChannel(channel, [
      { id: "ch-a", name: "Yle TV1", logo: null }, { id: "ch-b", name: "Yle TV1 HD", logo: null },
    ])).toBeNull();
    expect(matchDnaChannel(channel, [{ id: "ch-a", name: "Yle TV1 Plus", logo: null }])).toBeNull();
  });

  it("handles the provider's Finland and subtitle labels plus curated DNA naming aliases", () => {
    const providerName = { ...channel, name: "FI: Yle TV1 FHD [Multi-Sub]" };
    expect(matchDnaChannel(providerName, [{ id: "ch-1118", name: "Yle TV1", logo: null }])?.evidence.kind).toBe("normalized-exact-name");
    for (const [provider, dna] of [
      ["STAR", "STAR Channel"], ["National Geographic Wild", "Nat Geo Wild"], ["V Winter", "V Sport Vinter"], ["V Vinter", "V Sport Vinter"],
      ["FI: Nelonen 4 FHD", "Nelonen"], ["FI: V Ultra UHD", "V Sport Ultra"], ["FI: V Fotboll FHD", "V Sport Fotboll"],
      ["FI: V Golf FHD", "V Sport Golf"], ["FI: Liiga 1 FHD [Live During Events Only]", "MTV Liiga 1"],
      ["Liiga 2", "MTV Liiga 2"], ["Liiga 3", "MTV Liiga 3"], ["Liiga 4", "MTV Liiga 4"],
      ["Liiga 5", "MTV Liiga 5"], ["Liiga 6", "MTV Liiga 6"], ["Liiga 7", "MTV Liiga 7"],
    ]) {
      const dnaName = provider === "FI: V Fotboll FHD" ? "V sport football" : dna!;
      const match = matchDnaChannel({ ...channel, name: provider! }, [{ id: "ch-alias", name: dnaName, logo: null }]);
      expect(match?.evidence.kind).toBe("curated-alias");
    }
    expect(matchDnaChannel({ ...channel, name: "Yle TV1 [Multi-Audio]" }, [{ id: "ch-1", name: "Yle TV1", logo: null }])).not.toBeNull();
  });

  it("fills only missing current and next slots, including a next-only schedule", () => {
    const now = 1_800_000_000_000;
    const programme = (title: string, startTime: number, endTime: number): EpgProgramme => ({ channelId: "x", title, startTime, endTime });
    const dna = [programme("DNA Current", now - 10_000, now + 10_000), programme("DNA Next", now + 10_000, now + 20_000)];
    const provider = programme("Provider Current", now - 10_000, now + 10_000);
    expect(fillMissingGuideSlots([provider], dna, now)).toEqual([provider, dna[1]]);
    expect(fillMissingGuideSlots([], dna, now)).toEqual(dna);
    const future = programme("Future", now + 10_000, now + 20_000);
    expect(fillMissingGuideSlots([future], [], now)).toEqual([future]);
    expect(fillMissingGuideSlots([], [future], now)).toEqual([future]);
  });

  it("replaces a provider next slot that overlaps the selected DNA current programme", () => {
    const now = 1_800_000_000_000;
    const programme = (channelId: string, title: string, startTime: number, endTime: number): EpgProgramme => ({ channelId, title, startTime, endTime });
    const providerNext = programme("provider", "Provider Next", now + 20_000, now + 50_000);
    const dnaCurrent = programme("ch-1", "DNA Current", now - 10_000, now + 100_000);
    const dnaNext = programme("ch-1", "DNA Next", now + 100_000, now + 150_000);
    const merged = fillMissingGuideSlots([providerNext], [dnaCurrent, dnaNext], now);
    expect(selectCurrentAndNextProgramme(merged, now)).toEqual({ current: dnaCurrent, next: dnaNext });
  });

  it("searches later DNA entries when its immediate next programme overlaps provider current", () => {
    const now = 1_800_000_000_000;
    const programme = (channelId: string, title: string, startTime: number, endTime: number): EpgProgramme => ({ channelId, title, startTime, endTime });
    const providerCurrent = programme("provider", "Provider Current", now - 20_000, now + 60_000);
    const providerOverlap = programme("provider", "Provider Overlap", now + 30_000, now + 50_000);
    const dnaCurrent = programme("ch-1", "DNA Current", now - 10_000, now + 20_000);
    const dnaEarly = programme("ch-1", "DNA Early Next", now + 20_000, now + 40_000);
    const dnaLater = programme("ch-1", "DNA Later Next", now + 80_000, now + 110_000);
    const merged = fillMissingGuideSlots([providerCurrent, providerOverlap], [dnaCurrent, dnaEarly, dnaLater], now);
    expect(selectCurrentAndNextProgramme(merged, now)).toEqual({ current: providerCurrent, next: dnaLater });
  });
});
