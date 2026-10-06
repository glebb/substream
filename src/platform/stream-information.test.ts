import { describe, expect, it } from "vitest";
import { positiveMetadataNumber, streamInformationRows, technicalToken } from "./stream-information.ts";

describe("stream information", () => {
  it("keeps unknown track counts distinct from a confirmed zero", () => {
    expect(streamInformationRows({})).toContainEqual(["Audio tracks", "Unavailable"]);
    expect(streamInformationRows({ subtitleTrackCount: 0 })).toContainEqual(["Embedded subtitle tracks", "0"]);
  });
  it("formats technical units and ignores invalid numeric metadata", () => {
    const rows = streamInformationRows({ frameRate: 29.97, audioSampleRate: 48000, videoBitrate: 5000000, droppedFrames: 0, audioChannels: NaN });
    expect(rows).toContainEqual(["Frame rate", "29.97 fps"]);
    expect(rows).toContainEqual(["Audio sample rate", "48 kHz"]);
    expect(rows).toContainEqual(["Video bitrate", "5000 kb/s"]);
    expect(rows).toContainEqual(["Dropped frames", "0"]);
    expect(rows.some(([label]) => label === "Audio channels")).toBe(false);
    expect(positiveMetadataNumber("48000")).toBe(48000);
    expect(positiveMetadataNumber(Infinity)).toBeUndefined();
  });
  it("rejects URLs and arbitrary provider metadata instead of rendering it", () => {
    expect(technicalToken("avc1.640028")).toBe("avc1.640028");
    const unsafe = "https://example.invalid/media?token=synthetic";
    expect(technicalToken(unsafe)).toBeUndefined();
    expect(JSON.stringify(streamInformationRows({ videoCodec: unsafe, audioLanguage: unsafe }))).not.toContain(unsafe);
  });
});
