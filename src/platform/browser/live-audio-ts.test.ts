import { describe, expect, it } from "vitest";
import { LiveAudioTsProcessor, processLiveAudioFragment } from "./live-audio-ts.ts";

describe("LiveAudioTsProcessor", () => {
  it("discovers AAC languages and puts Finnish first for hls.js TS demuxing", () => {
    const processor = new LiveAudioTsProcessor();
    const output = processor.process(joinPackets(patPacket(), pmtPacket()));

    expect(processor.getTracks()).toEqual([
      { id: "ts:257", pid: 257, language: "dan", codec: "aac" },
      { id: "ts:258", pid: 258, language: "fin", codec: "aac" },
      { id: "ts:259", pid: 259, language: "nor", codec: "aac" },
      { id: "ts:260", pid: 260, language: "swe", codec: "aac" },
    ]);
    expect(processor.getSelectedId()).toBe("ts:258");
    expect(audioPids(readPmt(output))).toEqual([258, 257, 259, 260]);
    expect(crc32(readPmt(output))).toBe(0);
  });

  it("switches selected PID ordering and falls back to English then first", () => {
    const processor = new LiveAudioTsProcessor();
    processor.process(joinPackets(patPacket(), pmtPacket()));
    expect(processor.select("ts:257")).toBe(true);
    const switched = processor.process(joinPackets(patPacket(), pmtPacket()));
    expect(audioPids(readPmt(switched))).toEqual([257, 258, 259, 260]);
    expect(processor.select("ts:999")).toBe(false);

    const english = new LiveAudioTsProcessor();
    english.process(joinPackets(patPacket(), pmtPacket(["dan", "eng", "nor", "swe"])));
    expect(english.getSelectedId()).toBe("ts:258");
    const first = new LiveAudioTsProcessor();
    first.process(joinPackets(patPacket(), pmtPacket(["dan", "deu", "nor", "swe"])));
    expect(first.getSelectedId()).toBe("ts:257");
  });

  it("reuses unchanged fragments and never mutates the captured subtitle payload", () => {
    const processor = new LiveAudioTsProcessor();
    const first = joinPackets(patPacket(), pmtPacket(["fin", "eng", "nor", "swe"]));
    expect(processor.process(first)).toBe(first);
    expect(processLiveAudioFragment(first.buffer as ArrayBuffer, processor)).toBe(first.buffer);
    const before = first.slice();
    processor.select("ts:258");
    const changed = processor.process(first);
    expect(changed).not.toBe(first);
    expect(first).toEqual(before);
    expect(audioPids(readPmt(changed))).toEqual([258, 257, 259, 260]);
    expect(crc32(readPmt(changed))).toBe(0);
    // Every repeated PMT in a fragment needs the same rewrite.
    const repeated = processor.process(joinPackets(patPacket(), pmtPacket(), patPacket(), pmtPacket()));
    expect(audioPids(readPmt(repeated))).toEqual([258, 257, 259, 260]);
    expect(audioPids(readPmt(repeated.subarray(376)))).toEqual([258, 257, 259, 260]);
  });

  it("discovers tracks in a multi-megabyte live fragment", () => {
    const source = new Uint8Array(188 * 20_000);
    source.set(joinPackets(patPacket(), pmtPacket()));
    const processor = new LiveAudioTsProcessor();
    const result = processLiveAudioFragment(source.buffer, processor);
    expect(result.byteLength).toBe(source.byteLength);
    expect(processor.getTracks()).toHaveLength(4);
    expect(processor.getSelectedId()).toBe("ts:258");
    expect(audioPids(readPmt(new Uint8Array(result)))[0]).toBe(258);
  });
});

function patPacket(): Uint8Array {
  const section = Uint8Array.from([0x00, 0xb0, 0x0d, 0, 1, 0xc1, 0, 0, 0, 1, 0xe0, 100, 0, 0, 0, 0]);
  writeCrc(section, section.length - 4);
  return packet(0, Uint8Array.from([0, ...section]));
}

function pmtPacket(languages = ["dan", "fin", "nor", "swe"]): Uint8Array {
  const entries: number[] = [0x1b, 0xe1, 0, 0xf0, 0];
  for (let index = 0; index < languages.length; index += 1) {
    const pid = 257 + index;
    entries.push(0x0f, 0xe0 | (pid >> 8), pid & 255, 0xf0, 6, 0x0a, 4, ...languages[index]!.split("").map((char) => char.charCodeAt(0)), 0);
  }
  const body = [0, 1, 0xc1, 0, 0, 0xe1, 0, 0xf0, 0, ...entries];
  const sectionLength = body.length + 4;
  const section = Uint8Array.from([0x02, 0xb0 | (sectionLength >> 8), sectionLength & 255, ...body, 0, 0, 0, 0]);
  writeCrc(section, section.length - 4);
  return packet(100, Uint8Array.from([0, ...section]));
}

function packet(pid: number, payload: Uint8Array): Uint8Array {
  const result = new Uint8Array(188).fill(0xff);
  result[0] = 0x47;
  result[1] = 0x40 | ((pid >> 8) & 0x1f);
  result[2] = pid & 255;
  result[3] = 0x10;
  result.set(payload, 4);
  return result;
}

function joinPackets(...packets: Uint8Array[]): Uint8Array {
  const result = new Uint8Array(packets.length * 188);
  packets.forEach((item, index) => result.set(item, index * 188));
  return result;
}

function readPmt(data: Uint8Array): Uint8Array {
  const packetStart = 188;
  const payloadStart = packetStart + 5;
  const sectionLength = ((data[payloadStart + 1]! & 15) << 8) | data[payloadStart + 2]!;
  return data.slice(payloadStart, payloadStart + 3 + sectionLength);
}

function audioPids(section: Uint8Array): number[] {
  const end = section.length - 4;
  const pids: number[] = [];
  for (let offset = 12; offset + 5 <= end;) {
    const type = section[offset]!;
    const pid = ((section[offset + 1]! & 31) << 8) | section[offset + 2]!;
    const length = ((section[offset + 3]! & 15) << 8) | section[offset + 4]!;
    if (type === 0x0f) pids.push(pid);
    offset += 5 + length;
  }
  return pids;
}

function writeCrc(section: Uint8Array, offset: number): void {
  let crc = 0xffffffff;
  for (let i = 0; i < offset; i += 1) {
    crc ^= section[i]! << 24;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc & 0x80000000) !== 0 ? (crc << 1) ^ 0x04c11db7 : crc << 1;
  }
  section[offset] = (crc >>> 24) & 255;
  section[offset + 1] = (crc >>> 16) & 255;
  section[offset + 2] = (crc >>> 8) & 255;
  section[offset + 3] = crc & 255;
}

function crc32(section: Uint8Array): number {
  let crc = 0xffffffff;
  for (const value of section) {
    crc ^= value << 24;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc & 0x80000000) !== 0 ? (crc << 1) ^ 0x04c11db7 : crc << 1;
  }
  return crc >>> 0;
}
