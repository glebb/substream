const PACKET_BYTES = 188;
const MAX_TRACKS = 32;
const MAX_AUDIO_FRAGMENT_BYTES = 20 * 1024 * 1024;

/** Bound the extra copy needed to rewrite audio metadata in a live fragment. */
export function processLiveAudioFragment(data: ArrayBuffer, processor: LiveAudioTsProcessor): ArrayBuffer {
  if (data.byteLength > MAX_AUDIO_FRAGMENT_BYTES) return data;
  return processor.process(new Uint8Array(data)).buffer as ArrayBuffer;
}

export interface EmbeddedTsAudioTrack {
  id: string;
  pid: number;
  language?: string;
  codec: string;
}

/** Reorders the selected audio PID to the front of each PMT for hls.js TS demuxing. */
export class LiveAudioTsProcessor {
  private pmtPid: number | undefined;
  private selectedPid: number | undefined;
  private tracks: EmbeddedTsAudioTrack[] = [];

  getTracks(): EmbeddedTsAudioTrack[] { return this.tracks.slice(); }
  getSelectedId(): string | undefined { return this.selectedPid === undefined ? undefined : `ts:${this.selectedPid}`; }

  select(id: string): boolean {
    const track = this.tracks.find((candidate) => candidate.id === id);
    if (!track) return false;
    this.selectedPid = track.pid;
    return true;
  }

  requestSelection(id: string): boolean {
    const match = /^ts:(\d{1,5})$/.exec(id);
    if (!match) return false;
    this.selectedPid = Number(match[1]);
    return true;
  }

  process(input: Uint8Array): Uint8Array {
    // Fragments may already have the selected audio first. Discover tracks
    // without copying megabytes of video; copy only if a PMT must change.
    let output = input;
    const writableOutput = (): Uint8Array => {
      if (output === input) output = input.slice();
      return output;
    };
    let section: number[] = [];
    let sectionOffsets: number[] = [];
    let expectedLength = 0;
    for (let offset = 0; offset + PACKET_BYTES <= output.length; offset += PACKET_BYTES) {
      if (output[offset] !== 0x47) continue;
      const pid = ((output[offset + 1]! & 0x1f) << 8) | output[offset + 2]!;
      const control = (output[offset + 3]! >> 4) & 3;
      if (control === 0 || control === 2) continue;
      let payloadOffset = offset + 4;
      if (control === 3) payloadOffset += 1 + output[payloadOffset]!;
      if (payloadOffset >= offset + PACKET_BYTES) continue;
      const start = (output[offset + 1]! & 0x40) !== 0;
      let cursor = payloadOffset;
      if (start) {
        if (pid === 0) this.readPat(output.subarray(cursor, offset + PACKET_BYTES));
        if (pid !== this.pmtPid) continue;
        const pointer = output[cursor++]!;
        // Complete a preceding section first, then parse the new section.
        if (section.length && pointer > 0) {
          const take = Math.min(pointer, offset + PACKET_BYTES - cursor);
          for (let i = 0; i < take; i += 1) { section.push(output[cursor + i]!); sectionOffsets.push(cursor + i); }
          const parsed = this.rewriteSection(section, sectionOffsets, writableOutput);
          if (parsed) { section = []; sectionOffsets = []; expectedLength = 0; }
        }
        cursor += pointer;
        section = [];
        sectionOffsets = [];
        expectedLength = 0;
      } else if (pid !== this.pmtPid) continue;
      if (pid !== this.pmtPid) continue;
      for (; cursor < offset + PACKET_BYTES; cursor += 1) {
        section.push(output[cursor]!);
        sectionOffsets.push(cursor);
        if (section.length === 3) expectedLength = 3 + (((section[1]! & 15) << 8) | section[2]!);
        if (expectedLength > 0 && section.length >= expectedLength) {
          this.rewriteSection(section, sectionOffsets, writableOutput);
          section = [];
          sectionOffsets = [];
          expectedLength = 0;
          // PSI stuffing begins with 0xff; there are no further sections in normal PMTs.
          break;
        }
      }
    }
    return output;
  }

  private readPat(payload: Uint8Array): void {
    if (payload.length < 9) return;
    const start = 1 + payload[0]!;
    if (start + 12 > payload.length || payload[start] !== 0) return;
    const end = Math.min(payload.length, start + 3 + (((payload[start + 1]! & 15) << 8) | payload[start + 2]!));
    for (let i = start + 8; i + 4 <= end - 4; i += 4) {
      if ((payload[i]! << 8 | payload[i + 1]!) !== 0) {
        this.pmtPid = (payload[i + 2]! & 31) << 8 | payload[i + 3]!;
        return;
      }
    }
  }

  private rewriteSection(sectionInput: number[], offsets: number[], writableOutput: () => Uint8Array): boolean {
    if (sectionInput.length < 16 || sectionInput[0] !== 2) return false;
    const section = Uint8Array.from(sectionInput);
    const sectionLength = ((section[1]! & 15) << 8) | section[2]!;
    if (sectionLength + 3 !== section.length || sectionLength > 1021) return false;
    const end = section.length - 4;
    let cursor = 12 + (((section[10]! & 15) << 8) | section[11]!);
    const streams: Array<{ bytes: Uint8Array; track?: EmbeddedTsAudioTrack }> = [];
    while (cursor + 5 <= end && streams.length < MAX_TRACKS) {
      const type = section[cursor]!;
      const pid = ((section[cursor + 1]! & 31) << 8) | section[cursor + 2]!;
      const infoLength = ((section[cursor + 3]! & 15) << 8) | section[cursor + 4]!;
      const next = cursor + 5 + infoLength;
      if (next > end) return false;
      const codec = type === 0x0f ? "aac" : type === 0x11 ? "aac-latm" : type === 0x03 || type === 0x04 ? "mpeg-audio" : undefined;
      const language = codec ? descriptorLanguage(section, cursor + 5, next) : undefined;
      streams.push({ bytes: section.slice(cursor, next), ...(codec ? { track: { id: `ts:${pid}`, pid, codec, ...(language ? { language } : {}) } } : {}) });
      cursor = next;
    }
    this.tracks = streams.flatMap((stream) => stream.track ? [stream.track] : []).slice(0, MAX_TRACKS);
    if (this.selectedPid === undefined || !this.tracks.some((track) => track.pid === this.selectedPid)) {
      this.selectedPid = chooseDefaultAudio(this.tracks)?.pid;
    }
    const selectedStream = streams.find((stream) => stream.track?.pid === this.selectedPid);
    if (!selectedStream) return true;
    const audioStreams = streams.filter((stream) => stream.track);
    if (audioStreams[0] !== selectedStream) {
      const reordered = [selectedStream, ...streams.filter((stream) => stream !== selectedStream)];
      const body = reordered.flatMap((stream) => [...stream.bytes]);
      const newSection = new Uint8Array(section.length);
      newSection.set(section.subarray(0, 12));
      newSection.set(body, 12);
      const bodyEnd = 12 + body.length;
      newSection.set(section.subarray(end), bodyEnd);
      writeCrc(newSection, newSection.length - 4);
      const output = writableOutput();
      for (let i = 0; i < newSection.length; i += 1) output[offsets[i]!] = newSection[i]!;
    }
    return true;
  }
}

function descriptorLanguage(section: Uint8Array, start: number, end: number): string | undefined {
  for (let cursor = start; cursor + 2 <= end;) {
    const tag = section[cursor]!;
    const length = section[cursor + 1]!;
    const next = cursor + 2 + length;
    if (next > end) return undefined;
    if (tag === 0x0a && length >= 4) return String.fromCharCode(section[cursor + 2]!, section[cursor + 3]!, section[cursor + 4]!).toLowerCase();
    cursor = next;
  }
  return undefined;
}

function chooseDefaultAudio(tracks: EmbeddedTsAudioTrack[]): EmbeddedTsAudioTrack | undefined {
  return tracks.find((track) => track.language === "fin" || track.language === "fi")
    ?? tracks.find((track) => track.language === "eng" || track.language === "en")
    ?? tracks[0];
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
