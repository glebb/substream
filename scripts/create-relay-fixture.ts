/** Offline fixture only. Generates test video/audio and synthetic DVB pages. */
import { spawnSync } from "node:child_process";
import { readFile, writeFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const PACKET = 188;
const SUBTITLE_PID = 0x120;
const PAGE = 0x120;

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte << 24;
    for (let bit = 0; bit < 8; bit++) crc = (crc << 1) ^ ((crc & 0x80000000) ? 0x04c11db7 : 0);
  }
  return crc >>> 0;
}

function segment(type: number, data: number[]): number[] {
  return [0x0f, type, PAGE >> 8, PAGE & 255, data.length >> 8, data.length & 255, ...data];
}

function subtitlePes(seconds: number, clear: boolean): Uint8Array {
  // A white 160-pixel bar, at x=280/y=480 in a 720x576 DVB display.
  const page = [2, 4, ...(clear ? [] : [1, 0, 1, 24, 1, 224])];
  const display = clear ? [] : [
    ...segment(0x11, [1, 8, 0, 160, 0, 16, 0x6c, 0, 1, 0]),
    ...segment(0x12, [0, 0, 1, 0x21, 235, 128, 128, 0]),
  ];
  const body = [0x20, 0, ...segment(0x10, page), ...display, ...segment(0x80, [])];
  const pts = Math.round(seconds * 90000);
  const ptsBytes = [0x21 | ((Math.floor(pts / 0x20000000) % 16) & 14),
    Math.floor(pts / 0x400000) % 256, ((Math.floor(pts / 0x4000) % 256) & 254) | 1,
    Math.floor(pts / 128) % 256, ((pts % 128) * 2) | 1];
  const length = body.length + 8;
  return Uint8Array.from([0, 0, 1, 0xbd, length >> 8, length & 255, 0x84, 0x80, 5, ...ptsBytes, ...body]);
}

function subtitlePacket(seconds: number, clear: boolean, continuity: number): Uint8Array {
  const pes = subtitlePes(seconds, clear);
  const packet = new Uint8Array(PACKET).fill(255);
  const padding = 183 - pes.length;
  packet.set([0x47, 0x40 | (SUBTITLE_PID >> 8), SUBTITLE_PID & 255, 0x30 | (continuity & 15), padding]);
  if (padding) packet[5] = 0;
  packet.set(pes, 5 + padding);
  return packet;
}

function pts(payload: Uint8Array): number | undefined {
  if (payload.length < 14 || payload[0] !== 0 || payload[1] !== 0 || payload[2] !== 1 || !(payload[7]! & 128)) return undefined;
  return (payload[9]! & 14) * 0x20000000 + payload[10]! * 0x400000
    + (payload[11]! & 254) * 0x4000 + payload[12]! * 128 + (payload[13]! & 254) / 2;
}

export function addSyntheticDvb(input: Uint8Array): Uint8Array {
  const output: Uint8Array[] = [];
  let pmtPid: number | undefined;
  let videoPid: number | undefined;
  let firstVideoPts: number | undefined;
  const events = [{ at: 2, clear: false }, { at: 4, clear: true }, { at: 6, clear: false }, { at: 8, clear: true }];
  let nextEvent = 0;
  for (let offset = 0; offset + PACKET <= input.length; offset += PACKET) {
    const packet = input.slice(offset, offset + PACKET);
    if (packet[0] !== 0x47) throw new Error("Invalid synthetic TS fixture");
    const pid = ((packet[1]! & 31) << 8) | packet[2]!;
    let payloadOffset = 4;
    const adaptation = (packet[3]! >> 4) & 3;
    if (adaptation === 0 || adaptation === 2) { output.push(packet); continue; }
    if (adaptation === 3) payloadOffset += 1 + packet[4]!;
    if (payloadOffset >= PACKET) { output.push(packet); continue; }
    const payloadStart = !!(packet[1]! & 64);
    if (pid === 0 && payloadStart) {
      const start = payloadOffset + 1 + packet[payloadOffset]!;
      pmtPid = ((packet[start + 10]! & 31) << 8) | packet[start + 11]!;
    } else if (pid === pmtPid && payloadStart) {
      const start = payloadOffset + 1 + packet[payloadOffset]!;
      const length = 3 + (((packet[start + 1]! & 15) << 8) | packet[start + 2]!);
      const section = packet.slice(start, start + length - 4);
      const streamStart = 12 + (((section[10]! & 15) << 8) | section[11]!);
      videoPid = ((section[streamStart + 1]! & 31) << 8) | section[streamStart + 2]!;
      const descriptor = [0x06, 0xe0 | (SUBTITLE_PID >> 8), SUBTITLE_PID & 255, 0xf0, 10,
        0x59, 8, 102, 105, 110, 0x10, PAGE >> 8, PAGE & 255, 0, 0];
      const changed = Uint8Array.from([...section, ...descriptor, 0, 0, 0, 0]);
      const newLength = changed.length - 3;
      changed[1] = 0xb0 | (newLength >> 8); changed[2] = newLength & 255;
      const crc = crc32(changed.subarray(0, changed.length - 4));
      changed.set([crc >>> 24, crc >>> 16 & 255, crc >>> 8 & 255, crc & 255], changed.length - 4);
      if (start + changed.length > PACKET) throw new Error("Synthetic PMT exceeds packet");
      packet.fill(255, start); packet.set(changed, start);
    } else if (pid === videoPid && payloadStart) {
      const time = pts(packet.subarray(payloadOffset));
      if (time !== undefined) {
        firstVideoPts ??= time;
        while (events[nextEvent] && time >= firstVideoPts + events[nextEvent]!.at * 90000) {
          const event = events[nextEvent]!;
          output.push(subtitlePacket(firstVideoPts / 90000 + event.at, event.clear, nextEvent));
          nextEvent++;
        }
      }
    }
    output.push(packet);
  }
  if (nextEvent !== events.length) throw new Error("Synthetic fixture lacks expected video timeline");
  const result = new Uint8Array(output.length * PACKET);
  output.forEach((packet, index) => result.set(packet, index * PACKET));
  return result;
}

export async function createRelayFixture(outputPath: string): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "substream-fixture-"));
  try {
    const input = join(directory, "input.ts");
    const result = spawnSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=25",
      "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000", "-t", "12", "-c:v", "libx264", "-preset", "ultrafast",
      "-g", "100", "-c:a", "aac", "-f", "mpegts", input], { stdio: "ignore" });
    if (result.status !== 0) throw new Error("Synthetic generation failed; ffmpeg with libx264 is required");
    await writeFile(outputPath, addSyntheticDvb(await readFile(input)));
  } finally { await rm(directory, { recursive: true, force: true }); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const outputPath = process.argv[2];
  if (!outputPath) { process.stderr.write("Usage: node scripts/create-relay-fixture.ts OUTPUT.ts\n"); process.exitCode = 1; }
  else createRelayFixture(outputPath).then(() => process.stdout.write("Synthetic relay fixture created.\n"))
    .catch(() => { process.stderr.write("Synthetic fixture generation failed.\n"); process.exitCode = 1; });
}
