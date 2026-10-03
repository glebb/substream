/**
 * Small, bounded ETSI EN 300 743 decoder for bitmap DVB subtitles.
 *
 * It implements normal display sets made from page, region, CLUT, display
 * definition and pixel object segments. Character coding, progressive objects,
 * alternative CLUTs and 3D disparity segments are deliberately unsupported.
 */

export interface DvbSubtitleDecoderOptions {
  compositionPageId?: number;
  ancillaryPageId?: number;
  /** Maximum decoded display pixels. Defaults to 1920 × 1080. */
  maxDisplayPixels?: number;
}

export interface DvbSubtitleFrame {
  imageData: { data: Uint8ClampedArray; width: number; height: number };
  screenWidth: number;
  screenHeight: number;
  offsetX: number;
  offsetY: number;
}

const MAX_SEGMENT_BYTES = 64 * 1024;
const MAX_SEGMENTS_PER_PES = 512;
const MAX_REGIONS = 32;
const MAX_OBJECTS = 128;
const MAX_CLUTS = 32;
const MAX_DISPLAY_SETS = 4;
const MAX_OBJECT_RUNS = 16_384;
const MAX_TOTAL_RUNS = 40_000;
const DEFAULT_WIDTH = 720;
const DEFAULT_HEIGHT = 576;

interface PageRegion { id: number; x: number; y: number }
interface Page { timeout: number; state: number; regions: PageRegion[] }
interface RegionObject { id: number; type: number; x: number; y: number; foreground: number; background: number }
interface Region { id: number; width: number; height: number; depth: number; clutId: number; fill: boolean; background: number; objects: RegionObject[] }
interface Run { y: number; x: number; length: number; color: number; sourceDepth: number }
interface PixelField { runs: Run[]; map2To4: number[]; map2To8: number[]; map4To8: number[] }
interface BitmapObject { top: Run[]; bottom: Run[]; nonModifying: boolean; map2To4: number[]; map2To8: number[]; map4To8: number[] }
interface Color { r: number; g: number; b: number; a: number }
interface Clut { two: Color[]; four: Color[]; eight: Color[] }
interface DisplayDefinition { width: number; height: number; x: number; y: number; right: number; bottom: number }
interface DisplaySet {
  at: number;
  timeout: number;
  regions: Map<number, PageRegion>;
  regionData: Map<number, Region>;
  objects: Map<number, BitmapObject>;
  cluts: Map<number, Clut>;
  display: DisplayDefinition;
}

const TRANSPARENT: Color = { r: 0, g: 0, b: 0, a: 0 };

/** Decode DVB subtitle PES packets and render the active bitmap page as RGBA. */
export class DvbSubtitleDecoder {
  private readonly compositionPageId: number | undefined;
  private readonly ancillaryPageId: number | undefined;
  private readonly maxDisplayPixels: number;
  private page: Page = { timeout: 0, state: 0, regions: [] };
  private regions = new Map<number, Region>();
  private objects = new Map<number, BitmapObject>();
  private cluts = new Map<number, Clut>();
  private display: DisplayDefinition = { width: DEFAULT_WIDTH, height: DEFAULT_HEIGHT, x: 0, y: 0, right: DEFAULT_WIDTH - 1, bottom: DEFAULT_HEIGHT - 1 };
  private sets: DisplaySet[] = [];
  private lastPtsSeconds = 0;
  private disposed = false;
  private totalRuns = 0;
  count = 0;

  constructor(options: DvbSubtitleDecoderOptions = {}) {
    this.compositionPageId = validPageId(options.compositionPageId);
    this.ancillaryPageId = validPageId(options.ancillaryPageId);
    this.maxDisplayPixels = Number.isSafeInteger(options.maxDisplayPixels) && options.maxDisplayPixels! > 0
      ? Math.min(options.maxDisplayPixels!, 1920 * 1080) : 1920 * 1080;
  }

  feed(pes: Uint8Array): void {
    if (this.disposed || pes.byteLength > MAX_SEGMENT_BYTES * 16 || pes.length < 9) return;
    const payload = pesPayload(pes);
    if (!payload || payload.length < 2 || payload[0] !== 0x20) return;
    const pts = readPesPts(pes);
    if (pts !== undefined) this.lastPtsSeconds = pts / 90_000;
    let offset = 2;
    let segments = 0;
    while (offset + 6 <= payload.length && segments++ < MAX_SEGMENTS_PER_PES) {
      if (payload[offset] !== 0x0f) { offset += 1; continue; }
      const type = payload[offset + 1]!;
      const pageId = read16(payload, offset + 2);
      const length = read16(payload, offset + 4);
      const start = offset + 6;
      const end = start + length;
      if (length > MAX_SEGMENT_BYTES || end > payload.length) return;
      const composition = this.compositionPageId === undefined || pageId === this.compositionPageId;
      const ancillary = this.ancillaryPageId !== undefined && pageId === this.ancillaryPageId;
      if (composition || ancillary) {
        const data = payload.subarray(start, end);
        if (composition) this.processSegment(type, data);
        else if (type === 0x13) this.readObject(data);
        else if (type === 0x12) this.readClut(data);
      }
      if (type === 0x80 && composition) this.commitDisplaySet();
      offset = end;
    }
  }

  renderFrameDataAtTimestamp(seconds: number): DvbSubtitleFrame | null {
    if (this.disposed || !Number.isFinite(seconds) || !this.sets.length) return null;
    let active: DisplaySet | undefined;
    for (const set of this.sets) if (set.at <= seconds) active = set;
    if (!active || (active.timeout > 0 && seconds >= active.at + active.timeout)) return null;
    return renderSet(active, this.maxDisplayPixels);
  }

  /** Returns the current page's timeout in seconds for cue scheduling. */
  getActiveTimeoutAtTimestamp(seconds: number): number | undefined {
    if (this.disposed || !Number.isFinite(seconds)) return undefined;
    let active: DisplaySet | undefined;
    for (const set of this.sets) if (set.at <= seconds) active = set;
    return active?.timeout;
  }

  reset(): void {
    this.page = { timeout: 0, state: 0, regions: [] };
    this.regions.clear(); this.objects.clear(); this.cluts.clear(); this.sets = [];
    this.totalRuns = 0; this.lastPtsSeconds = 0; this.count = 0;
    this.display = { width: DEFAULT_WIDTH, height: DEFAULT_HEIGHT, x: 0, y: 0, right: DEFAULT_WIDTH - 1, bottom: DEFAULT_HEIGHT - 1 };
  }

  dispose(): void { this.reset(); this.disposed = true; }

  private processSegment(type: number, data: Uint8Array): void {
    switch (type) {
      case 0x10: this.readPage(data); break;
      case 0x11: this.readRegion(data); break;
      case 0x12: this.readClut(data); break;
      case 0x13: this.readObject(data); break;
      case 0x14: this.readDisplayDefinition(data); break;
      // 0x80 is the end-of-display-set marker and handled in feed().
    }
  }

  private readPage(data: Uint8Array): void {
    if (data.length < 2) return;
    const timeout = data[0]!;
    const state = (data[1]! >> 2) & 3;
    if (state === 1 || state === 2) {
      this.page = { timeout, state, regions: [] };
      this.regions.clear(); this.objects.clear(); this.cluts.clear();
      this.totalRuns = 0;
    }
    const entries: PageRegion[] = [];
    for (let offset = 2; offset + 6 <= data.length && entries.length < MAX_REGIONS; offset += 6) {
      entries.push({ id: data[offset]!, x: read16(data, offset + 2), y: read16(data, offset + 4) });
    }
    this.page = { timeout, state, regions: entries };
  }

  private readRegion(data: Uint8Array): void {
    if (data.length < 10) return;
    const id = data[0]!;
    const width = read16(data, 2), height = read16(data, 4);
    const depth = (data[6]! >> 2) & 7;
    if (!width || !height || width > 1920 || height > 1080 || width * height > this.maxDisplayPixels || depth < 1 || depth > 3) return;
    const region: Region = {
      id, width, height, depth, clutId: data[7]!, fill: (data[1]! & 8) !== 0,
      background: depth === 1 ? data[9]! & 3 : depth === 2 ? data[9]! >> 4 : data[8]!, objects: [],
    };
    let offset = 10;
    while (offset + 6 <= data.length && region.objects.length < 256) {
      const objectId = read16(data, offset);
      const type = data[offset + 2]! >> 6;
      const x = ((data[offset + 2]! & 0x0f) << 8) | data[offset + 3]!;
      const y = ((data[offset + 4]! & 0x0f) << 8) | data[offset + 5]!;
      let foreground = 0, background = 0;
      offset += 6;
      if (type === 1 || type === 2) {
        if (offset + 2 > data.length) break;
        foreground = data[offset++]!; background = data[offset++]!;
      }
      if (type === 0) region.objects.push({ id: objectId, type, x, y, foreground, background });
    }
    if (this.regions.size < MAX_REGIONS || this.regions.has(id)) this.regions.set(id, region);
  }

  private readClut(data: Uint8Array): void {
    if (data.length < 2) return;
    const id = data[0]!;
    const previous = this.cluts.get(id);
    const clut = previous
      ? { two: previous.two.slice(), four: previous.four.slice(), eight: previous.eight.slice() }
      : defaultClut();
    let offset = 2;
    while (offset + 2 <= data.length) {
      const entryId = data[offset++]!;
      const flags = data[offset++]!;
      const fullRange = (flags & 1) !== 0;
      if ((flags & 0x80) === 0 && (flags & 0x40) === 0 && (flags & 0x20) === 0) continue;
      let y: number, cr: number, cb: number, t: number;
      if (fullRange) {
        if (offset + 4 > data.length) break;
        y = data[offset++]!; cr = data[offset++]!; cb = data[offset++]!; t = data[offset++]!;
      } else {
        if (offset + 2 > data.length) break;
        const a = data[offset++]!, b = data[offset++]!;
        y = ((a >> 2) & 0x3f) << 2;
        cr = (((a & 3) << 2) | (b >> 6)) << 4;
        cb = ((b >> 2) & 0x0f) << 4;
        t = (b & 3) << 6;
      }
      const color = y === 0 ? TRANSPARENT : yCbCrToRgba(y, cr, cb, 255 - t);
      if (flags & 0x80) clut.two[entryId & 3] = color;
      if (flags & 0x40) clut.four[entryId & 15] = color;
      if (flags & 0x20) clut.eight[entryId] = color;
    }
    if (this.cluts.size < MAX_CLUTS || this.cluts.has(id)) this.cluts.set(id, clut);
  }

  private readObject(data: Uint8Array): void {
    if (data.length < 7) return;
    const id = read16(data, 0);
    const coding = (data[2]! >> 2) & 3;
    if (coding !== 0) return;
    const topLength = read16(data, 3), bottomLength = read16(data, 5);
    if (7 + topLength + bottomLength > data.length) return;
    const topField = decodeField(data.subarray(7, 7 + topLength), 0);
    const bottomData = data.subarray(7 + topLength, 7 + topLength + bottomLength);
    const bottomField = bottomLength ? decodeField(bottomData, 1) : { ...topField, runs: topField.runs.map((run) => ({ ...run, y: run.y + 1 })) };
    const top = topField.runs, bottom = bottomField.runs;
    const runCount = top.length + bottom.length;
    const replaced = this.objects.get(id);
    const nextTotal = this.totalRuns - (replaced ? replaced.top.length + replaced.bottom.length : 0) + runCount;
    if (runCount > MAX_OBJECT_RUNS || nextTotal > MAX_TOTAL_RUNS) return;
    this.totalRuns = nextTotal;
    if (this.objects.size < MAX_OBJECTS || this.objects.has(id)) this.objects.set(id, { top, bottom, nonModifying: (data[2]! & 2) !== 0, map2To4: topField.map2To4, map2To8: topField.map2To8, map4To8: topField.map4To8 });
  }

  private readDisplayDefinition(data: Uint8Array): void {
    if (data.length < 5) return;
    const width = read16(data, 1) + 1, height = read16(data, 3) + 1;
    if (width < 1 || height < 1 || width * height > this.maxDisplayPixels) return;
    let x = 0, y = 0, right = width - 1, bottom = height - 1;
    if ((data[0]! & 8) !== 0 && data.length >= 13) {
      x = read16(data, 5); right = read16(data, 7); y = read16(data, 9); bottom = read16(data, 11);
    }
    this.display = { width, height, x, y, right: Math.min(right, width - 1), bottom: Math.min(bottom, height - 1) };
  }

  private commitDisplaySet(): void {
    const regions = new Map<number, PageRegion>();
    for (const region of this.page.regions) regions.set(region.id, region);
    this.sets.push({ at: this.lastPtsSeconds, timeout: this.page.timeout, regions, regionData: new Map(this.regions), objects: new Map(this.objects), cluts: new Map(this.cluts), display: { ...this.display } });
    if (this.sets.length > MAX_DISPLAY_SETS) this.sets.shift();
    this.count = this.sets.length;
  }
}

function pesPayload(pes: Uint8Array): Uint8Array | undefined {
  if (pes.length >= 9 && pes[0] === 0 && pes[1] === 0 && pes[2] === 1) {
    if ((pes[6]! & 0xc0) !== 0x80) return pes.subarray(6);
    const offset = 9 + pes[8]!;
    return offset <= pes.length ? pes.subarray(offset) : undefined;
  }
  // Also accept DVB subtitle data fields directly for small synthetic callers.
  return pes[0] === 0x20 ? pes : undefined;
}

function readPesPts(pes: Uint8Array): number | undefined {
  if (pes.length < 14 || pes[0] !== 0 || pes[1] !== 0 || pes[2] !== 1 || (pes[7]! & 0x80) === 0 || pes[8]! < 5) return undefined;
  return ((pes[9]! & 14) * 0x20000000) + (pes[10]! * 0x400000) + ((pes[11]! & 254) * 0x4000) + (pes[12]! * 128) + ((pes[13]! & 254) / 2);
}

function decodeField(input: Uint8Array, parity: number): PixelField {
  const runs: Run[] = [];
  let offset = 0, y = parity, map2To4 = [0, 7, 8, 15], map2To8 = [0, 119, 136, 255], map4To8 = Array.from({ length: 16 }, (_, i) => i);
  while (offset < input.length && y < 1080 && runs.length < MAX_OBJECT_RUNS) {
    const type = input[offset++]!;
    if (type === 0xf0) { y += 2; continue; }
    if (type === 0x20 && offset + 2 <= input.length) { map2To4 = [input[offset++]! >> 4, input[offset - 1]! & 15, input[offset]! >> 4, input[offset++]! & 15]; continue; }
    if (type === 0x21 && offset + 4 <= input.length) { map2To8 = Array.from(input.subarray(offset, offset + 4)); offset += 4; continue; }
    if (type === 0x22 && offset + 16 <= input.length) { map4To8 = Array.from(input.subarray(offset, offset + 16)); offset += 16; continue; }
    if (type !== 0x10 && type !== 0x11 && type !== 0x12) break;
    const bits = type === 0x10 ? 2 : type === 0x11 ? 4 : 8;
    const reader = new BitReader(input, offset);
    const row: Run[] = [];
    let x = 0, ended = false;
    while (reader.remaining > 0 && x < 2048 && row.length < 4096) {
      const decoded = readRun(reader, bits);
      if (!decoded) { ended = true; break; }
      const color = bits === 2 ? (decoded.color & 3) : bits === 4 ? (decoded.color & 15) : (decoded.color & 255);
      const mapped = bits === 2 ? color : color;
      row.push({ y, x, length: Math.min(decoded.length, 2048 - x), color: mapped, sourceDepth: bits === 2 ? 1 : bits === 4 ? 2 : 3 });
      x += decoded.length;
      if (x >= 2048) break;
    }
    offset += reader.bytesRead;
    if (row.length) runs.push(...row);
    // DVB data types each contain one pixel-code-string.  The RLE end code
    // marks this string; 0xF0 marks the following line.
    if (!ended) break;
    if (runs.length >= MAX_OBJECT_RUNS) break;
  }
  return { runs, map2To4, map2To8, map4To8 };
}

function readRun(reader: BitReader, bits: number): { length: number; color: number } | undefined {
  if (bits === 2) {
    let value = reader.read(2); if (value === undefined) return undefined;
    if (value) return { length: 1, color: value };
    const a = reader.read(1); if (a === undefined) return undefined;
    if (a) { const n = reader.read(3), c = reader.read(2); return n === undefined || c === undefined ? undefined : { length: n + 3, color: c }; }
    const b = reader.read(1); if (b === undefined) return undefined;
    if (b) return { length: 1, color: 0 };
    const c = reader.read(2); if (c === undefined) return undefined;
    if (c === 0) return undefined;
    if (c === 1) return { length: 2, color: 0 };
    const n = reader.read(c === 2 ? 4 : 8), color = reader.read(2);
    return n === undefined || color === undefined ? undefined : { length: n + (c === 2 ? 12 : 29), color };
  }
  if (bits === 4) {
    let value = reader.read(4); if (value === undefined) return undefined;
    if (value) return { length: 1, color: value };
    const a = reader.read(1); if (a === undefined) return undefined;
    if (!a) { const n = reader.read(3); return n === undefined ? undefined : n ? { length: n + 2, color: 0 } : undefined; }
    const b = reader.read(1); if (b === undefined) return undefined;
    if (!b) { const n = reader.read(2), color = reader.read(4); return n === undefined || color === undefined ? undefined : { length: n + 4, color }; }
    const c = reader.read(2); if (c === undefined) return undefined;
    if (c === 0) return { length: 1, color: 0 };
    if (c === 1) return { length: 2, color: 0 };
    const n = reader.read(c === 2 ? 4 : 8), color = reader.read(4);
    return n === undefined || color === undefined ? undefined : { length: n + (c === 2 ? 9 : 25), color };
  }
  const value = reader.read(8); if (value === undefined) return undefined;
  if (value) return { length: 1, color: value };
  const a = reader.read(1); if (a === undefined) return undefined;
  const n = reader.read(7); if (n === undefined) return undefined;
  if (!a) return n ? { length: n, color: 0 } : undefined;
  const color = reader.read(8);
  return color === undefined ? undefined : { length: n + 3, color };
}

class BitReader {
  private bit = 0;
  private readonly bytes: Uint8Array;
  private readonly start: number;
  constructor(bytes: Uint8Array, start: number) { this.bytes = bytes; this.start = start; }
  get remaining(): number { return (this.bytes.length - this.start) * 8 - this.bit; }
  get bytesRead(): number { return Math.ceil(this.bit / 8); }
  read(size: number): number | undefined {
    if (size < 1 || size > 16 || this.remaining < size) return undefined;
    let value = 0;
    for (let i = 0; i < size; i += 1) {
      const byte = this.bytes[this.start + (this.bit >> 3)]!;
      value = (value << 1) | ((byte >> (7 - (this.bit & 7))) & 1);
      this.bit += 1;
    }
    return value;
  }
}

function renderSet(set: DisplaySet, maxPixels: number): DvbSubtitleFrame | null {
  const { width: screenWidth, height: screenHeight } = set.display;
  if (!screenWidth || !screenHeight || screenWidth * screenHeight > maxPixels) return null;
  const pixels = new Uint8ClampedArray(screenWidth * screenHeight * 4);
  for (const [regionId, placement] of set.regions) {
    const region = set.regionData.get(regionId);
    if (!region) continue;
    const clut = set.cluts.get(region.clutId) ?? defaultClut();
    const originX = placement.x, originY = placement.y;
    if (region.fill) fillRect(pixels, screenWidth, screenHeight, originX, originY, region.width, region.height, paletteColor(clut, region.depth, region.background));
    for (const item of region.objects) {
      const object = set.objects.get(item.id);
      if (!object) continue;
      drawRuns(pixels, screenWidth, screenHeight, originX + item.x, originY + item.y, region.width, region.height, object.top, clut, region.depth, object.nonModifying, object);
      drawRuns(pixels, screenWidth, screenHeight, originX + item.x, originY + item.y, region.width, region.height, object.bottom, clut, region.depth, object.nonModifying, object);
    }
  }
  let left = screenWidth, top = screenHeight, right = -1, bottom = -1;
  for (let y = 0; y < screenHeight; y += 1) for (let x = 0; x < screenWidth; x += 1) {
    if (pixels[(y * screenWidth + x) * 4 + 3]! > 0) { left = Math.min(left, x); top = Math.min(top, y); right = Math.max(right, x); bottom = Math.max(bottom, y); }
  }
  if (right < left || bottom < top) return null;
  const width = right - left + 1, height = bottom - top + 1;
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) data.set(pixels.subarray(((top + y) * screenWidth + left) * 4, ((top + y) * screenWidth + right + 1) * 4), y * width * 4);
  return { imageData: { data, width, height }, screenWidth, screenHeight, offsetX: left, offsetY: top };
}

function drawRuns(target: Uint8ClampedArray, screenWidth: number, screenHeight: number, originX: number, originY: number, regionWidth: number, regionHeight: number, runs: Run[], clut: Clut, depth: number, nonModifying: boolean, object: BitmapObject): void {
  for (const run of runs) {
    if (run.color === 1 && nonModifying) continue;
    const y = run.y;
    if (y < 0 || y >= regionHeight || originY + y < 0 || originY + y >= screenHeight) continue;
    const start = Math.max(0, -originX, -run.x), end = Math.min(run.length, regionWidth - run.x, screenWidth - originX - run.x);
    if (end <= start) continue;
    let paletteDepth = run.sourceDepth, paletteCode = run.color;
    if (paletteDepth < depth) {
      if (paletteDepth === 2 && depth === 2) { /* already at target depth */ }
      else if (paletteDepth === 2 && depth === 4) { paletteCode = object.map2To4[paletteCode] ?? paletteCode; paletteDepth = 4; }
      else if (paletteDepth === 2 && depth === 8) { paletteCode = object.map2To8[paletteCode] ?? paletteCode; paletteDepth = 8; }
      else if (paletteDepth === 4 && depth === 8) { paletteCode = object.map4To8[paletteCode] ?? paletteCode; paletteDepth = 8; }
    }
    const color = paletteColor(clut, paletteDepth, paletteCode);
    if (color.a === 0) continue;
    let pos = ((originY + y) * screenWidth + originX + run.x + start) * 4;
    for (let x = start; x < end; x += 1, pos += 4) { target[pos] = color.r; target[pos + 1] = color.g; target[pos + 2] = color.b; target[pos + 3] = color.a; }
  }
}

function fillRect(target: Uint8ClampedArray, screenWidth: number, screenHeight: number, x: number, y: number, width: number, height: number, color: Color): void {
  if (!color.a) return;
  const left = Math.max(0, x), top = Math.max(0, y), right = Math.min(screenWidth, x + width), bottom = Math.min(screenHeight, y + height);
  for (let yy = top; yy < bottom; yy += 1) for (let xx = left; xx < right; xx += 1) {
    const offset = (yy * screenWidth + xx) * 4;
    target[offset] = color.r; target[offset + 1] = color.g; target[offset + 2] = color.b; target[offset + 3] = color.a;
  }
}

function paletteColor(clut: Clut, depth: number, code: number): Color {
  const palette = depth === 1 ? clut.two : depth === 2 ? clut.four : clut.eight;
  return palette[code] ?? TRANSPARENT;
}

function defaultClut(): Clut {
  const two = Array.from({ length: 4 }, (_, i) => i === 0 ? TRANSPARENT : i === 1 ? rgb(255, 255, 255) : i === 2 ? rgb(0, 0, 0) : rgb(128, 128, 128));
  const four = Array.from({ length: 16 }, (_, i) => {
    const first = (i >> 3) & 1, blue = (i >> 1) & 1, green = (i >> 2) & 1, red = i & 1;
    if (!first && !(i & 7)) return TRANSPARENT;
    const scale = first ? 128 : 255;
    return rgb(red * scale, green * scale, blue * scale);
  });
  const eight = Array.from({ length: 256 }, (_, i) => {
    const b1 = (i >> 7) & 1, b2 = (i >> 6) & 1, b3 = (i >> 5) & 1, b4 = (i >> 4) & 1;
    const b5 = (i >> 3) & 1, b6 = (i >> 2) & 1, b7 = (i >> 1) & 1, b8 = i & 1;
    if (!b1 && !b5 && !b2 && !b3 && !b4) {
      if (!(b6 || b7 || b8)) return TRANSPARENT;
      return { r: b8 * 255, g: b7 * 255, b: b6 * 255, a: 64 };
    }
    if (!b1 && b5) return rgb(Math.round(85 * b8 + 170 * b4), Math.round(85 * b7 + 170 * b3), Math.round(85 * b6 + 170 * b2), 128);
    if (b1 && !b5) return rgb(Math.round(43 * b8 + 85 * b4 + 128), Math.round(43 * b7 + 85 * b3 + 128), Math.round(43 * b6 + 85 * b2 + 128));
    return rgb(Math.round(43 * b8 + 85 * b4), Math.round(43 * b7 + 85 * b3), Math.round(43 * b6 + 85 * b2));
  });
  return { two, four, eight };
}

function yCbCrToRgba(y: number, cr: number, cb: number, a: number): Color {
  const c = y - 16, d = cb - 128, e = cr - 128;
  return rgb(1.164 * c + 1.596 * e, 1.164 * c - 0.392 * d - 0.813 * e, 1.164 * c + 2.017 * d, a);
}
function rgb(r: number, g: number, b: number, a = 255): Color { return { r: clamp(r), g: clamp(g), b: clamp(b), a: clamp(a) }; }
function clamp(value: number): number { return Math.max(0, Math.min(255, Math.round(value))); }
function read16(data: Uint8Array, offset: number): number { return (data[offset]! << 8) | data[offset + 1]!; }
function validPageId(value: number | undefined): number | undefined { return Number.isInteger(value) && value! >= 0 && value! <= 0xffff ? value : undefined; }
