import { describe, expect, it } from "vitest";
import { LiveDvbTsScanner } from "./live-dvb-ts-scanner.ts";

const TRACK_ID = "288:1";

function packet(pid: number, payload: number[]): Uint8Array {
  const bytes = new Uint8Array(188).fill(0xff);
  bytes[0] = 0x47; bytes[1] = 0x40 | (pid >> 8); bytes[2] = pid & 255; bytes[3] = 0x10;
  bytes.set(payload, 4);
  return bytes;
}

function discovery(): Uint8Array {
  const pat = packet(0, [0, 0, 0xb0, 13, 0, 1, 0xc1, 0, 0, 0, 1, 0xe1, 0, 0, 0, 0, 0]);
  const pmt = packet(0x100, [0, 2, 0xb0, 28, 0, 1, 0xc1, 0, 0, 0xe1, 0x20, 0xf0, 0,
    6, 0xe1, 0x20, 0xf0, 10, 0x59, 8, 0x66, 0x69, 0x6e, 0x10, 0, 1, 0, 1, 0, 0, 0, 0]);
  return join(pat, pmt);
}

function subtitlePacket(id: number): Uint8Array {
  const pts = [0x21, 0, 1, 0, 1];
  const payload = [0x20, 0, 0x0f, 0x80, 0, 1, 0, 0];
  const pesLength = 3 + 5 + payload.length;
  return packet(0x120, [0, 0, 1, 0xbd, pesLength >> 8, pesLength & 255, 0x80, 0x80, 5, ...pts, ...payload, id & 255]);
}

function join(...parts: Uint8Array[]): Uint8Array {
  const output = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) { output.set(part, offset); offset += part.length; }
  return output;
}

function nullPackets(count: number): Uint8Array {
  const bytes = new Uint8Array(count * 188);
  for (let offset = 0; offset < bytes.length; offset += 188) {
    bytes[offset] = 0x47; bytes[offset + 1] = 0x1f; bytes[offset + 2] = 0xff; bytes[offset + 3] = 0x10;
  }
  return bytes;
}

function selectedScanner(options?: ConstructorParameters<typeof LiveDvbTsScanner>[0]): LiveDvbTsScanner {
  const scanner = new LiveDvbTsScanner(options);
  scanner.scan(discovery());
  scanner.select(TRACK_ID);
  return scanner;
}

describe("shared DVB TS scanner compatibility", () => {
  it("keeps the browser default at 16 PES while allowing the relay to raise the bounded cap", () => {
    const packets = Array.from({ length: 18 }, (_, index) => subtitlePacket(index));
    expect(selectedScanner().scan(join(...packets))).toHaveLength(16);
    expect(selectedScanner({ maxOutputPes: 512 }).scan(join(...packets))).toHaveLength(18);
  });

  it("keeps the legacy 20 MiB input cap while allowing larger configured segments", () => {
    const padding = nullPackets(Math.ceil(20 * 1024 * 1024 / 188));
    const bytes = join(discovery(), padding, ...Array.from({ length: 18 }, (_, index) => subtitlePacket(index)));
    expect(selectedScanner().scan(bytes)).toHaveLength(0);
    expect(selectedScanner({ maxInputBytes: 24 * 1024 * 1024, maxOutputPes: 512 }).scan(bytes)).toHaveLength(18);
  });
});
