import { afterEach, describe, expect, it, vi } from "vitest";
import { MAX_LOCAL_SUBTITLE_BYTES, readLocalSubtitleFile } from "./local-subtitle-file.ts";

class SyntheticFileReader {
  result: string | null = null;
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onabort: (() => void) | null = null;
  async readAsText(file: File) {
    this.result = await file.text();
    this.onload?.();
  }
}

describe("local subtitle files", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("reads valid SRT and short-timestamp WebVTT through FileReader", async () => {
    vi.stubGlobal("FileReader", SyntheticFileReader);
    const srt = new File(["1\r\n00:00:01,000 --> 00:00:02,000\r\nHello\r\n"], "sub.srt");
    const vtt = new File(["WEBVTT\n\n00:01.000 --> 00:02.000\nHello\n"], "sub.vtt");
    await expect(readLocalSubtitleFile(srt)).resolves.toMatchObject({ label: "sub.srt", text: "1\n00:00:01,000 --> 00:00:02,000\nHello\n" });
    await expect(readLocalSubtitleFile(vtt)).resolves.toMatchObject({ label: "sub.vtt", text: expect.stringContaining("WEBVTT") });
  });

  it("rejects unsupported names, malformed cues, and oversized files", async () => {
    vi.stubGlobal("FileReader", SyntheticFileReader);
    await expect(readLocalSubtitleFile(new File(["bad"], "subtitle.txt"))).rejects.toThrow("Choose an SRT or WebVTT");
    await expect(readLocalSubtitleFile(new File(["WEBVTT\nno cues"], "subtitle.vtt"))).rejects.toThrow("does not contain supported");
    const large = { name: "subtitle.srt", size: MAX_LOCAL_SUBTITLE_BYTES + 1 } as File;
    await expect(readLocalSubtitleFile(large)).rejects.toThrow("maximum 2 MB");
  });
});
