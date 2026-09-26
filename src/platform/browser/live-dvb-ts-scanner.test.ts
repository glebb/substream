import { describe, expect, it } from "vitest";
import { LiveDvbTsScanner } from "./live-dvb-ts-scanner.ts";

function packet(pid: number, payload: number[]): Uint8Array {
  const bytes = new Uint8Array(188).fill(0xff);
  bytes[0] = 0x47;
  bytes[1] = 0x40 | (pid >> 8);
  bytes[2] = pid & 255;
  bytes[3] = 0x10;
  bytes.set(payload, 4);
  return bytes;
}

it("exposes advertised DVB tracks only after their PID appears in transport packets", () => {
  const pat = [0, 0, 0xb0, 13, 0, 1, 0xc1, 0, 0, 0, 1, 0xe1, 0, 0, 0, 0, 0];
  const pmt = [0, 2, 0xb0, 43, 0, 1, 0xc1, 0, 0, 0xe1, 0x20, 0xf0, 0,
    6, 0xe1, 0x20, 0xf0, 10, 0x59, 8, 0x66, 0x69, 0x6e, 0x10, 0, 1, 0, 1,
    6, 0xe1, 0x21, 0xf0, 10, 0x59, 8, 0x66, 0x69, 0x6e, 0x10, 0, 2, 0, 2, 0, 0, 0, 0];
  const bytes = new Uint8Array(188 * 3);
  bytes.set(packet(0, pat));
  bytes.set(packet(0x100, pmt), 188);
  bytes.set(packet(0x121, [0]), 376);
  const scanner = new LiveDvbTsScanner();
  scanner.scan(bytes);
  expect(scanner.getTracks()).toHaveLength(2);
  expect(scanner.getActiveTracks().map(({ id }) => id)).toEqual(["289:2"]);
});

it("accepts a complete DVB PES with the data-alignment flag set", () => {
  const pat = [0, 0, 0xb0, 13, 0, 1, 0xc1, 0, 0, 0, 1, 0xe1, 0, 0, 0, 0, 0];
  const pmt = [0, 2, 0xb0, 28, 0, 1, 0xc1, 0, 0, 0xe1, 0x20, 0xf0, 0,
    6, 0xe1, 0x20, 0xf0, 10, 0x59, 8, 0x66, 0x69, 0x6e, 0x10, 0, 1, 0, 1, 0, 0, 0, 0];
  const scanner = new LiveDvbTsScanner();
  const discovery = new Uint8Array(188 * 2);
  discovery.set(packet(0, pat));
  discovery.set(packet(0x100, pmt), 188);
  scanner.scan(discovery);
  expect(scanner.getTracks()).toHaveLength(1);
  scanner.select("288:1");

  // PES byte 6 is 0x84: MPEG-2 optional-header marker bits plus
  // data_alignment_indicator. The selected composition page is 1.
  const pes = [0, 0, 1, 0xbd, 0, 12, 0x84, 0, 0, 0x20, 0, 0x0f, 0x10, 0, 1, 0, 0, 0];
  const output = scanner.scan(packet(0x120, pes));
  expect(output).toHaveLength(1);
  expect(Array.from(output[0]!.subarray(6, 13))).toEqual([0x84, 0, 0, 0x20, 0, 0x0f, 0x10]);
});
