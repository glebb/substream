/** Minimal bounded Matroska/WebM Tracks metadata reader. It never parses media payloads. */
export const MATROSKA_METADATA_LIMIT = 1024 * 1024;

export interface MatroskaSubtitleTrack {
  trackNumber: number;
  label: string;
  language: string;
  codecId: string;
  forced: boolean;
  hearingImpaired: boolean;
  default: boolean;
}

export type MatroskaTracksResult = { kind: "tracks"; tracks: MatroskaSubtitleTrack[] } | { kind: "incomplete" } | { kind: "unsupported" };

const ID = {
  EBML: 0x1a45dfa3, SEGMENT: 0x18538067, TRACKS: 0x1654ae6b, TRACK_ENTRY: 0xae,
  TRACK_NUMBER: 0xd7, TRACK_TYPE: 0x83, NAME: 0x536e, LANGUAGE: 0x22b59c,
  LANGUAGE_IETF: 0x22b59d, CODEC_ID: 0x86, DEFAULT: 0x88, FORCED: 0x55aa,
  HEARING_IMPAIRED: 0x55ab,
} as const;
interface Element { id: number; dataStart: number; dataEnd: number; next: number; }

function vint(bytes: Uint8Array, offset: number, forId: boolean): { value: number; length: number } | undefined {
  if (offset >= bytes.length) return undefined;
  const first = bytes[offset]!;
  let mask = 0x80, length = 1;
  while (length <= 8 && (first & mask) === 0) { mask >>= 1; length++; }
  if (length > (forId ? 4 : 8) || offset + length > bytes.length) return undefined;
  let value = forId ? first : first & (mask - 1);
  for (let i = 1; i < length; i++) value = value * 256 + bytes[offset + i]!;
  return { value, length };
}

function elementAt(bytes: Uint8Array, offset: number, limit: number): Element | undefined {
  const id = vint(bytes, offset, true);
  if (!id) return undefined;
  const size = vint(bytes, offset + id.length, false);
  if (!size) return undefined;
  const dataStart = offset + id.length + size.length;
  // An all-ones size denotes an unknown-length element (commonly Segment).
  const unknownSize = size.value === (2 ** (7 * size.length) - 1);
  const dataEnd = unknownSize ? limit : Math.min(limit, dataStart + size.value);
  if (dataStart > limit || (!unknownSize && dataStart + size.value > bytes.length && id.value !== ID.SEGMENT)) return undefined;
  return { id: id.value, dataStart, dataEnd, next: dataEnd };
}

function unsigned(bytes: Uint8Array, start: number, end: number): number {
  let value = 0;
  for (let i = start; i < end; i++) value = value * 256 + bytes[i]!;
  return value;
}
function string(bytes: Uint8Array, start: number, end: number): string {
  return new TextDecoder().decode(bytes.subarray(start, end)).replace(/\0+$/g, "").trim();
}
function children(bytes: Uint8Array, start: number, end: number): Element[] {
  const result: Element[] = [];
  let position = start;
  while (position < end) {
    const child = elementAt(bytes, position, end);
    if (!child || child.next <= position) break;
    result.push(child);
    position = child.next;
  }
  return result;
}

/** Read subtitle TrackEntry fields from a bounded prefix of an EBML file. */
export function parseMatroskaSubtitleTracks(input: ArrayBuffer | Uint8Array): MatroskaTracksResult {
  const bytes = (input instanceof Uint8Array ? input : new Uint8Array(input)).subarray(0, MATROSKA_METADATA_LIMIT);
  const top = children(bytes, 0, bytes.length);
  const ebml = top.find((element) => element.id === ID.EBML);
  const segment = top.find((element) => element.id === ID.SEGMENT);
  if (!ebml || !segment) return { kind: "unsupported" };
  const tracksElement = children(bytes, segment.dataStart, segment.dataEnd).find((element) => element.id === ID.TRACKS);
  if (!tracksElement) return { kind: "incomplete" };
  const tracks: MatroskaSubtitleTrack[] = [];
  for (const entry of children(bytes, tracksElement.dataStart, tracksElement.dataEnd).filter((element) => element.id === ID.TRACK_ENTRY)) {
    const fields = children(bytes, entry.dataStart, entry.dataEnd);
    const get = (id: number) => fields.find((field) => field.id === id);
    const type = get(ID.TRACK_TYPE);
    if (!type || unsigned(bytes, type.dataStart, type.dataEnd) !== 17) continue;
    const number = get(ID.TRACK_NUMBER);
    const codec = get(ID.CODEC_ID);
    if (!number || !codec) continue;
    const langIetf = get(ID.LANGUAGE_IETF), lang = get(ID.LANGUAGE), name = get(ID.NAME);
    const flag = (id: number) => { const item = get(id); return Boolean(item && unsigned(bytes, item.dataStart, item.dataEnd) !== 0); };
    tracks.push({
      trackNumber: unsigned(bytes, number.dataStart, number.dataEnd),
      label: name ? string(bytes, name.dataStart, name.dataEnd) : "",
      language: string(bytes, (langIetf ?? lang)?.dataStart ?? 0, (langIetf ?? lang)?.dataEnd ?? 0),
      codecId: string(bytes, codec.dataStart, codec.dataEnd),
      forced: flag(ID.FORCED), hearingImpaired: flag(ID.HEARING_IMPAIRED), default: flag(ID.DEFAULT),
    });
  }
  return { kind: "tracks", tracks };
}
