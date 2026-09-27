const TS_PACKET_BYTES = 188;
const MAX_AUDIO_STREAMS = 32;
const MAX_SAMPLE_BYTES = 128 * 1024;
const MAX_REQUEST_MS = 3_500;

export interface LiveTsAudioMetadata {
  language?: string;
}

export interface LiveTsAudioProbeResult {
  tracks: LiveTsAudioMetadata[];
  status: "ok" | "no-audio-metadata" | "request-failed" | "timeout" | "unsupported";
}

/** Reads audio language descriptors from a bounded sample of a live MPEG-TS stream. */
export function parseLiveTsAudioMetadata(input: Uint8Array): LiveTsAudioMetadata[] {
  let pmtPid: number | undefined;
  let pmt: Uint8Array<ArrayBufferLike> = new Uint8Array(0);
  for (let offset = 0; offset + TS_PACKET_BYTES <= input.length; offset += TS_PACKET_BYTES) {
    if (input[offset] !== 0x47) continue;
    const pid = ((input[offset + 1]! & 0x1f) << 8) | input[offset + 2]!;
    const control = (input[offset + 3]! >> 4) & 3;
    if (control === 0 || control === 2) continue;
    let cursor = offset + 4;
    if (control === 3) cursor += 1 + input[cursor]!;
    if (cursor >= offset + TS_PACKET_BYTES) continue;
    const payloadStart = (input[offset + 1]! & 0x40) !== 0;
    if (pid === 0 && payloadStart) {
      const payload = input.subarray(cursor, offset + TS_PACKET_BYTES);
      const sectionStart = cursor + 1 + payload[0]!;
      if (sectionStart + 12 <= offset + TS_PACKET_BYTES && input[sectionStart] === 0) {
        const end = Math.min(offset + TS_PACKET_BYTES, sectionStart + 3 + (((input[sectionStart + 1]! & 15) << 8) | input[sectionStart + 2]!));
        for (let i = sectionStart + 8; i + 4 <= end - 4; i += 4) {
          if (((input[i]! << 8) | input[i + 1]!) !== 0) {
            pmtPid = ((input[i + 2]! & 31) << 8) | input[i + 3]!;
            break;
          }
        }
      }
      continue;
    }
    if (pid !== pmtPid) continue;
    if (payloadStart) {
      const pointer = input[cursor++]!;
      cursor += pointer;
      pmt = new Uint8Array(0);
    }
    if (cursor < offset + TS_PACKET_BYTES && pmt.length < 1024) {
      pmt = join(pmt, input.subarray(cursor, Math.min(offset + TS_PACKET_BYTES, cursor + 1024 - pmt.length)));
    }
    if (pmt.length < 3 || pmt[0] !== 2) continue;
    const sectionLength = ((pmt[1]! & 15) << 8) | pmt[2]!;
    if (sectionLength > 1021 || pmt.length < sectionLength + 3) continue;
    return parsePmtAudio(pmt.subarray(0, sectionLength + 3));
  }
  return [];
}

function parsePmtAudio(section: Uint8Array): LiveTsAudioMetadata[] {
  const end = section.length - 4;
  let cursor = 12 + (((section[10]! & 15) << 8) | section[11]!);
  const tracks: LiveTsAudioMetadata[] = [];
  while (cursor + 5 <= end && tracks.length < MAX_AUDIO_STREAMS) {
    const type = section[cursor]!;
    const infoLength = ((section[cursor + 3]! & 15) << 8) | section[cursor + 4]!;
    const infoStart = cursor + 5;
    const next = infoStart + infoLength;
    if (next > end) return [];
    if (isAudioStreamType(type)) {
      const language = descriptorLanguage(section, infoStart, next);
      tracks.push(language ? { language } : {});
    }
    cursor = next;
  }
  return tracks;
}

function isAudioStreamType(type: number): boolean {
  return type === 0x03 || type === 0x04 || type === 0x0f || type === 0x11 || type === 0x81 || type === 0x87;
}

function descriptorLanguage(section: Uint8Array, start: number, end: number): string | undefined {
  for (let cursor = start; cursor + 2 <= end;) {
    const tag = section[cursor]!;
    const length = section[cursor + 1]!;
    const next = cursor + 2 + length;
    if (next > end) return undefined;
    if (tag === 0x0a && length >= 4) {
      const language = String.fromCharCode(section[cursor + 2]!, section[cursor + 3]!, section[cursor + 4]!).toLowerCase();
      return /^[a-z]{3}$/.test(language) ? language : undefined;
    }
    cursor = next;
  }
  return undefined;
}

function join(left: Uint8Array, right: Uint8Array): Uint8Array {
  const combined = new Uint8Array(left.length + right.length);
  combined.set(left);
  combined.set(right, left.length);
  return combined;
}

/** Samples the first MPEG-TS segment from a live URL without buffering the stream. */
export async function probeLiveTsAudioMetadata(streamUrl: string): Promise<LiveTsAudioProbeResult> {
  if (typeof XMLHttpRequest === "undefined" || !/^https?:\/\//i.test(streamUrl)) {
    return { tracks: [], status: "unsupported" };
  }
  try {
    const sample = await boundedXhrSample(streamUrl, MAX_SAMPLE_BYTES);
    if (!sample.value) return { tracks: [], status: sample.status };
    const tracks = parseLiveTsAudioMetadata(stringToBytes(sample.value));
    return { tracks, status: tracks.some((track) => track.language) ? "ok" : "no-audio-metadata" };
  } catch {
    // Provider/network errors can contain signed URLs; metadata probing is best effort.
    return { tracks: [], status: "request-failed" };
  }
}

function boundedXhrSample(url: string, maxBytes: number): Promise<{ value: string | undefined; status: "ok" | "request-failed" | "timeout" }> {
  return new Promise((resolve) => {
    let settled = false;
    let xhr: XMLHttpRequest;
    let timedOut = false;
    try {
      xhr = new XMLHttpRequest();
      xhr.open("GET", url, true);
      xhr.timeout = MAX_REQUEST_MS;
      xhr.overrideMimeType("text/plain; charset=x-user-defined");
    } catch {
      resolve({ value: undefined, status: "request-failed" });
      return;
    }
    const finish = (value?: string, status: "ok" | "request-failed" | "timeout" = "request-failed"): void => {
      if (settled) return;
      settled = true;
      resolve({ value, status });
    };
    const partial = (): string => {
      try { return xhr.responseText.slice(0, maxBytes); } catch { return ""; }
    };
    xhr.onprogress = () => {
      const sample = partial();
      if (sample.length >= maxBytes) {
        finish(sample.slice(0, maxBytes), "ok");
        try { xhr.abort(); } catch { /* Resolve the bounded bytes already received. */ }
      }
    };
    xhr.onload = () => finish(partial(), "ok");
    xhr.onerror = () => finish(partial() || undefined, "request-failed");
    xhr.ontimeout = () => { timedOut = true; finish(partial() || undefined, "timeout"); };
    xhr.onabort = () => { if (!settled) finish(partial() || undefined, timedOut ? "timeout" : "request-failed"); };
    try { xhr.send(); } catch { finish(undefined, "request-failed"); }
  });
}

function stringToBytes(value: string): Uint8Array {
  const length = Math.min(value.length, MAX_SAMPLE_BYTES);
  const bytes = new Uint8Array(length);
  for (let i = 0; i < length; i += 1) bytes[i] = value.charCodeAt(i) & 0xff;
  return bytes;
}
