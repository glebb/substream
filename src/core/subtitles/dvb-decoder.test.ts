import { describe, expect, it } from "vitest";
import { DvbSubtitleDecoder } from "./dvb-decoder.ts";

const PAGE = 0x120;
const ANCILLARY = 0x121;

function segment(type: number, pageId: number, data: number[]): number[] {
  return [0x0f, type, pageId >> 8, pageId & 255, data.length >> 8, data.length & 255, ...data];
}

function pes(segments: number[], pts = 0): Uint8Array {
  const ptsBytes = [
    0x21 | ((Math.floor(pts / 0x20000000) % 16) & 0x0e),
    Math.floor(pts / 0x400000) % 256,
    ((Math.floor(pts / 0x4000) % 256) & 0xfe) | 1,
    Math.floor(pts / 128) % 256,
    ((pts % 128) * 2) | 1,
  ];
  const body = [0x20, 0, ...segments];
  const length = 3 + ptsBytes.length + body.length;
  return new Uint8Array([0, 0, 1, 0xbd, length >> 8, length & 255, 0x80, 0x80, 5, ...ptsBytes, ...body]);
}

function whitePixelDisplaySet(): number[] {
  const page = [10, 0, 1, 0, 0, 0, 0, 0];
  const region = [1, 0, 0, 2, 0, 2, 0x6c, 0, 0, 0, 0, 1, 0, 0, 0, 0];
  const clut = [0, 0, 1, 0x21, 235, 128, 128, 0];
  const object = [0, 1, 0, 0, 5, 0, 0, 0x12, 1, 0, 0, 0xf0];
  return [
    ...segment(0x10, PAGE, page),
    ...segment(0x11, PAGE, region),
    ...segment(0x12, PAGE, clut),
    ...segment(0x13, PAGE, object),
    ...segment(0x80, PAGE, []),
  ];
}

function onePixelSet(bitDepth: 2 | 4): number[] {
  const page = [10, 0, 1, 0, 0, 0, 0, 0];
  const depthCode = bitDepth === 2 ? 1 : 2;
  const region = [1, 0, 0, 2, 0, 2, (1 << 5) | (depthCode << 2), 0, 0, 0, 0, 1, 0, 0, 0, 0];
  const block = bitDepth === 2 ? [0x10, 0x40, 0xf0] : [0x11, 0x10, 0xf0];
  const object = [0, 1, 0, 0, block.length, 0, 0, ...block];
  return [
    ...segment(0x10, PAGE, page),
    ...segment(0x11, PAGE, region),
    ...segment(0x13, PAGE, object),
    ...segment(0x80, PAGE, []),
  ];
}

describe("DVB bitmap subtitle decoder", () => {
  it("decodes a display set with page, region, CLUT, object and 8-bit RLE", () => {
    const decoder = new DvbSubtitleDecoder({ compositionPageId: PAGE, ancillaryPageId: ANCILLARY });
    decoder.feed(pes(whitePixelDisplaySet(), 90_000));
    expect(decoder.count).toBe(1);
    const frame = decoder.renderFrameDataAtTimestamp(1);
    expect(frame).not.toBeNull();
    expect(frame?.screenWidth).toBe(720);
    expect(frame?.imageData.width).toBe(1);
    expect(frame?.imageData.height).toBe(2);
    expect([...frame!.imageData.data]).toEqual([255, 255, 255, 255, 255, 255, 255, 255]);
    expect(decoder.renderFrameDataAtTimestamp(11)).toBeNull();
  });

  it.each([2, 4] as const)("decodes a %i-bit pixel code string", (depth) => {
    const decoder = new DvbSubtitleDecoder({ compositionPageId: PAGE });
    decoder.feed(pes(onePixelSet(depth), 0));
    const frame = decoder.renderFrameDataAtTimestamp(0);
    expect(frame?.imageData.width).toBe(1);
    expect(frame?.imageData.height).toBe(2);
    expect(frame?.imageData.data[3]).toBe(255);
  });

  it("does not show a future page and clears on an empty page composition", () => {
    const decoder = new DvbSubtitleDecoder({ compositionPageId: PAGE });
    decoder.feed(pes(whitePixelDisplaySet(), 90_000));
    expect(decoder.renderFrameDataAtTimestamp(0.5)).toBeNull();
    expect(decoder.renderFrameDataAtTimestamp(1)).not.toBeNull();
    decoder.feed(pes([...segment(0x10, PAGE, [0, 0, 0, 0]), ...segment(0x80, PAGE, [])], 2 * 90_000));
    expect(decoder.renderFrameDataAtTimestamp(2)).toBeNull();
  });

  it("ignores unrelated page ids and rejects display allocations above the configured cap", () => {
    const decoder = new DvbSubtitleDecoder({ compositionPageId: PAGE, maxDisplayPixels: 1024 });
    decoder.feed(pes(whitePixelDisplaySet(), 0));
    // The supplied page is selected, but its implicit 720×576 output exceeds
    // this explicit cap, so no bitmap allocation is attempted.
    expect(decoder.renderFrameDataAtTimestamp(0)).toBeNull();
    const other = new DvbSubtitleDecoder({ compositionPageId: PAGE });
    other.feed(pes(segment(0x10, ANCILLARY, [10, 0, 0, 1, 0, 0]), 0));
    expect(other.count).toBe(0);
  });

  it("decodes 33-bit PES timestamps without signed 32-bit truncation", () => {
    const decoder = new DvbSubtitleDecoder({ compositionPageId: PAGE });
    const at = 0x1_0000_0000 + 90_000;
    decoder.feed(pes(whitePixelDisplaySet(), at));
    expect(decoder.renderFrameDataAtTimestamp(at / 90_000)).not.toBeNull();
    expect(decoder.renderFrameDataAtTimestamp(1)).toBeNull();
  });
});
