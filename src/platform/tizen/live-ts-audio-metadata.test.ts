import { afterEach, describe, expect, it, vi } from "vitest";
import { parseLiveTsAudioMetadata, probeLiveTsAudioMetadata } from "./live-ts-audio-metadata.ts";

const originalXhr = globalThis.XMLHttpRequest;

afterEach(() => { globalThis.XMLHttpRequest = originalXhr; });

describe("parseLiveTsAudioMetadata", () => {
  it("reads PMT audio languages in provider track order", () => {
    expect(parseLiveTsAudioMetadata(join(patPacket(), pmtPacket()))).toEqual([
      { language: "dan" }, { language: "fin" }, { language: "nor" }, { language: "swe" },
    ]);
  });

  it("ignores non-audio PMT entries and safely returns no metadata for invalid bytes", () => {
    expect(parseLiveTsAudioMetadata(join(patPacket(), pmtPacket(["fin"], true)))).toEqual([{ language: "fin" }]);
    expect(parseLiveTsAudioMetadata(new Uint8Array(188))).toEqual([]);
  });
});

describe("probeLiveTsAudioMetadata", () => {
  it("uses a simple GET and aborts after the bounded sample without adding request headers", async () => {
    const probeBytes = join(patPacket(), pmtPacket());
    const sample = Array.from({ length: Math.ceil(128 * 1024 / probeBytes.length) }, () => bytesToBinaryString(probeBytes)).join("").slice(0, 128 * 1024);
    const open = vi.fn();
    const setRequestHeader = vi.fn();
    const abort = vi.fn();
    class SampleXhr {
      timeout = 0;
      responseText = "";
      onprogress: (() => void) | null = null;
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      ontimeout: (() => void) | null = null;
      onabort: (() => void) | null = null;
      open = open;
      setRequestHeader = setRequestHeader;
      overrideMimeType(): void {}
      send(): void { this.responseText = sample; this.onprogress?.(); }
      abort = () => { abort(); this.onabort?.(); };
    }
    globalThis.XMLHttpRequest = SampleXhr as unknown as typeof XMLHttpRequest;

    await expect(probeLiveTsAudioMetadata("https://example.invalid/live.ts")).resolves.toEqual({
      tracks: [{ language: "dan" }, { language: "fin" }, { language: "nor" }, { language: "swe" }],
      status: "ok",
    });
    expect(open).toHaveBeenCalledWith("GET", "https://example.invalid/live.ts", true);
    expect(setRequestHeader).not.toHaveBeenCalled();
    expect(abort).toHaveBeenCalledOnce();
  });
});

function patPacket(): Uint8Array {
  return packet(0, Uint8Array.from([0, 0, 0xb0, 0x0d, 0, 1, 0xc1, 0, 0, 0, 1, 0xe0, 100, 0, 0, 0, 0]));
}

function pmtPacket(languages = ["dan", "fin", "nor", "swe"], includeVideo = false): Uint8Array {
  const entries: number[] = [];
  if (includeVideo) entries.push(0x1b, 0xe1, 0, 0xf0, 0);
  languages.forEach((language, index) => {
    const pid = 257 + index;
    entries.push(0x0f, 0xe0 | (pid >> 8), pid & 255, 0xf0, 6, 0x0a, 4, ...language.split("").map((c) => c.charCodeAt(0)), 0);
  });
  const body = [0, 1, 0xc1, 0, 0, 0xe1, 0, 0xf0, 0, ...entries];
  const length = body.length + 4;
  const section = [0x02, 0xb0 | (length >> 8), length & 255, ...body, 0, 0, 0, 0];
  return packet(100, Uint8Array.from([0, ...section]));
}

function packet(pid: number, payload: Uint8Array): Uint8Array {
  const result = new Uint8Array(188).fill(0xff);
  result[0] = 0x47;
  result[1] = 0x40 | ((pid >> 8) & 31);
  result[2] = pid & 255;
  result[3] = 0x10;
  result.set(payload, 4);
  return result;
}

function join(...packets: Uint8Array[]): Uint8Array {
  const result = new Uint8Array(packets.length * 188);
  packets.forEach((item, index) => result.set(item, index * 188));
  return result;
}

function bytesToBinaryString(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => String.fromCharCode(byte)).join("");
}
