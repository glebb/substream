import { describe, expect, it } from "vitest";
import { LiveSubtitleSegmentProcessor } from "./subtitles.ts";

const PAGE = 1;

function packet(pid: number, payload: number[]): Uint8Array {
  const bytes = new Uint8Array(188).fill(0xff);
  bytes[0] = 0x47; bytes[1] = 0x40 | (pid >> 8); bytes[2] = pid & 255; bytes[3] = 0x10;
  bytes.set(payload, 4);
  return bytes;
}

function tables(compositionPage = PAGE): Uint8Array {
  const pat = packet(0, [0, 0, 0xb0, 13, 0, 1, 0xc1, 0, 0, 0, 1, 0xe1, 0, 0, 0, 0, 0]);
  const pmt = packet(0x100, [0, 2, 0xb0, 33, 0, 1, 0xc1, 0, 0, 0xe1, 0x30, 0xf0, 0,
    0x1b, 0xe1, 0x30, 0xf0, 0,
    6, 0xe1, 0x20, 0xf0, 10, 0x59, 8, 0x66, 0x69, 0x6e, 0x10, compositionPage >> 8, compositionPage & 255,
    compositionPage >> 8, compositionPage & 255, 0, 0, 0]);
  return join(pat, pmt);
}

function ptsBytes(pts: number): number[] {
  return [0x21 | (Math.floor(pts / 0x20000000) & 14), Math.floor(pts / 0x400000) & 255,
    (Math.floor(pts / 0x4000) & 254) | 1, Math.floor(pts / 128) & 255, (pts * 2 & 254) | 1];
}

function segment(type: number, page: number, body: number[]): number[] {
  return [0x0f, type, page >> 8, page & 255, body.length >> 8, body.length & 255, ...body];
}

function displayPes(pts: number, clear = false, color = 235, positionX = 0): number[] {
  const displaySet = clear
    ? [...segment(0x10, PAGE, [0, 0, 0, 0]), ...segment(0x80, PAGE, [])]
    : [
      ...segment(0x10, PAGE, [10, 0, 1, 0, positionX >> 8, positionX & 255, 0, 0]),
      ...segment(0x11, PAGE, [1, 0, 0, 2, 0, 2, 0x6c, 0, 0, 0, 0, 1, 0, 0, 0, 0]),
      ...segment(0x12, PAGE, [0, 0, 1, 0x21, color, 128, 128, 0]),
      ...segment(0x13, PAGE, [0, 1, 0, 0, 5, 0, 0, 0x12, 1, 0, 0, 0xf0]),
      ...segment(0x80, PAGE, []),
    ];
  const body = [0x20, 0, ...displaySet];
  const length = 3 + 5 + body.length;
  return [0, 0, 1, 0xbd, length >> 8, length & 255, 0x80, 0x80, 5, ...ptsBytes(pts), ...body];
}

function mediaPacket(pts: number): Uint8Array {
  return packet(0x130, [0, 0, 1, 0xe0, 0, 0, 0x80, 0x80, 5, ...ptsBytes(pts)]);
}

function tsSegment(pts: number, subtitlePts: number, clear = false, color = 235, positionX = 0, compositionPage = PAGE): Uint8Array {
  return join(tables(compositionPage), join(mediaPacket(pts), packet(0x120, displayPes(subtitlePts, clear, color, positionX))));
}

function videoOnlySegment(pts: number): Uint8Array {
  return join(tables(), mediaPacket(pts));
}

function programChangeSegment(pts: number, compositionPage: number): Uint8Array {
  return join(tables(compositionPage), mediaPacket(pts));
}

function join(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length); out.set(a); out.set(b, a.length); return out;
}

describe("live DVB subtitle segment processor", () => {
  it("decodes synthetic Finnish display sets into bounded cropped PNG cues and explicit clears", () => {
    const processor = new LiveSubtitleSegmentProcessor();
    const shown = processor.processSegment(tsSegment(90_000, 135_000), { sequence: 0, mediaStartSeconds: 12 });
    expect(shown.tracks.map((track) => track.language)).toContain("fin");
    expect(shown.selectedTrackId).toBe("288:1");
    expect(shown.cues).toHaveLength(1);
    expect(shown.cues[0]).toMatchObject({ startMs: 500, clear: false, width: 1, height: 2, x: 0, y: 0 });
    expect(shown.timingOrigin).toBe(0);
    expect(shown.videoPtsOrigin90k).toBe(90_000);
    expect(shown.images[0]?.contentType).toBe("image/png");
    expect(Array.from(shown.images[0]!.bytes.subarray(0, 8))).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
    expect(processor.processSegment(tsSegment(90_000, 135_000), { sequence: 0 }).cues).toHaveLength(0);

    const cleared = processor.processSegment(tsSegment(180_000, 180_000, true), { sequence: 1, mediaStartSeconds: 13 });
    expect(cleared.cues).toHaveLength(1);
    expect(cleared.cues[0]).toMatchObject({ startMs: 1_000, clear: true });
    expect(processor.getCueBatch(0).cues).toHaveLength(2);
    processor.dispose();
  });

  it("unwraps 33-bit PTS across the wrap and bounds retained cue history", () => {
    const processor = new LiveSubtitleSegmentProcessor({ maxCues: 8 });
    const beforeWrap = 0x2_0000_0000 - 45_000;
    const first = processor.processSegment(tsSegment(beforeWrap, beforeWrap), { sequence: 0, mediaStartSeconds: 20 });
    const after = 45_000;
    const next = processor.processSegment(tsSegment(after, after, false, 16), { sequence: 1, mediaStartSeconds: 21 });
    expect(first.cues[0]?.startMs).toBe(0);
    expect(next.cues[0]?.startMs).toBe(1_000);
    expect(next.videoPtsOrigin90k).toBe(beforeWrap);
    expect(next.cues[0]?.epoch).toBe(first.cues[0]?.epoch);
    processor.dispose();
  });

  it("resets stale cursors when bounded image retention removes old cue assets", () => {
    const processor = new LiveSubtitleSegmentProcessor({ maxCues: 8, maxImages: 4 });
    for (let i = 0; i < 10; i++) {
      processor.processSegment(tsSegment(i * 90_000, i * 90_000, false, 20 + i * 20), { sequence: i });
    }
    const batch = processor.getCueBatch(0);
    expect(batch.reset).toBe(true);
    expect(batch.cues.length).toBeGreaterThan(1);
    expect(batch.active?.clear).toBe(false);
    expect(processor.getImage(batch.active!.imageId!)).toBeDefined();
    expect(batch.cues.every((cue) => cue.clear || processor.getImage(cue.imageId!) !== undefined)).toBe(true);
    processor.dispose();
  });

  it("keeps captions explicitly off across later segments", () => {
    const processor = new LiveSubtitleSegmentProcessor();
    processor.processSegment(tsSegment(90_000, 90_000), { sequence: 0 });
    expect(processor.selectTrack(null)).toBe(true);
    const next = processor.processSegment(tsSegment(180_000, 180_000, false, 80), { sequence: 1 });
    expect(next.selectedTrackId).toBeNull();
    expect(next.cues).toHaveLength(0);
    expect(next.images).toHaveLength(0);
    processor.dispose();
  });

  it("expires cues as video PTS advances through segments without subtitle PES", () => {
    const processor = new LiveSubtitleSegmentProcessor({ maxImages: 4 });
    for (let sequence = 0; sequence < 5; sequence++) {
      processor.processSegment(tsSegment((sequence + 1) * 90_000, (sequence + 1) * 90_000, false, 20 + sequence * 30), { sequence });
    }
    const before = processor.getCueBatch(0);
    expect(before.reset).toBe(true);
    expect(before.active?.clear).toBe(false);
    processor.processSegment(videoOnlySegment(1_980_000), { sequence: 5 });
    const batch = processor.getCueBatch(0);
    expect(batch.reset).toBe(true);
    expect(batch.active).toBeNull();
    processor.dispose();
  });

  it("emits a new geometry cue when the same bitmap moves", () => {
    const processor = new LiveSubtitleSegmentProcessor();
    const first = processor.processSegment(tsSegment(90_000, 90_000), { sequence: 0 });
    const moved = processor.processSegment(tsSegment(180_000, 180_000, false, 235, 20), { sequence: 1 });
    expect(moved.images).toHaveLength(0);
    expect(moved.cues).toHaveLength(1);
    expect(moved.cues[0]?.imageId).toBe(first.cues[0]?.imageId);
    expect(moved.cues[0]?.x).toBe(20);
    processor.dispose();
  });

  it("clears and reinitializes the decoder on a timestamp discontinuity", () => {
    const processor = new LiveSubtitleSegmentProcessor();
    processor.processSegment(tsSegment(900_000, 900_000), { sequence: 0 });
    const discontinuity = processor.processSegment(videoOnlySegment(45_000), { sequence: 1, discontinuity: true });
    expect(discontinuity.cues).toHaveLength(1);
    expect(discontinuity.cues[0]).toMatchObject({ epoch: 2, startMs: 0, clear: true });
    const next = processor.processSegment(tsSegment(90_000, 90_000), { sequence: 2 });
    expect(next.cues[0]).toMatchObject({ epoch: 2, startMs: 500, clear: false });
    processor.dispose();
  });

  it("clears stale selection when the PMT replaces the selected subtitle page", () => {
    const processor = new LiveSubtitleSegmentProcessor();
    processor.processSegment(tsSegment(90_000, 90_000), { sequence: 0 });
    const changed = processor.processSegment(programChangeSegment(180_000, 2), { sequence: 1 });
    expect(changed.selectedTrackId).toBeNull();
    expect(changed.tracks).toHaveLength(0);
    expect(changed.cues[0]).toMatchObject({ clear: true, trackId: "288:1" });
    const replacement = processor.processSegment(tsSegment(270_000, 270_000, false, 235, 0, 2), { sequence: 2 });
    expect(replacement.selectedTrackId).toBe("288:2");
    expect(replacement.tracks.map((track) => track.id)).toContain("288:2");
    processor.dispose();
  });
});
