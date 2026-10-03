import { deflateSync } from "node:zlib";
import { preferredEmbeddedSubtitleTrack, type EmbeddedSubtitleLanguage } from "../../src/core/subtitles/embedded.ts";
import { DvbSubtitleDecoder } from "../../src/core/subtitles/dvb-decoder.ts";
import { LiveDvbTsScanner, type ScannedDvbTrack } from "../../src/core/subtitles/live-dvb-ts-scanner.ts";
import type { RelayCue, RelayCueBatch, RelaySubtitleImage, RelaySubtitleTrack } from "../../src/core/live-relay/protocol.ts";

const TS_PACKET_BYTES = 188;
const MAX_SEGMENT_BYTES = 20 * 1024 * 1024;
const MAX_FRAME_BYTES = 4 * 1024 * 1024;
const MAX_CUES = 256;
const MAX_IMAGES = 128;
const MAX_IMAGE_BYTES = 16 * 1024 * 1024;
const MAX_PNG_BYTES = 2 * 1024 * 1024;
const PTS_MODULUS = 0x2_0000_0000;

export interface LiveSubtitleSegmentMetadata {
  sequence: number;
  discontinuity?: boolean;
  /** Start of this output HLS segment on its media timeline, when known. */
  mediaStartSeconds?: number;
}

export interface LiveSubtitleProcessorOptions {
  preferredLanguage?: EmbeddedSubtitleLanguage;
  maxCues?: number;
  maxImages?: number;
  maxImageBytes?: number;
}

export interface LiveSubtitleSegmentResult {
  tracks: RelaySubtitleTrack[];
  selectedTrackId: string | null;
  cues: RelayCue[];
  images: RelaySubtitleImage[];
  /** Relay cue timeline is relative to the first output video PTS. */
  timingOrigin?: number;
  /** First output video PTS in 90 kHz units, for AVPlay clock probing. */
  videoPtsOrigin90k?: number;
}

/**
 * Processes each finalized MPEG-TS HLS segment once. It intentionally consumes
 * segment timestamps; packet arrival time is never used as a cue clock.
 */
export class LiveSubtitleSegmentProcessor {
  private readonly scanner = new LiveDvbTsScanner({ maxInputBytes: MAX_SEGMENT_BYTES, maxOutputPes: 512 });
  private readonly preferredLanguage: EmbeddedSubtitleLanguage;
  private readonly maxCues: number;
  private readonly maxImages: number;
  private readonly maxImageBytes: number;
  private decoder: DvbSubtitleDecoder | undefined;
  private selected: ScannedDvbTrack | undefined;
  private captionsOff = false;
  private sequence = 0;
  private epoch = 1;
  private firstVideoPts: number | undefined;
  private previousVideoPts: number | undefined;
  private previousVideoPtsUnwrapped: number | undefined;
  private videoPtsOrigin90k: number | undefined;
  private lastMediaMs = 0;
  private lastInputSequence: number | undefined;
  private scanMarker = 0;
  private resetBeforeCursor = 0;
  private lastImageId: string | undefined;
  private lastCue: RelayCue | undefined;
  private cues: RelayCue[] = [];
  private images = new Map<string, RelaySubtitleImage>();
  private imageBytes = 0;
  private disposed = false;

  constructor(options: LiveSubtitleProcessorOptions = {}) {
    this.preferredLanguage = options.preferredLanguage ?? "fi";
    this.maxCues = boundedInt(options.maxCues, MAX_CUES, 8, 1024);
    this.maxImages = boundedInt(options.maxImages, MAX_IMAGES, 4, 512);
    this.maxImageBytes = boundedInt(options.maxImageBytes, MAX_IMAGE_BYTES, MAX_PNG_BYTES, 64 * 1024 * 1024);
  }

  getSelectedTrackId(): string | null { return this.selected?.id ?? null; }

  selectTrack(trackId: string | null): boolean {
    if (this.disposed) return false;
    if (trackId === null) {
      this.captionsOff = true;
      if (this.selected) this.emitClear(this.lastMediaMs);
      this.resetDecoder();
      this.selected = undefined;
      this.scanner.select("");
      return true;
    }
    const track = this.scanner.getTracks().find((candidate) => candidate.id === trackId);
    if (!track) return false;
    this.captionsOff = false;
    if (track.id === this.selected?.id) return true;
    if (this.selected) this.emitClear(this.lastMediaMs);
    this.resetDecoder();
    this.selected = track;
    this.scanner.select(track.id);
    this.decoder = this.createDecoder(track);
    this.lastImageId = undefined;
    this.lastCue = undefined;
    return true;
  }

  processSegment(bytes: Uint8Array, metadata: LiveSubtitleSegmentMetadata): LiveSubtitleSegmentResult {
    if (this.disposed || bytes.byteLength === 0 || bytes.byteLength > MAX_SEGMENT_BYTES || !Number.isSafeInteger(metadata.sequence) || metadata.sequence < 0) {
      return this.result([], []);
    }
    if (!metadata.discontinuity && metadata.sequence === this.lastInputSequence) return this.result([], []);
    this.lastInputSequence = metadata.sequence;
    const emittedCues: RelayCue[] = [];
    const emittedImages: RelaySubtitleImage[] = [];
    if (metadata.discontinuity) {
      this.epoch++;
      if (this.lastCue && !this.lastCue.clear) {
        this.emitClear(0, emittedCues);
      }
      this.resetDecoder();
      this.lastImageId = undefined;
      this.firstVideoPts = undefined;
      this.previousVideoPts = undefined;
      this.previousVideoPtsUnwrapped = undefined;
      this.videoPtsOrigin90k = undefined;
      this.lastMediaMs = 0;
      this.scanner.resetActivePids();
      if (this.selected) this.decoder = this.createDecoder(this.selected);
    }
    const marker = ++this.scanMarker;

    const before = this.scanner.getSelected()?.id;
    let pesPackets = this.scanner.scan(alignedTs(bytes), marker);
    const advertised = this.scanner.getTracks();
    if (this.selected && !advertised.some((track) => track.id === this.selected?.id)) {
      if (this.lastCue && !this.lastCue.clear) this.emitClear(this.lastMediaMs, emittedCues);
      this.resetDecoder();
      this.selected = undefined;
      this.scanner.select("");
      this.lastImageId = undefined;
    }
    const discovered = this.scanner.getActiveTracks();
    if (!this.selected && !this.captionsOff) {
      const preferred = preferredEmbeddedSubtitleTrack(discovered.map((track) => ({ ...track, label: track.language })), this.preferredLanguage);
      if (preferred) this.selectTrack(preferred.id);
    } else {
      const latest = discovered.find((track) => track.id === this.selected?.id);
      if (latest) this.selected = latest;
    }
    // The first scan discovers the PMT and active PIDs. Repeat this same
    // finalized segment after selection so its first captions are not lost.
    if (this.selected && (before !== this.selected.id || pesPackets.length === 0)) {
      this.scanner.select(this.selected.id);
      pesPackets = this.scanner.scan(alignedTs(bytes), marker);
    }

    const videoPts = this.scanner.getFragmentVideoPts();
    const videoPtsUnwrapped = videoPts === undefined ? undefined : this.unwrapVideoPts(videoPts);
    if (videoPtsUnwrapped !== undefined && this.firstVideoPts !== undefined) {
      this.lastMediaMs = Math.max(this.lastMediaMs, Math.round((videoPtsUnwrapped - this.firstVideoPts) / 90));
    }
    for (const pes of pesPackets) {
      const pts = readPesPts(pes);
      if (pts === undefined || !this.selected || !this.decoder) continue;
      const mediaTime = this.mediaTime(pts, videoPts, videoPtsUnwrapped);
      this.lastMediaMs = Math.max(this.lastMediaMs, Math.round(mediaTime * 1000));
      this.decoder.feed(rebasePesPts(pes, mediaTime));
      const frame = this.decoder.renderFrameDataAtTimestamp(mediaTime);
      if (!frame) {
        if (this.lastCue && !this.lastCue.clear && this.lastImageId) {
          this.lastCue.endMs = Math.max(this.lastCue.startMs, Math.round(mediaTime * 1000));
          this.emitClear(mediaTime * 1000, emittedCues);
          this.lastImageId = undefined;
        }
        continue;
      }
      const cropped = cropFrame(frame.imageData.data, frame.imageData.width, frame.imageData.height);
      if (!cropped || cropped.bytes.byteLength > MAX_FRAME_BYTES) continue;
      const png = encodePng(cropped.bytes, cropped.width, cropped.height);
      if (png.byteLength > MAX_PNG_BYTES || png.byteLength > this.maxImageBytes) continue;
      const imageId = imageKey(this.epoch, this.selected.id, png);
      const timeout = this.decoder.getActiveTimeoutAtTimestamp(mediaTime);
      const samePlacement = this.lastCue?.screenWidth === frame.screenWidth && this.lastCue.screenHeight === frame.screenHeight
        && this.lastCue.x === frame.offsetX + cropped.x && this.lastCue.y === frame.offsetY + cropped.y
        && this.lastCue.width === cropped.width && this.lastCue.height === cropped.height;
      if (imageId === this.lastImageId && samePlacement) {
        const nextEndMs = timeout && timeout > 0 ? Math.round((mediaTime + timeout) * 1000) : undefined;
        if (this.lastCue && nextEndMs !== undefined && nextEndMs > (this.lastCue.endMs ?? this.lastCue.startMs) + 1000) {
          const refresh: RelayCue = {
            ...this.lastCue, seq: ++this.sequence, startMs: Math.round(mediaTime * 1000), endMs: nextEndMs,
          };
          this.pushCue(refresh);
          emittedCues.push(refresh);
          this.lastCue = refresh;
        }
        continue;
      }
      const image: RelaySubtitleImage = { id: imageId, bytes: png, contentType: "image/png" };
      if (!this.images.has(imageId)) {
        if (!this.storeImage(image)) continue;
        emittedImages.push(image);
      }
      if (this.lastCue && !this.lastCue.clear) this.lastCue.endMs = Math.max(this.lastCue.startMs, mediaTime * 1000);
      const cue: RelayCue = {
        seq: ++this.sequence, epoch: this.epoch, trackId: this.selected.id,
        startMs: Math.max(0, Math.round(mediaTime * 1000)),
        ...(timeout && timeout > 0 ? { endMs: Math.max(0, Math.round((mediaTime + timeout) * 1000)) } : {}),
        clear: false, imageId, screenWidth: frame.screenWidth, screenHeight: frame.screenHeight,
        x: frame.offsetX + cropped.x, y: frame.offsetY + cropped.y, width: cropped.width, height: cropped.height,
      };
      this.pushCue(cue);
      emittedCues.push(cue);
      this.lastCue = cue;
      this.lastImageId = imageId;
    }
    return this.result(emittedCues, emittedImages);
  }

  getCueBatch(after: number): RelayCueBatch {
    const cursor = Number.isSafeInteger(after) && after >= 0 ? after : 0;
    const oldest = this.cues[0]?.seq ?? this.sequence + 1;
    const reset = cursor < this.resetBeforeCursor || (cursor > 0 && cursor < oldest - 1);
    const active = this.lastCue && !this.lastCue.clear
      && (this.lastCue.endMs === undefined || this.lastCue.endMs > this.lastMediaMs)
      ? this.lastCue : null;
    return { cues: this.cues.filter((cue) => cue.seq > cursor), nextCursor: this.sequence, reset, ...(reset ? { active } : {}) };
  }

  getImage(imageId: string): RelaySubtitleImage | undefined { return this.images.get(imageId); }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.resetDecoder();
    this.cues = [];
    this.images.clear();
    this.imageBytes = 0;
  }

  private unwrapVideoPts(rawPts: number): number {
    let value = rawPts;
    if (this.previousVideoPts !== undefined && this.previousVideoPtsUnwrapped !== undefined) {
      let delta = rawPts - this.previousVideoPts;
      if (delta > PTS_MODULUS / 2) delta -= PTS_MODULUS;
      if (delta < -PTS_MODULUS / 2) delta += PTS_MODULUS;
      value = this.previousVideoPtsUnwrapped + delta;
    }
    this.firstVideoPts ??= value;
    this.videoPtsOrigin90k ??= rawPts;
    this.previousVideoPts = rawPts;
    this.previousVideoPtsUnwrapped = value;
    return value;
  }

  private mediaTime(pts: number, videoPts: number | undefined, videoPtsUnwrapped: number | undefined): number {
    // Compare modulo 2^33 in a signed half-range, which handles wrap without
    // treating the wrapped timestamp as a huge forward jump.
    const anchor = videoPts ?? pts;
    let delta = pts - anchor;
    if (delta > PTS_MODULUS / 2) delta -= PTS_MODULUS;
    if (delta < -PTS_MODULUS / 2) delta += PTS_MODULUS;
    const origin = this.firstVideoPts !== undefined && videoPtsUnwrapped !== undefined
      ? (videoPtsUnwrapped - this.firstVideoPts) / 90_000 : 0;
    return Math.max(0, origin + delta / 90_000);
  }

  private emitClear(atMs: number, output?: RelayCue[]): RelayCue {
    const cue: RelayCue = {
      seq: ++this.sequence, epoch: this.epoch, trackId: this.selected?.id ?? "",
      startMs: Math.max(0, Math.round(atMs)), clear: true,
      screenWidth: 0, screenHeight: 0, x: 0, y: 0, width: 0, height: 0,
    };
    this.pushCue(cue);
    this.lastCue = cue;
    output?.push(cue);
    return cue;
  }

  private pushCue(cue: RelayCue): void {
    this.cues.push(cue);
    while (this.cues.length > this.maxCues) this.cues.shift();
  }

  private storeImage(image: RelaySubtitleImage): boolean {
    if (image.bytes.byteLength > this.maxImageBytes) return false;
    while (this.images.size >= this.maxImages || this.imageBytes + image.bytes.byteLength > this.maxImageBytes) {
      const activeImageId = this.lastCue && !this.lastCue.clear
        && (this.lastCue.endMs === undefined || this.lastCue.endMs > this.lastMediaMs) ? this.lastCue.imageId : undefined;
      const oldestId = [...this.images.keys()].find((id) => id !== activeImageId);
      if (!oldestId) return false;
      this.imageBytes -= this.images.get(oldestId)!.bytes.byteLength;
      this.images.delete(oldestId);
      const removedSeq = this.cues.filter((cue) => cue.imageId === oldestId).reduce((max, cue) => Math.max(max, cue.seq), 0);
      if (removedSeq) {
        this.cues = this.cues.filter((cue) => cue.imageId !== oldestId);
        this.resetBeforeCursor = Math.max(this.resetBeforeCursor, removedSeq);
      }
    }
    this.images.set(image.id, image);
    this.imageBytes += image.bytes.byteLength;
    return true;
  }

  private resetDecoder(): void { this.decoder?.dispose(); this.decoder = undefined; }

  private createDecoder(track: ScannedDvbTrack): DvbSubtitleDecoder {
    return new DvbSubtitleDecoder({ compositionPageId: track.compositionPageId, ancillaryPageId: track.ancillaryPageId });
  }

  private result(cues: RelayCue[], images: RelaySubtitleImage[]): LiveSubtitleSegmentResult {
    const tracks = this.scanner.getActiveTracks().map(toRelayTrack);
    return {
      tracks, selectedTrackId: this.selected?.id ?? null, cues, images,
      ...(this.firstVideoPts !== undefined ? { timingOrigin: 0 } : {}),
      ...(this.videoPtsOrigin90k !== undefined ? { videoPtsOrigin90k: this.videoPtsOrigin90k } : {}),
    };
  }
}

function toRelayTrack(track: ScannedDvbTrack): RelaySubtitleTrack {
  const name = track.language === "fin" ? "Finnish" : track.language === "eng" ? "English" : track.language.toUpperCase();
  return { id: track.id, language: track.language, label: `${name} · DVB` };
}

function alignedTs(bytes: Uint8Array): Uint8Array {
  const sync = bytes.indexOf(0x47);
  if (sync < 0) return new Uint8Array(0);
  const aligned = bytes.subarray(sync);
  const length = Math.floor(aligned.length / TS_PACKET_BYTES) * TS_PACKET_BYTES;
  return aligned.subarray(0, length);
}

function readPesPts(pes: Uint8Array): number | undefined {
  if (pes.length < 14 || pes[0] !== 0 || pes[1] !== 0 || pes[2] !== 1 || (pes[7]! & 0x80) === 0 || pes[8]! < 5) return undefined;
  return ((pes[9]! & 14) * 0x20000000) + (pes[10]! * 0x400000) + ((pes[11]! & 254) * 0x4000) + (pes[12]! * 128) + ((pes[13]! & 254) / 2);
}

function rebasePesPts(pes: Uint8Array, seconds: number): Uint8Array {
  if (pes.length < 14 || (pes[7]! & 0x80) === 0) return pes;
  const pts = Math.max(0, Math.round(seconds * 90_000)) % PTS_MODULUS;
  const copy = pes.slice();
  copy[9] = (copy[9]! & 0xf0) | ((Math.floor(pts / 0x20000000) & 14) | 1);
  copy[10] = Math.floor(pts / 0x400000) & 255;
  copy[11] = (Math.floor(pts / 0x4000) & 254) | 1;
  copy[12] = Math.floor(pts / 128) & 255;
  copy[13] = ((pts * 2) & 254) | 1;
  return copy;
}

function cropFrame(data: Uint8ClampedArray, width: number, height: number): { bytes: Uint8Array; width: number; height: number; x: number; y: number } | undefined {
  if (width < 1 || height < 1 || width > 1920 || height > 1080 || data.byteLength !== width * height * 4) return undefined;
  let left = width, top = height, right = -1, bottom = -1;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    if (data[(y * width + x) * 4 + 3]! === 0) continue;
    left = Math.min(left, x); top = Math.min(top, y); right = Math.max(right, x); bottom = Math.max(bottom, y);
  }
  if (right < left || bottom < top) return undefined;
  const outWidth = right - left + 1, outHeight = bottom - top + 1;
  const bytes = new Uint8Array(outWidth * outHeight * 4);
  for (let y = 0; y < outHeight; y++) {
    const from = ((top + y) * width + left) * 4;
    bytes.set(data.subarray(from, from + outWidth * 4), y * outWidth * 4);
  }
  return { bytes, width: outWidth, height: outHeight, x: left, y: top };
}

function encodePng(rgba: Uint8Array, width: number, height: number): Uint8Array {
  const scanlines = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) scanlines.set(rgba.subarray(y * width * 4, (y + 1) * width * 4), y * (width * 4 + 1) + 1);
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4);
  header[8] = 8; header[9] = 6; header[10] = 0; header[11] = 0; header[12] = 0;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), pngChunk("IHDR", header), pngChunk("IDAT", deflateSync(scanlines)), pngChunk("IEND", Buffer.alloc(0))]);
}

function pngChunk(type: string, data: Buffer): Buffer {
  const typeBytes = Buffer.from(type, "ascii"), length = Buffer.alloc(4); length.writeUInt32BE(data.length);
  const crc = crc32(Buffer.concat([typeBytes, data])); const checksum = Buffer.alloc(4); checksum.writeUInt32BE(crc);
  return Buffer.concat([length, typeBytes, data, checksum]);
}

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function imageKey(epoch: number, trackId: string, png: Uint8Array): string {
  let hash = 2166136261;
  for (const byte of png) hash = Math.imul(hash ^ byte, 16777619);
  return `${epoch}-${trackId.replace(/[^a-zA-Z0-9_-]/g, "_")}-${png.byteLength}-${(hash >>> 0).toString(16)}`;
}

function boundedInt(value: number | undefined, fallback: number, minimum: number, maximum: number): number {
  return Number.isSafeInteger(value) ? Math.max(minimum, Math.min(maximum, value!)) : fallback;
}
