import { describe, expect, it } from "vitest";
import { enrichEmbeddedSubtitleTracks } from "./embedded-metadata.ts";
import type { MatroskaSubtitleTrack } from "./matroska.ts";

const metadata: MatroskaSubtitleTrack[] = [
  { trackNumber: 3, label: "", language: "eng", codecId: "S_TEXT/UTF8", forced: false, hearingImpaired: true, default: false },
  { trackNumber: 8, label: "", language: "fin", codecId: "S_TEXT/UTF8", forced: false, hearingImpaired: false, default: true },
];
const native = [
  { id: "0", label: "Subtitle 1", selected: false, playable: true },
  { id: "1", label: "Subtitle 2", selected: true, playable: true },
];

describe("embedded subtitle metadata reconciliation", () => {
  it("maps subtitle order without treating Matroska TrackNumbers as native IDs", () => {
    expect(enrichEmbeddedSubtitleTracks(native, metadata)).toEqual([
      { ...native[0]!, language: "eng", label: "eng · S_TEXT/UTF8", codec: "S_TEXT/UTF8", forced: false, hearingImpaired: true },
      { ...native[1]!, language: "fin", label: "fin · S_TEXT/UTF8", codec: "S_TEXT/UTF8", forced: false, hearingImpaired: false },
    ]);
  });
  it("does not invent selectable tracks when native playback exposes none or omits some", () => {
    expect(enrichEmbeddedSubtitleTracks([], metadata)).toEqual([]);
    expect(enrichEmbeddedSubtitleTracks(native.slice(0, 1), metadata)).toEqual(native.slice(0, 1));
  });
  it("rejects a language or codec anchor that contradicts file order", () => {
    const reversed = [{ ...native[0]!, language: "fi" }, native[1]!];
    expect(enrichEmbeddedSubtitleTracks(reversed, metadata)).toEqual(reversed);
    const incompatible = [{ ...native[0]!, codec: "S_HDMV/PGS" }, native[1]!];
    expect(enrichEmbeddedSubtitleTracks(incompatible, metadata)).toEqual(incompatible);
  });
  it("preserves native selection IDs and known variant metadata", () => {
    const known = [{ ...native[0]!, language: "en", forced: true, label: "English forced" }, native[1]!];
    expect(enrichEmbeddedSubtitleTracks(known, metadata)[0]).toMatchObject({ id: "0", label: "English forced", language: "en", forced: true });
  });
  it("rejects duplicate identities rather than guessing", () => {
    expect(enrichEmbeddedSubtitleTracks(native, [metadata[0]!, metadata[0]!])).toEqual(native);
    expect(enrichEmbeddedSubtitleTracks([native[0]!, native[0]!], metadata)).toEqual([native[0], native[0]]);
  });
  it("replaces the und placeholder with the file language", () => {
    expect(enrichEmbeddedSubtitleTracks([{ ...native[0]!, language: "und", label: "und" }, native[1]!], metadata)[0]?.language).toBe("eng");
  });
});
