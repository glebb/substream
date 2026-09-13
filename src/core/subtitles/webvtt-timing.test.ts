import { describe, expect, it } from "vitest";
import { shiftWebVttCues } from "./webvtt-timing.ts";

describe("shiftWebVttCues", () => {
  it("delays cues while retaining metadata, identifiers, settings, and text", () => {
    const source = "WEBVTT\n\nNOTE generated subtitles\nKeep this time 00:00:01.000\n\ncue-1\n00:00:01.250 --> 00:00:02.500 align:start\nHello\n";
    expect(shiftWebVttCues(source, 1.5)).toBe(
      "WEBVTT\n\nNOTE generated subtitles\nKeep this time 00:00:01.000\n\ncue-1\n00:00:02.750 --> 00:00:04.000 align:start\nHello\n",
    );
  });

  it("advances cues, clips cues crossing zero, and drops cues moved fully before zero", () => {
    const source = "WEBVTT\n\n00:00:00.500 --> 00:00:01.500\nClip me\n\n00:00:00.250 --> 00:00:00.750\nDrop me\n";
    expect(shiftWebVttCues(source, -1)).toBe("WEBVTT\n\n00:00:00.000 --> 00:00:00.500\nClip me\n");
  });

  it("leaves cue blocks with unsupported or invalid timing unchanged", () => {
    const source = "WEBVTT\n\n00:99:00.000 --> 00:99:01.000\nInvalid minutes\n";
    expect(shiftWebVttCues(source, 0.5)).toBe(source);
  });
});
