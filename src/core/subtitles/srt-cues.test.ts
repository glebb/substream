import { describe, expect, it } from "vitest";
import { parseSrtCues } from "./srt-cues.ts";

describe("parseSrtCues", () => {
  it("parses numbered and unnumbered SRT cues", () => {
    expect(parseSrtCues("1\n00:00:01,000 --> 00:00:02,500\nHello\nthere\n\n00:00:03.000 --> 00:00:04.000\nBye")).toEqual([
      { startMs: 1_000, endMs: 2_500, text: "Hello\nthere" },
      { startMs: 3_000, endMs: 4_000, text: "Bye" },
    ]);
  });

  it("removes ASS positioning override tags from SRT dialogue", () => {
    expect(parseSrtCues("1\n00:00:01,000 --> 00:00:02,000\n{\\an8}Hej")).toEqual([
      { startMs: 1_000, endMs: 2_000, text: "Hej" },
    ]);
  });

  it("removes inline HTML formatting tags while keeping dialogue", () => {
    expect(parseSrtCues("1\n00:00:01,000 --> 00:00:02,000\n<i>Hei</i><br>maailma")).toEqual([
      { startMs: 1_000, endMs: 2_000, text: "Hei\nmaailma" },
    ]);
  });

  it("normalizes mixed ASS escapes, tags, and entities", () => {
    expect(parseSrtCues("1\n00:00:01,000 --> 00:00:02,000\n{\\pos(1,2)}<font color='red'>Hei\\N&amp; <b>moi</b></font>\\h!"))
      .toEqual([{ startMs: 1_000, endMs: 2_000, text: "Hei\n& moi !" }]);
  });
});
