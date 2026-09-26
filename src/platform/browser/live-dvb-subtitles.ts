type HlsLike = {
  on(event: string, listener: (event: string, data: Record<string, unknown>) => void): void;
  off(event: string, listener: (event: string, data: Record<string, unknown>) => void): void;
};

type HlsEvents = { FRAG_LOADED: string; FRAG_DECRYPTED: string; INIT_PTS_FOUND: string };

type DvbTrack = { pid: number; language: string; compositionPageId: number; ancillaryPageId: number };
type Renderer = { append(data: Uint8Array): Promise<number>; reset(): Promise<void>; dispose(): void };
type QueuedPes = { data: Uint8Array; start: number; cc: number | undefined };
type QueuedFragment = { bytes: Uint8Array; start: number; cc: number | undefined; offset: number };

const TS_PACKET = 188;
const PTS_WRAP = 0x200000000;
// DVB subtitle PES packets carry a 16-bit packet length. Allow some headroom
// for zero-length/malformed packets, but never repeatedly copy an unbounded
// transport payload on the browser's main thread.
const MAX_PENDING_PES_BYTES = 128 * 1024;
// Keep each main-thread parsing slice short. hls.js and video playback own
// their workers independently; this reader must never monopolize the UI.
const TS_PACKETS_PER_TASK = 32;
const MAX_QUEUED_FRAGMENTS = 8;
// Even after discovery, accept only a bounded portion of each media fragment.
// A dropped tail is recovered from the next PAT/PMT/PES repetition.
const MAX_ACTIVE_FRAGMENT_BYTES = 512 * 1024;
// PAT/PMT tables are repeated at the beginning of ordinary HLS TS segments.
// Until one advertises a DVB subtitle descriptor, retain only this bounded
// prefix. This keeps subtitle discovery safe for channels with large or noisy
// transport streams that carry no subtitles at all.
const DISCOVERY_FRAGMENT_BYTES = 64 * 1024;

/**
 * Extracts DVB subtitle PES packets from HLS MPEG-TS media fragments. hls.js
 * does not expose stream type 0x06 / descriptor 0x59, so this deliberately
 * observes the original fragment bytes before its video demuxer drops them.
 */
export class LiveDvbSubtitles {
  private pmtPid: number | undefined;
  private pmtSection: Uint8Array<ArrayBufferLike> = new Uint8Array(0);
  private tracks: DvbTrack[] = [];
  private selected: DvbTrack | undefined;
  private pendingPes: Uint8Array<ArrayBufferLike> = new Uint8Array(0);
  private queuedPes: QueuedPes[] = [];
  private queuedBytes = 0;
  private initPts: number | undefined;
  private initPtsCc: number | undefined;
  private renderer: Renderer | undefined;
  private rendererPromise: Promise<Renderer> | undefined;
  private lastContinuityCounter: number | undefined;
  private disposed = false;
  private enabled = false;
  private selectionVersion = 0;
  private readonly history: QueuedPes[] = [];
  private historyBytes = 0;
  private rebuildCount = 0;
  private rendererOps: Promise<void> = Promise.resolve();
  private rendererFailed = false;
  private queuedFragments: QueuedFragment[] = [];
  private fragmentTimer: ReturnType<typeof setTimeout> | undefined;

  private readonly onInitPts = (_event: string, data: Record<string, unknown>) => {
    const id = data.id;
    if (id !== undefined && id !== "main") return;
    const timescale = Number(data.timescale) || 90_000;
    const value = Number(data.initPTS) * 90_000 / timescale;
    if (Number.isFinite(value)) {
      this.initPts = value;
      const fragment = data.frag as { cc?: number } | undefined;
      this.initPtsCc = fragment?.cc ?? (typeof data.cc === "number" ? data.cc : undefined);
      const queued = this.queuedPes;
      this.queuedPes = [];
      this.queuedBytes = 0;
      if (this.enabled) for (const packet of queued) if (packet.cc === undefined || this.initPtsCc === undefined || packet.cc === this.initPtsCc) this.append(packet.data, packet.start, this.selectionVersion, value);
    }
  };

  private readonly onFragment = (_event: string, data: Record<string, unknown>) => {
    const payload = data.payload;
    const fragment = data.frag as { type?: string; start?: number; cc?: number } | undefined;
    if (!(payload instanceof ArrayBuffer) || fragment?.type !== "main" || this.disposed) return;
    // HLS may transfer the source buffer to its demux worker as soon as this
    // event returns, so retain one local copy for time-sliced subtitle parsing.
    // Before a DVB descriptor is discovered, copy only the PAT/PMT prefix.
    const source = new Uint8Array(payload);
    const captureLimit = this.tracks.length ? MAX_ACTIVE_FRAGMENT_BYTES : DISCOVERY_FRAGMENT_BYTES;
    const bytes = source.subarray(0, Math.min(source.length, captureLimit)).slice();
    this.queuedFragments.push({ bytes, start: Math.max(0, Number(fragment.start) || 0), cc: fragment.cc, offset: 0 });
    while (this.queuedFragments.length > MAX_QUEUED_FRAGMENTS) this.queuedFragments.shift();
    this.scheduleFragmentWork();
  };

  private scheduleFragmentWork(): void {
    if (this.fragmentTimer !== undefined || this.disposed || !this.queuedFragments.length) return;
    this.fragmentTimer = setTimeout(() => {
      this.fragmentTimer = undefined;
      this.processFragmentWork();
      this.scheduleFragmentWork();
    }, 0);
  }

  private processFragmentWork(): void {
    const fragment = this.queuedFragments[0];
    if (!fragment || this.disposed) return;
    if (fragment.offset === 0) this.beginFragment(fragment.cc);
    const end = Math.min(fragment.bytes.length, fragment.offset + TS_PACKET * TS_PACKETS_PER_TASK);
    this.consume(fragment.bytes.subarray(fragment.offset, end), fragment.start);
    fragment.offset = end;
    if (fragment.offset >= fragment.bytes.length) this.queuedFragments.shift();
  }

  private beginFragment(continuityCounter: number | undefined): void {
    if (this.lastContinuityCounter !== undefined && continuityCounter !== undefined && continuityCounter !== this.lastContinuityCounter) {
      this.pendingPes = new Uint8Array(0);
      this.queuedPes = [];
      this.queuedBytes = 0;
      // HLS can publish initPTS before queued fragment work runs. Preserve it
      // when it already belongs to the incoming continuity.
      if (this.initPtsCc !== continuityCounter) {
        this.initPts = undefined;
        this.initPtsCc = undefined;
      }
      this.history.length = 0;
      this.historyBytes = 0;
      this.selectionVersion++;
      this.queueRenderer(async (renderer) => { await renderer.reset(); });
    }
    this.lastContinuityCounter = continuityCounter;
  }

  constructor(
    private readonly video: HTMLVideoElement,
    private readonly hls: HlsLike,
    private readonly events: HlsEvents,
    private readonly createRenderer?: () => Promise<Renderer>,
    private readonly onTracksChange?: (tracks: Array<{ id: string; label: string; language: string; selected: boolean }>) => void,
    private readonly onRendererError?: (error: unknown) => void,
  ) {
    hls.on(events.INIT_PTS_FOUND, this.onInitPts);
    // FRAG_LOADED has the original TS bytes for unencrypted streams. For an
    // encrypted stream, FRAG_DECRYPTED supplies the equivalent clear bytes.
    hls.on(events.FRAG_LOADED, this.onFragment);
    hls.on(events.FRAG_DECRYPTED, this.onFragment);
  }

  dispose(): void {
    this.disposed = true;
    if (this.fragmentTimer !== undefined) clearTimeout(this.fragmentTimer);
    this.fragmentTimer = undefined;
    this.queuedFragments = [];
    this.hls.off(this.events.INIT_PTS_FOUND, this.onInitPts);
    this.hls.off(this.events.FRAG_LOADED, this.onFragment);
    this.hls.off(this.events.FRAG_DECRYPTED, this.onFragment);
    this.renderer?.dispose();
    this.renderer = undefined;
    this.pendingPes = new Uint8Array(0);
    this.queuedPes = [];
    this.history.length = 0;
  }

  getTracks(): Array<{ id: string; label: string; language: string; selected: boolean }> {
    return this.tracks.map((track) => ({
      id: `${track.pid}:${track.compositionPageId}`, label: `${track.language} · DVB`, language: track.language,
      selected: track.pid === this.selected?.pid && track.compositionPageId === this.selected.compositionPageId,
    }));
  }

  isSelected(id: string): boolean {
    return `${this.selected?.pid}:${this.selected?.compositionPageId}` === id;
  }

  selectTrack(id: string): boolean {
    const next = this.tracks.find((track) => `${track.pid}:${track.compositionPageId}` === id);
    if (!next || this.rendererFailed) return false;
    const previousId = this.selected && `${this.selected.pid}:${this.selected.compositionPageId}`;
    this.selected = next;
    this.enabled = true;
    if (previousId === id) return true;
    this.selectionVersion++;
    this.pendingPes = new Uint8Array(0);
    this.queuedPes = [];
    this.queuedBytes = 0;
    this.history.length = 0;
    this.historyBytes = 0;
    this.onTracksChange?.(this.getTracks());
    void this.ensureRenderer().catch((error: unknown) => this.handleRendererError(error));
    return true;
  }

  setEnabled(enabled: boolean): void {
    if (this.enabled === enabled) return;
    this.enabled = enabled;
    this.selectionVersion++;
    if (!enabled) {
      this.queuedPes = [];
      this.queuedBytes = 0;
      this.queueRenderer(async (renderer) => { await renderer.reset(); });
    } else if (this.initPts !== undefined) {
      const queued = this.queuedPes;
      this.queuedPes = [];
      this.queuedBytes = 0;
      for (const packet of queued) this.append(packet.data, packet.start, this.selectionVersion, this.initPts);
    }
  }

  private consume(bytes: Uint8Array, fragmentStart: number): void {
    for (let offset = 0; offset + TS_PACKET <= bytes.length; offset += TS_PACKET) {
      if (bytes[offset] !== 0x47) continue;
      const payloadStart = (bytes[offset + 1]! & 0x40) !== 0;
      const pid = ((bytes[offset + 1]! & 0x1f) << 8) | bytes[offset + 2]!;
      const adaptation = (bytes[offset + 3]! >> 4) & 3;
      if (adaptation === 0 || adaptation === 2) continue;
      let start = offset + 4;
      if (adaptation === 3) start += 1 + bytes[start]!;
      if (start >= offset + TS_PACKET) continue;
      const payload = bytes.subarray(start, offset + TS_PACKET);
      if (pid === 0) this.parsePat(payload, payloadStart);
      else if (pid === this.pmtPid) this.parsePmt(payload, payloadStart);
      else if (pid === this.selected?.pid) this.pushPes(payload, payloadStart, fragmentStart);
    }
  }

  private parsePat(payload: Uint8Array, payloadStart: boolean): void {
    if (!payloadStart) return;
    const start = 1 + payload[0]!;
    if (payload[start] !== 0 || start + 12 > payload.length) return;
    const sectionEnd = Math.min(payload.length, start + 3 + (((payload[start + 1]! & 15) << 8) | payload[start + 2]!));
    for (let offset = start + 8; offset + 4 <= sectionEnd - 4; offset += 4) {
      const program = (payload[offset]! << 8) | payload[offset + 1]!;
      if (program !== 0) { this.pmtPid = ((payload[offset + 2]! & 31) << 8) | payload[offset + 3]!; return; }
    }
  }

  private parsePmt(payload: Uint8Array, payloadStart: boolean): void {
    if (payloadStart) {
      const start = 1 + payload[0]!;
      this.pmtSection = start < payload.length ? payload.slice(start) : new Uint8Array(0);
    } else this.pmtSection = join(this.pmtSection, payload);
    if (this.pmtSection.length < 3 || this.pmtSection[0] !== 2) return;
    const sectionLength = ((this.pmtSection[1]! & 15) << 8) | this.pmtSection[2]!;
    if (this.pmtSection.length < sectionLength + 3) return;
    const section = this.pmtSection.subarray(0, sectionLength + 3);
    this.pmtSection = new Uint8Array(0);
    const sectionEnd = section.length;
    let offset = 12 + (((section[10]! & 15) << 8) | section[11]!);
    const tracks: DvbTrack[] = [];
    while (offset + 5 <= sectionEnd - 4) {
      const streamType = section[offset]!;
      const pid = ((section[offset + 1]! & 31) << 8) | section[offset + 2]!;
      const infoEnd = offset + 5 + (((section[offset + 3]! & 15) << 8) | section[offset + 4]!);
      if (streamType === 6) for (let descriptor = offset + 5; descriptor + 2 <= infoEnd && descriptor + 2 <= section.length;) {
        const length = section[descriptor + 1]!;
        if (section[descriptor] === 0x59 && length >= 8 && descriptor + 2 + length <= infoEnd && descriptor + 2 + length <= section.length) {
          const language = String.fromCharCode(section[descriptor + 2]!, section[descriptor + 3]!, section[descriptor + 4]!).toLowerCase();
          for (let entry = descriptor + 2; entry + 8 <= descriptor + 2 + length; entry += 8) {
            const entryLanguage = String.fromCharCode(section[entry]!, section[entry + 1]!, section[entry + 2]!).toLowerCase();
            tracks.push({ pid, language: entryLanguage || language, compositionPageId: (section[entry + 4]! << 8) | section[entry + 5]!, ancillaryPageId: (section[entry + 6]! << 8) | section[entry + 7]! });
          }
        }
        descriptor += 2 + length;
      }
      offset = infoEnd;
    }
    const priorTracks = this.tracks.map((track) => `${track.pid}:${track.language}`).join(",");
    this.tracks = tracks;
    const previousPid = this.selected?.pid;
    this.selected = this.rendererFailed ? undefined : tracks.find((track) => /^(fi|fin)$/.test(track.language))
      ?? (this.rendererFailed ? undefined : tracks.find((track) => /^(en|eng)$/.test(track.language)));
    if (priorTracks !== tracks.map((track) => `${track.pid}:${track.language}`).join(",") || this.selected?.pid !== previousPid) this.onTracksChange?.(this.getTracks());
    if (this.selected?.pid !== previousPid) {
      this.selectionVersion++;
      this.pendingPes = new Uint8Array(0);
      this.queuedPes = [];
      this.queuedBytes = 0;
      this.history.length = 0;
      this.historyBytes = 0;
      if (this.selected) void this.ensureRenderer().catch((error: unknown) => this.handleRendererError(error));
      else this.queueRenderer(async (renderer) => { await renderer.reset(); });
    }
  }

  private pushPes(payload: Uint8Array, payloadStart: boolean, fragmentStart: number): void {
    if (payloadStart) {
      if (this.pendingPes.length >= 6 && this.pendingPes[0] === 0 && this.pendingPes[1] === 0 && this.pendingPes[2] === 1
        && ((this.pendingPes[4]! << 8) | this.pendingPes[5]!) === 0) this.append(this.pendingPes, fragmentStart, this.selectionVersion);
      this.pendingPes = payload.slice();
    } else {
      // A fragment can begin mid-PES. Without the start header there is no safe
      // packet to reconstruct, and retaining every continuation byte makes a
      // malformed subtitle PID quadratically expensive because join copies the
      // whole buffer for every 188-byte TS packet.
      if (!this.pendingPes.length) return;
      if (this.pendingPes.length + payload.length > MAX_PENDING_PES_BYTES) {
        this.pendingPes = new Uint8Array(0);
        return;
      }
      this.pendingPes = join(this.pendingPes, payload);
    }
    this.drainPes(fragmentStart);
    // Dropping an oversized malformed packet is safe because the next PES start
    // resynchronizes, while a valid length-coded DVB PES cannot reach this cap.
    if (this.pendingPes.length > MAX_PENDING_PES_BYTES) this.pendingPes = new Uint8Array(0);
  }

  private drainPes(fragmentStart: number): void {
    while (this.pendingPes.length >= 6) {
      const length = (this.pendingPes[4]! << 8) | this.pendingPes[5]!;
      if (length === 0 || this.pendingPes.length < length + 6) return;
      this.append(this.pendingPes.subarray(0, length + 6), fragmentStart, this.selectionVersion);
      this.pendingPes = this.pendingPes.slice(length + 6);
    }
  }

  private append(pes: Uint8Array, fragmentStart: number, version: number, initPts = this.initPts): void {
    const packet = { data: pes.slice(), start: fragmentStart, cc: this.lastContinuityCounter };
    if (!this.enabled || initPts === undefined || (this.initPtsCc !== undefined && packet.cc !== undefined && packet.cc !== this.initPtsCc)) {
      this.queuedPes.push(packet);
      this.queuedBytes += packet.data.length;
      while (this.queuedBytes > 1_048_576 || this.queuedPes.length > 128) this.queuedBytes -= this.queuedPes.shift()!.data.length;
      return;
    }
    this.history.push(packet);
    this.historyBytes += packet.data.length;
    while (this.historyBytes > 1_048_576 || (this.history.length && fragmentStart - this.history[0]!.start > 120)) this.historyBytes -= this.history.shift()!.data.length;
    if (++this.rebuildCount >= 256) {
      this.rebuildCount = 0;
      const snapshot = this.history.slice();
      this.queueRenderer(async (renderer) => {
        if (this.disposed || version !== this.selectionVersion) return;
        await renderer.reset();
        for (const old of snapshot) {
          if (this.disposed || version !== this.selectionVersion) return;
          const filtered = filterPesPages(old.data, this.selected!);
          if (filtered) await renderer.append(rebasePesPts(filtered, initPts, old.start));
        }
      });
      return;
    }
    this.queueRenderer(async (renderer) => {
      if (this.disposed || !this.selected || version !== this.selectionVersion) return;
      const pageFiltered = filterPesPages(pes, this.selected!);
      if (pageFiltered) await renderer.append(rebasePesPts(pageFiltered, initPts, fragmentStart));
    });
  }

  private queueRenderer(operation: (renderer: Renderer) => Promise<void>): void {
    this.rendererOps = this.rendererOps.then(async () => {
      if (this.disposed) return;
      const renderer = await this.ensureRenderer();
      if (!this.disposed) await operation(renderer);
    }).catch((error: unknown) => this.handleRendererError(error));
  }

  private handleRendererError(error: unknown): void {
    if (this.disposed || this.rendererFailed) return;
    this.rendererFailed = true;
    this.selected = undefined;
    this.onTracksChange?.(this.getTracks());
    this.onRendererError?.(error);
  }

  private async ensureRenderer(): Promise<Renderer> {
    if (this.renderer) return this.renderer;
    if (!this.rendererPromise) this.rendererPromise = (this.createRenderer?.() ?? import("libbitsub").then(({ DvbRenderer }) => {
      const renderer = new DvbRenderer({ video: this.video, cacheLimit: 24 });
      return renderer;
    })).then((renderer) => {
      if (this.disposed) renderer.dispose(); else this.renderer = renderer;
      return renderer;
    });
    return this.rendererPromise;
  }
}

function filterPesPages(pes: Uint8Array, selected: DvbTrack): Uint8Array | undefined {
  // A stream can mark a private PID as DVB while also sending malformed or
  // unrelated PES payloads. Never hand those bytes to the WASM renderer: its
  // parser is intentionally optimized for valid subtitle segments, not input
  // recovery. The TS reader can safely resynchronize at the next PES start.
  if (pes.length < 16 || pes[0] !== 0 || pes[1] !== 0 || pes[2] !== 1 || pes[6] !== 0x80) return undefined;
  const payloadStart = 9 + pes[8]!;
  if (payloadStart + 2 > pes.length || pes[payloadStart] !== 0x20) return undefined;
  const allowedPages = new Set([selected.compositionPageId, selected.ancillaryPageId]);
  const segments: Uint8Array[] = [];
  let offset = payloadStart + 2;
  while (offset + 6 <= pes.length && pes[offset] === 0x0f) {
    const pageId = (pes[offset + 2]! << 8) | pes[offset + 3]!;
    const segmentLength = (pes[offset + 4]! << 8) | pes[offset + 5]!;
    const end = offset + 6 + segmentLength;
    if (end > pes.length) return undefined;
    if (allowedPages.has(pageId)) segments.push(pes.subarray(offset, end));
    offset = end;
  }
  if (!segments.length) return undefined;
  const output = new Uint8Array(payloadStart + 2 + segments.reduce((size, segment) => size + segment.length, 0));
  output.set(pes.subarray(0, payloadStart + 2));
  let target = payloadStart + 2;
  for (const segment of segments) { output.set(segment, target); target += segment.length; }
  const packetLength = output.length - 6;
  output[4] = (packetLength >>> 8) & 0xff;
  output[5] = packetLength & 0xff;
  return output;
}

function join(left: Uint8Array, right: Uint8Array): Uint8Array {
  const result = new Uint8Array(left.length + right.length);
  result.set(left); result.set(right, left.length);
  return result;
}

function rebasePesPts(pes: Uint8Array, initPts: number | undefined, fragmentStart: number): Uint8Array {
  if (pes.length < 14 || pes[0] !== 0 || pes[1] !== 0 || pes[2] !== 1 || initPts === undefined) return pes;
  const flags = pes[7]! >> 6;
  if (flags !== 2 && flags !== 3) return pes;
  const pts = ((pes[9]! & 14) * 0x20000000) + (pes[10]! << 22) + ((pes[11]! & 254) << 14) + (pes[12]! << 7) + ((pes[13]! & 254) >> 1);
  let delta = pts - initPts;
  if (delta > PTS_WRAP / 2) delta -= PTS_WRAP;
  if (delta < -PTS_WRAP / 2) delta += PTS_WRAP;
  const mediaSeconds = Number.isFinite(delta) ? delta / 90_000 : fragmentStart;
  const rebased = Math.round(Math.max(0, mediaSeconds) * 90_000);
  const copy = pes.slice();
  copy[9] = (copy[9]! & 0xf0) | ((rebased >>> 29) & 14) | 1;
  copy[10] = (rebased >>> 22) & 255;
  copy[11] = ((rebased >>> 14) & 254) | 1;
  copy[12] = (rebased >>> 7) & 255;
  copy[13] = ((rebased << 1) & 254) | 1;
  return copy;
}
