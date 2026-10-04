import { describe, expect, it } from "vitest";
import { fixedListRowHeight } from "./fixed-list-sizing.ts";

describe("fixedListRowHeight", () => {
  it("leaves normal and long lists at their CSS baseline", () => {
    expect(fixedListRowHeight(600, 10)).toBeNull();
    expect(fixedListRowHeight(600, 30)).toBeNull();
  });

  it("uses spare viewport height for short lists and respects the row maximum", () => {
    expect(fixedListRowHeight(400, 4)).toBe(94);
    expect(fixedListRowHeight(600, 4)).toBe(144);
    expect(fixedListRowHeight(900, 4)).toBe(160);
  });

  it("ignores empty or invalid measurements", () => {
    expect(fixedListRowHeight(0, 4)).toBeNull();
    expect(fixedListRowHeight(600, 0)).toBeNull();
    expect(fixedListRowHeight(Number.NaN, 4)).toBeNull();
  });
});
