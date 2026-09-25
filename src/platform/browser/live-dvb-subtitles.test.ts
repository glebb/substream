import { describe, expect, it, vi } from "vitest";
import { LiveDvbSubtitles } from "./live-dvb-subtitles.ts";

const TS_PACKET = 188;

function ts(pid: number, payload: number[], unitStart = true): Uint8Array {
  const packet = new Uint8Array(TS_PACKET).fill(0xff);
  packet[0] = 0x47;
  packet[1] = ((pid >> 8) & 0x1f) | (unitStart ? 0x40 : 0);
  packet[2] = pid & 0xff;
  packet[3] = 0x10;
  packet.set(payload, 4);
  return packet;
}

function withCrc(section: number[]): number[] { return [...section, 0, 0, 0, 0]; }

function concat(...parts: Uint8Array[]): Uint8Array {
  const bytes = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) { bytes.set(part, offset); offset += part.length; }
  return bytes;
}

describe("LiveDvbSubtitles TS demux and renderer handoff", () => {
  it("finds a Finnish DVB stream with multiple descriptor entries and waits for initPTS", async () => {
    const listeners = new Map<string, (event: string, data: Record<string, unknown>) => void>();
    const hls = { on: (event: string, fn: (event: string, data: Record<string, unknown>) => void) => listeners.set(event, fn), off: vi.fn() };
    const append = vi.fn(async (_data: Uint8Array) => 0);
    const renderer = { append, reset: vi.fn(async () => {}), dispose: vi.fn() };
    const tracksChanged = vi.fn();
    const subtitles = new LiveDvbSubtitles({} as HTMLVideoElement, hls, { FRAG_LOADED: "frag", FRAG_DECRYPTED: "decrypted", INIT_PTS_FOUND: "pts" }, async () => renderer, tracksChanged);
    subtitles.setEnabled(true);

    const pat = withCrc([0, 0xb0, 13, 0, 1, 0xc1, 0, 0, 0, 1, 0xe1, 0]);
    const pmt = withCrc([2, 0xb0, 36, 0, 1, 0xc1, 0, 0, 0xe1, 0x20, 0xf0, 0,
      6, 0xe1, 0x20, 0xf0, 18, 0x59, 16, 0x66, 0x69, 0x6e, 0x10, 0, 1, 0, 1, 0x73, 0x77, 0x65, 0x10, 0, 2, 0, 2]);
    const pes = [0, 0, 1, 0xbd, 0, 9, 0x80, 0x80, 5, 0x21, 0, 1, 0, 1, 0x20];
    const fragment = concat(
      ts(0, [0, ...pat]),
      ts(0x100, [0, ...pmt]),
      ts(0x120, pes),
      ts(0x120, pes),
      ts(0x120, pes),
    );
    const payload = fragment.buffer.slice(fragment.byteOffset, fragment.byteOffset + fragment.byteLength) as ArrayBuffer;
    listeners.get("frag")?.("frag", { payload, frag: { type: "main", start: 0, cc: 4 } });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(subtitles.getTracks()).toEqual([
      { id: "288:1", label: "fin · DVB", language: "fin", selected: true },
      { id: "288:2", label: "swe · DVB", language: "swe", selected: false },
    ]);
    expect(tracksChanged).toHaveBeenCalledOnce();
    expect(append).not.toHaveBeenCalled();

    listeners.get("pts")?.("pts", { id: "main", initPTS: 0, timescale: 90_000, frag: { cc: 4 } });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(append).toHaveBeenCalledTimes(3);
    expect(append.mock.calls[0]?.[0].slice(0, 4)).toEqual(new Uint8Array([0, 0, 1, 0xbd]));

    listeners.get("pts")?.("pts", { id: "main", initPTS: 90_000, timescale: 90_000, frag: { cc: 5 } });
    listeners.get("frag")?.("frag", { payload, frag: { type: "main", start: 0, cc: 5 } });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(append).toHaveBeenCalledTimes(6);
    subtitles.dispose();
  });

  it("drops transport continuation bytes until a subtitle PES start resynchronizes", async () => {
    const listeners = new Map<string, (event: string, data: Record<string, unknown>) => void>();
    const hls = { on: (event: string, fn: (event: string, data: Record<string, unknown>) => void) => listeners.set(event, fn), off: vi.fn() };
    const append = vi.fn(async (_data: Uint8Array) => 0);
    const renderer = { append, reset: vi.fn(async () => {}), dispose: vi.fn() };
    const subtitles = new LiveDvbSubtitles({} as HTMLVideoElement, hls, { FRAG_LOADED: "frag", FRAG_DECRYPTED: "decrypted", INIT_PTS_FOUND: "pts" }, async () => renderer);
    subtitles.setEnabled(true);

    const pat = withCrc([0, 0xb0, 13, 0, 1, 0xc1, 0, 0, 0, 1, 0xe1, 0]);
    const pmt = withCrc([2, 0xb0, 28, 0, 1, 0xc1, 0, 0, 0xe1, 0x20, 0xf0, 0,
      6, 0xe1, 0x20, 0xf0, 10, 0x59, 8, 0x66, 0x69, 0x6e, 0x10, 0, 1, 0, 1]);
    const continuation = Array.from({ length: 300 }, () => ts(0x120, new Array(184).fill(0x55), false));
    const pes = [0, 0, 1, 0xbd, 0, 9, 0x80, 0x80, 5, 0x21, 0, 1, 0, 1, 0x20];
    const fragment = concat(ts(0, [0, ...pat]), ts(0x100, [0, ...pmt]), ...continuation, ts(0x120, pes));
    const payload = fragment.buffer.slice(fragment.byteOffset, fragment.byteOffset + fragment.byteLength) as ArrayBuffer;
    listeners.get("pts")?.("pts", { id: "main", initPTS: 0, timescale: 90_000, frag: { cc: 1 } });
    listeners.get("frag")?.("frag", { payload, frag: { type: "main", start: 0, cc: 1 } });
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(append).toHaveBeenCalledOnce();
    subtitles.dispose();
  });
});
