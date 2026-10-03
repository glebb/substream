const PACKET = 188;
const MAX_PES_BYTES = 128 * 1024;
const DEFAULT_MAX_INPUT_BYTES = 20 * 1024 * 1024;

export type ScannedDvbTrack = { id: string; pid: number; language: string; compositionPageId: number; ancillaryPageId: number };
export interface LiveDvbTsScannerOptions {
  maxInputBytes?: number;
  maxOutputPes?: number;
}

/** Bounded MPEG-TS scanner shared by browser, Tizen and relay adapters. */
export class LiveDvbTsScanner {
  private readonly maxInputBytes: number;
  private readonly maxOutputPes: number;
  private pmtPid: number | undefined;
  private pmtSection: Uint8Array<ArrayBufferLike> = new Uint8Array(0);
  private tracks: ScannedDvbTrack[] = [];
  private selected: ScannedDvbTrack | undefined;
  private videoPid: number | undefined;
  private fragmentStartSeconds: number | undefined;
  private fragmentVideoPts: number | undefined;
  private fragmentSubtitlePts: number | undefined;
  private pes: Uint8Array<ArrayBufferLike> = new Uint8Array(0);
  private activePids = new Set<number>();

  constructor(options: LiveDvbTsScannerOptions = {}) {
    this.maxInputBytes = boundedInteger(options.maxInputBytes, DEFAULT_MAX_INPUT_BYTES, 188, 32 * 1024 * 1024);
    this.maxOutputPes = boundedInteger(options.maxOutputPes, 16, 1, 4096);
  }

  select(id: string): void { this.selected = this.tracks.find((track) => track.id === id); this.pes = new Uint8Array(0); }
  getTracks(): ScannedDvbTrack[] { return this.tracks.slice(0, 32); }
  getSelected(): ScannedDvbTrack | undefined { return this.selected; }
  getActiveTracks(): ScannedDvbTrack[] { return this.getTracks().filter((track) => this.activePids.has(track.pid)); }
  getFragmentVideoPts(): number | undefined { return this.fragmentVideoPts; }
  getFragmentSubtitlePts(): number | undefined { return this.fragmentSubtitlePts; }
  resetActivePids(): void { this.activePids.clear(); this.pes = new Uint8Array(0); }

  scan(input: Uint8Array, startSeconds?: number): Uint8Array[] {
    if (startSeconds !== this.fragmentStartSeconds) {
      this.fragmentStartSeconds = startSeconds;
      this.fragmentVideoPts = undefined;
      this.fragmentSubtitlePts = undefined;
    }
    const bytes = input.subarray(0, this.maxInputBytes);
    const output: Uint8Array[] = [];
    for (let offset = 0; offset + PACKET <= bytes.length; offset += PACKET) {
      if (bytes[offset] !== 0x47) continue;
      const pid = ((bytes[offset + 1]! & 0x1f) << 8) | bytes[offset + 2]!;
      this.activePids.add(pid);
      const payloadStart = (bytes[offset + 1]! & 0x40) !== 0;
      const adaptation = (bytes[offset + 3]! >> 4) & 3;
      if (adaptation === 0 || adaptation === 2) continue;
      let start = offset + 4;
      if (adaptation === 3) start += 1 + bytes[start]!;
      if (start >= offset + PACKET) continue;
      const payload = bytes.subarray(start, offset + PACKET);
      if (pid === 0 && payloadStart) this.readPat(payload);
      else if (pid === this.pmtPid) this.readPmt(payload, payloadStart);
      else if (pid === this.videoPid && payloadStart && this.fragmentVideoPts === undefined) {
        this.fragmentVideoPts = pesPts(payload);
      }
      else if (pid === this.selected?.pid) {
        this.readPes(payload, payloadStart, output);
      }
    }
    return output;
  }

  private readPat(payload: Uint8Array): void {
    if (!payload.length) return;
    const start = 1 + payload[0]!;
    if (start + 12 > payload.length || payload[start] !== 0) return;
    const end = Math.min(payload.length, start + 3 + (((payload[start + 1]! & 15) << 8) | payload[start + 2]!));
    for (let i = start + 8; i + 4 <= end - 4; i += 4) {
      if ((payload[i]! << 8 | payload[i + 1]!) !== 0) {
        const nextPmtPid = (payload[i + 2]! & 31) << 8 | payload[i + 3]!;
        if (this.pmtPid !== undefined && this.pmtPid !== nextPmtPid) {
          this.tracks = [];
          this.selected = undefined;
          this.videoPid = undefined;
          this.pmtSection = new Uint8Array(0);
          this.resetActivePids();
        }
        this.pmtPid = nextPmtPid;
        return;
      }
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
    let videoPid: number | undefined;
    while (offset + 5 <= end && tracks.length < 32) {
      const type = section[offset]!;
      const pid = (section[offset + 1]! & 31) << 8 | section[offset + 2]!;
      const infoLength = (section[offset + 3]! & 15) << 8 | section[offset + 4]!;
      const infoEnd = Math.min(end, offset + 5 + infoLength);
      if (videoPid === undefined && (type === 0x1b || type === 0x24 || type === 0x02)) videoPid = pid;
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
    if (trackSignature(this.tracks) !== trackSignature(tracks)) {
      this.activePids.clear();
      this.pes = new Uint8Array(0);
    }
    this.tracks = tracks;
    this.videoPid = videoPid;
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
      if (output.length < this.maxOutputPes) {
        const filtered = filterSelectedPage(complete, this.selected!);
        if (filtered) {
          const pts = pesPts(complete);
          if (pts !== undefined) this.fragmentSubtitlePts = pts;
          output.push(filtered);
        }
      }
      this.pes = this.pes.slice(length + 6);
    }
  }
}

function boundedInteger(value: number | undefined, fallback: number, minimum: number, maximum: number): number {
  return Number.isSafeInteger(value) ? Math.max(minimum, Math.min(maximum, value!)) : fallback;
}

function trackSignature(tracks: readonly ScannedDvbTrack[]): string {
  return tracks.map((track) => `${track.id}/${track.pid}/${track.language}/${track.ancillaryPageId}`).join("|");
}

function pesPts(payload: Uint8Array): number | undefined {
  if (payload.length < 14 || payload[0] !== 0 || payload[1] !== 0 || payload[2] !== 1
    || (payload[7]! & 0x80) === 0 || payload[8]! < 5) return undefined;
  // PTS is an unsigned 33-bit value. Bitwise shifts coerce operands to signed
  // 32-bit integers, so use arithmetic for fields that can set the sign bit.
  return ((payload[9]! & 14) * 0x20000000) + (payload[10]! * 0x400000)
    + ((payload[11]! & 254) * 0x4000) + (payload[12]! * 0x80) + ((payload[13]! & 254) / 2);
}

function filterSelectedPage(pes: Uint8Array, selected: ScannedDvbTrack): Uint8Array | undefined {
  // Byte 6 also carries valid PES flags (such as data_alignment_indicator).
  // Only its two MPEG-2 marker bits identify the optional-header form.
  if (pes.length < 16 || pes[0] !== 0 || pes[1] !== 0 || pes[2] !== 1 || (pes[6]! & 0xc0) !== 0x80) return undefined;
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
