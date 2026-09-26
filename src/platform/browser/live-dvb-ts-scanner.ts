import { LIVE_DVB_MAX_FRAGMENT_BYTES } from "./live-dvb-worker-protocol.ts";

const PACKET = 188;
const MAX_PES_BYTES = 128 * 1024;

export type ScannedDvbTrack = { id: string; pid: number; language: string; compositionPageId: number; ancillaryPageId: number };

/** Worker-side MPEG-TS scanner. One call is strictly capped to one fragment. */
export class LiveDvbTsScanner {
  private pmtPid: number | undefined;
  private pmtSection: Uint8Array<ArrayBufferLike> = new Uint8Array(0);
  private tracks: ScannedDvbTrack[] = [];
  private selected: ScannedDvbTrack | undefined;
  private pes: Uint8Array<ArrayBufferLike> = new Uint8Array(0);

  select(id: string): void { this.selected = this.tracks.find((track) => track.id === id); this.pes = new Uint8Array(0); }
  getTracks(): ScannedDvbTrack[] { return this.tracks.slice(0, 32); }
  getSelected(): ScannedDvbTrack | undefined { return this.selected; }

  scan(input: Uint8Array): Uint8Array[] {
    const bytes = input.subarray(0, LIVE_DVB_MAX_FRAGMENT_BYTES);
    const output: Uint8Array[] = [];
    for (let offset = 0; offset + PACKET <= bytes.length; offset += PACKET) {
      if (bytes[offset] !== 0x47) continue;
      const pid = ((bytes[offset + 1]! & 0x1f) << 8) | bytes[offset + 2]!;
      const payloadStart = (bytes[offset + 1]! & 0x40) !== 0;
      const adaptation = (bytes[offset + 3]! >> 4) & 3;
      if (adaptation === 0 || adaptation === 2) continue;
      let start = offset + 4;
      if (adaptation === 3) start += 1 + bytes[start]!;
      if (start >= offset + PACKET) continue;
      const payload = bytes.subarray(start, offset + PACKET);
      if (pid === 0 && payloadStart) this.readPat(payload);
      else if (pid === this.pmtPid) this.readPmt(payload, payloadStart);
      else if (pid === this.selected?.pid) this.readPes(payload, payloadStart, output);
    }
    return output.slice(0, 16);
  }

  private readPat(payload: Uint8Array): void {
    if (!payload.length) return;
    const start = 1 + payload[0]!;
    if (start + 12 > payload.length || payload[start] !== 0) return;
    const end = Math.min(payload.length, start + 3 + (((payload[start + 1]! & 15) << 8) | payload[start + 2]!));
    for (let i = start + 8; i + 4 <= end - 4; i += 4) {
      if ((payload[i]! << 8 | payload[i + 1]!) !== 0) { this.pmtPid = (payload[i + 2]! & 31) << 8 | payload[i + 3]!; return; }
    }
  }

  private readPmt(payload: Uint8Array, payloadStart: boolean): void {
    if (!payload.length) return;
    if (payloadStart) {
      const start = 1 + payload[0]!;
      this.pmtSection = payload.slice(start, Math.min(payload.length, start + 1024));
    } else if (this.pmtSection.length && this.pmtSection.length < 1024) {
      this.pmtSection = join(this.pmtSection, payload.subarray(0, 1024 - this.pmtSection.length));
    }
    const section = this.pmtSection;
    if (section.length < 3 || section[0] !== 2) return;
    const sectionLength = (section[1]! & 15) << 8 | section[2]!;
    if (sectionLength > 1021 || section.length < sectionLength + 3) return;
    const end = sectionLength - 1;
    let offset = 12 + ((section[10]! & 15) << 8 | section[11]!);
    const tracks: ScannedDvbTrack[] = [];
    while (offset + 5 <= end && tracks.length < 32) {
      const type = section[offset]!;
      const pid = (section[offset + 1]! & 31) << 8 | section[offset + 2]!;
      const infoLength = (section[offset + 3]! & 15) << 8 | section[offset + 4]!;
      const infoEnd = Math.min(end, offset + 5 + infoLength);
      if (type === 6) {
        for (let i = offset + 5; i + 2 <= infoEnd;) {
          const tag = section[i]!; const length = section[i + 1]!; const descriptorEnd = i + 2 + length;
          if (descriptorEnd > infoEnd) break;
          if (tag === 0x59 && length >= 8) for (let e = i + 2; e + 8 <= descriptorEnd && tracks.length < 32; e += 8) {
            const language = String.fromCharCode(section[e]!, section[e + 1]!, section[e + 2]!).toLowerCase();
            const compositionPageId = section[e + 4]! << 8 | section[e + 5]!;
            const ancillaryPageId = section[e + 6]! << 8 | section[e + 7]!;
            tracks.push({ id: `${pid}:${compositionPageId}`, pid, language, compositionPageId, ancillaryPageId });
          }
          i = descriptorEnd;
        }
      }
      offset += 5 + infoLength;
    }
    this.tracks = tracks;
    this.selected = tracks.find((track) => track.id === this.selected?.id);
    this.pmtSection = new Uint8Array(0);
  }

  private readPes(payload: Uint8Array, payloadStart: boolean, output: Uint8Array[]): void {
    if (payloadStart) this.pes = payload.slice();
    else if (this.pes.length && this.pes.length + payload.length <= MAX_PES_BYTES) this.pes = join(this.pes, payload);
    else return;
    if (this.pes.length < 6) return;
    const length = (this.pes[4]! << 8) | this.pes[5]!;
    if (!length || length + 6 > MAX_PES_BYTES) { this.pes = new Uint8Array(0); return; }
    if (this.pes.length >= length + 6) {
      const complete = this.pes.subarray(0, length + 6);
      if (output.length < 16) {
        const filtered = filterSelectedPage(complete, this.selected!);
        if (filtered) output.push(filtered);
      }
      this.pes = this.pes.slice(length + 6);
    }
  }
}

function filterSelectedPage(pes: Uint8Array, selected: ScannedDvbTrack): Uint8Array | undefined {
  if (pes.length < 16 || pes[0] !== 0 || pes[1] !== 0 || pes[2] !== 1 || pes[6] !== 0x80) return undefined;
  const payloadStart = 9 + pes[8]!;
  if (payloadStart + 2 > pes.length || pes[payloadStart] !== 0x20) return undefined;
  const segments: Uint8Array[] = [];
  for (let offset = payloadStart + 2; offset + 6 <= pes.length && pes[offset] === 0x0f;) {
    const page = pes[offset + 2]! << 8 | pes[offset + 3]!;
    const length = pes[offset + 4]! << 8 | pes[offset + 5]!;
    const end = offset + 6 + length;
    if (end > pes.length) return undefined;
    if (page === selected.compositionPageId || page === selected.ancillaryPageId) segments.push(pes.subarray(offset, end));
    offset = end;
  }
  if (!segments.length) return undefined;
  const result = new Uint8Array(payloadStart + 2 + segments.reduce((n, segment) => n + segment.length, 0));
  result.set(pes.subarray(0, payloadStart + 2));
  let offset = payloadStart + 2;
  for (const segment of segments) { result.set(segment, offset); offset += segment.length; }
  result[4] = ((result.length - 6) >>> 8) & 255;
  result[5] = (result.length - 6) & 255;
  return result;
}

function join(a: Uint8Array, b: Uint8Array): Uint8Array { const out = new Uint8Array(a.length + b.length); out.set(a); out.set(b, a.length); return out; }
