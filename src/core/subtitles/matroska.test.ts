import { describe, expect, it } from "vitest";
import { parseMatroskaSubtitleTracks } from "./matroska.ts";

function id(value: number): number[] {
  const bytes: number[] = [];
  let current = value;
  do { bytes.unshift(current & 255); current = Math.floor(current / 256); } while (current);
  return bytes;
}
function size(value: number): number[] {
  if (value < 127) return [0x80 | value];
  if (value < 16383) return [0x40 | (value >> 8), value & 255];
  throw new Error("fixture too large");
}
function el(elementId: number, payload: number[]): number[] { return [...id(elementId), ...size(payload.length), ...payload]; }
function uint(elementId: number, value: number): number[] { return el(elementId, [value]); }
function txt(elementId: number, value: string): number[] { return el(elementId, [...new TextEncoder().encode(value)]); }
function entry(fields: number[][]): number[] { return el(0xae, fields.flat()); }
function fixture(): Uint8Array {
  const header = el(0x1a45dfa3, []);
  const subtitle = entry([uint(0xd7, 4), uint(0x83, 17), txt(0x86, "S_TEXT/UTF8"), txt(0x22b59d, "fi"), txt(0x536e, "Finnish"), uint(0x88, 1), uint(0x55aa, 0), uint(0x55ab, 1)]);
  const audio = entry([uint(0xd7, 1), uint(0x83, 2), txt(0x86, "A_EAC3")]);
  const tracks = el(0x1654ae6b, [...audio, ...subtitle]);
  const segmentPayload = [...tracks];
  const segment = [...id(0x18538067), 0xff, ...segmentPayload]; // unknown size
  return new Uint8Array([...header, ...segment]);
}

describe("parseMatroskaSubtitleTracks", () => {
  it("returns subtitle track metadata and omits audio", () => {
    expect(parseMatroskaSubtitleTracks(fixture())).toEqual({ kind: "tracks", tracks: [{
      trackNumber: 4, label: "Finnish", language: "fi", codecId: "S_TEXT/UTF8", forced: false, hearingImpaired: true, default: true,
    }] });
  });
  it("limits parsing to the bounded metadata prefix", () => {
    expect(parseMatroskaSubtitleTracks(new Uint8Array(1024 * 1024 + 30))).toEqual({ kind: "unsupported" });
  });
  it("does not claim an empty subtitle list when the bounded prefix ends before Tracks", () => {
    const header = el(0x1a45dfa3, []);
    const segmentHeader = [...id(0x18538067), 0xff];
    const prefix = new Uint8Array(1024 * 1024);
    prefix.set([...header, ...segmentHeader]);
    expect(parseMatroskaSubtitleTracks(prefix)).toEqual({ kind: "incomplete" });
  });
  it("keeps a short prefix without Tracks unknown", () => {
    expect(parseMatroskaSubtitleTracks(new Uint8Array([...el(0x1a45dfa3, []), ...id(0x18538067), 0xff]))).toEqual({ kind: "incomplete" });
  });
  it("reports no subtitles only after reading Tracks", () => {
    const audio = entry([uint(0xd7, 1), uint(0x83, 2), txt(0x86, "A_EAC3")]);
    expect(parseMatroskaSubtitleTracks(new Uint8Array([...el(0x1a45dfa3, []), ...id(0x18538067), 0xff, ...el(0x1654ae6b, audio)]))).toEqual({ kind: "tracks", tracks: [] });
  });
  it("rejects non-EBML input", () => {
    expect(parseMatroskaSubtitleTracks(new Uint8Array([1, 2, 3]))).toEqual({ kind: "unsupported" });
  });
});
