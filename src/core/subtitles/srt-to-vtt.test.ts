import { describe, expect, it } from "vitest";
import { srtToWebVtt } from "./srt-to-vtt.ts";

describe("srtToWebVtt", () => {
  it("converts SRT timestamps to a WebVTT document", () => {
    expect(srtToWebVtt("1\r\n00:00:01,200 --> 00:00:03,450\r\nHello\r\n")).toBe(
      "WEBVTT\n\n1\n00:00:01.200 --> 00:00:03.450\nHello\n",
    );
  });

  it("preserves existing WebVTT", () => {
    expect(srtToWebVtt("WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nHi\n")).toContain("WEBVTT");
  });
});
