import { describe, expect, it } from "vitest";
import { normalizeEpgProgrammes, selectCurrentAndNextProgramme } from "./epg.ts";
import type { EpgProgramme } from "./types.ts";

const programme = (
  title: string,
  startTime: number,
  endTime: number,
  channelId = "channel-1",
): EpgProgramme => ({ channelId, title, startTime, endTime });

describe("EPG programme selection", () => {
  it("selects current and next from an unsorted schedule", () => {
    const later = programme("News", 2_000, 3_000);
    const current = programme("Show", 1_000, 2_000);
    expect(selectCurrentAndNextProgramme([later, current], 1_500)).toEqual({
      current,
      next: later,
    });
  });

  it("treats end times as exclusive and selects the programme starting at now", () => {
    const ended = programme("Earlier", 0, 1_000);
    const current = programme("Starting now", 1_000, 2_000);
    expect(selectCurrentAndNextProgramme([ended, current], 1_000)).toEqual({
      current,
      next: null,
    });
  });

  it("chooses the most recently started active programme in overlaps", () => {
    const broad = programme("Long entry", 0, 5_000);
    const specific = programme("Later entry", 1_000, 3_000);
    const overlapping = programme("Overlap", 2_500, 4_000);
    const next = programme("Next", 4_000, 5_000);
    expect(selectCurrentAndNextProgramme([broad, overlapping, next, specific], 2_750)).toEqual({
      current: overlapping,
      next,
    });
  });

  it("returns the next upcoming programme when nothing is currently airing", () => {
    const upcoming = programme("Upcoming", 2_000, 3_000);
    expect(selectCurrentAndNextProgramme([upcoming], 1_999)).toEqual({
      current: null,
      next: upcoming,
    });
  });

  it("normalizes order and removes invalid entries and exact duplicates", () => {
    const valid = programme("Valid", 1_000, 2_000);
    const result = normalizeEpgProgrammes([
      programme("Bad interval", 2_000, 1_000),
      valid,
      { ...valid },
      programme("", 0, 500),
      programme("Bad time", Number.NaN, 500),
      programme("Earlier", 0, 500),
    ]);
    expect(result).toEqual([programme("Earlier", 0, 500), valid]);
  });

  it("returns an empty selection for a non-finite clock value", () => {
    expect(selectCurrentAndNextProgramme([programme("Show", 0, 1_000)], Number.NaN)).toEqual({
      current: null,
      next: null,
    });
  });
});
