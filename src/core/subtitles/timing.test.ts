import { describe, expect, it } from "vitest";
import { adjustSubtitleOffsetSeconds, normalizeSubtitleOffsetSeconds } from "./timing.ts";

describe("subtitle timing", () => {
  it("keeps offsets on half-second steps within the supported range", () => {
    expect(normalizeSubtitleOffsetSeconds(0.74)).toBe(0.5);
    expect(normalizeSubtitleOffsetSeconds(-1.26)).toBe(-1.5);
    expect(normalizeSubtitleOffsetSeconds(10.25)).toBe(10);
    expect(normalizeSubtitleOffsetSeconds(-20)).toBe(-10);
    expect(normalizeSubtitleOffsetSeconds(Number.NaN)).toBe(0);
  });

  it("applies signed quick adjustments and clamps at either bound", () => {
    expect(adjustSubtitleOffsetSeconds(0, -2)).toBe(-2);
    expect(adjustSubtitleOffsetSeconds(-2, 0.5)).toBe(-1.5);
    expect(adjustSubtitleOffsetSeconds(9, 2)).toBe(10);
    expect(adjustSubtitleOffsetSeconds(-9, -2)).toBe(-10);
  });
});
