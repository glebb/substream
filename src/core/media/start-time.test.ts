import { describe, expect, it } from "vitest";
import { clampStartTime, parseStartTime } from "./start-time.ts";

describe("local TV start time", () => {
  it("parses clock times and plain minutes", () => {
    expect(parseStartTime("1:02:03")).toBe(3_723);
    expect(parseStartTime(" 45:30 ")).toBe(2_730);
    expect(parseStartTime("90")).toBe(5_400);
    expect(parseStartTime("")).toBe(0);
  });

  it("rejects text that is not a time", () => {
    for (const value of ["1:60", "1:61:00", "abc", "1:2:3:4", "-5", "1.5", ":30"]) expect(parseStartTime(value)).toBeNull();
  });

  it("clamps to the known duration", () => {
    expect(clampStartTime(5_000, 3_600.4)).toBe(3_600);
    expect(clampStartTime(-1, 100)).toBe(0);
    expect(clampStartTime(42.9, null)).toBe(42);
    expect(clampStartTime(Number.NaN, 100)).toBe(0);
  });
});
