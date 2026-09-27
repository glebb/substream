import { DvbSubtitleDecoder } from "../../core/subtitles/dvb-decoder.ts";
import { LiveDvbTsScanner, type ScannedDvbTrack } from "../browser/live-dvb-ts-scanner.ts";
import { TizenLiveDvbOverlay } from "./live-dvb-overlay.ts";

const MAX_RESPONSE_CHARS = 4 * 1024 * 1024;
const MAX_BATCH_BYTES = 192 * 1024;
const MAX_CONNECTION_MS = 60_000;
const TRACK_DISCOVERY_TIMEOUT_MS = 20_000;
const TS_PACKET_BYTES = 188;
const MAX_PES_BYTES = 128 * 1024;

export interface TizenDvbTrack { id: string; label: string; language: string; selected: boolean }

/**
 * Reads the provider's CORS-enabled continuous TS endpoint on Tizen 3, where
 * AVPlay exposes DVB subtitles as no TEXT tracks. Response strings and the
 * per-call packet batches are capped; periodic reconnects avoid unbounded
 * responseText growth on Chromium 47.
 */
export class TizenLiveDvbSubtitleFeed {
  private xhr: XMLHttpRequest | undefined;
  private scanner = new LiveDvbTsScanner();
  private decoder: DvbSubtitleDecoder | undefined;
  private overlay: TizenLiveDvbOverlay | undefined;
  private selected: ScannedDvbTrack | undefined;
  private tracks: ScannedDvbTrack[] = [];
  private byteCarry = new Uint8Array(0);
  private responseCursor = 0;
  private anchorPlayheadSeconds: number | undefined;
  private anchorVideoPts: number | undefined;
  private generation = 0;
  private disposed = false;
  private enabled = true;
  private lastRenderAt = -Infinity;
  private reconnectTimer: number | undefined;
  private connectionTimer: number | undefined;
  private discoveryTimer: number | undefined;
  private consecutiveFailures = 0;
  private status: "pending" | "available" | "unavailable" = "pending";

  constructor(
    private readonly url: string,
    anchor: HTMLElement,
    private readonly getPlayheadSeconds: () => number,
    private readonly onTracks: (tracks: TizenDvbTrack[]) => void,
    private readonly onFailure: () => void = () => undefined,
  ) {
    this.overlay = new TizenLiveDvbOverlay(anchor, onFailure);
  }

  start(): void {
    if (this.disposed || this.xhr) return;
    this.status = "pending";
    this.discoveryTimer = window.setTimeout(() => {
      this.discoveryTimer = undefined;
      if (!this.disposed && this.tracks.length === 0) this.setStatus("unavailable");
    }, TRACK_DISCOVERY_TIMEOUT_MS);
    this.openRequest();
  }
  setTime(_seconds: number): void { this.render(); }
  getStatus(): "pending" | "available" | "unavailable" { return this.status; }
  getTracks(): TizenDvbTrack[] {
    return this.tracks.map((track) => ({ id: `dvb:${track.id}`, language: track.language, label: `${languageLabel(track.language)} · DVB`, selected: this.selected?.id === track.id }));
  }

  select(id: string | undefined): boolean {
    if (this.disposed) return false;
    if (id !== undefined && this.selected && (`dvb:${this.selected.id}` === id || this.selected.id === id)) return true;
    if (id === undefined) {
      if (!this.selected && !this.decoder) return true;
      this.selected = undefined;
      this.decoder?.dispose();
      this.decoder = undefined;
      this.scanner.select("");
      this.overlay?.clear();
      this.emitTracks();
      return true;
    }
    const track = this.tracks.find((candidate) => `dvb:${candidate.id}` === id || candidate.id === id);
    if (!track) return false;
    this.selected = track;
    this.scanner.select(track.id);
    this.decoder?.dispose();
    this.decoder = new DvbSubtitleDecoder({ compositionPageId: track.compositionPageId, ancillaryPageId: track.ancillaryPageId });
    this.anchorPlayheadSeconds = undefined;
    this.anchorVideoPts = undefined;
    this.overlay?.clear();
    this.emitTracks();
    return true;
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    if (!enabled) this.overlay?.clear();
    else this.render();
  }

  setOffsetSeconds(_seconds: number): void { /* Live DVB PTS already follows AVPlay's stream clock. */ }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.generation++;
    if (this.reconnectTimer !== undefined) window.clearTimeout(this.reconnectTimer);
    if (this.connectionTimer !== undefined) window.clearTimeout(this.connectionTimer);
    if (this.discoveryTimer !== undefined) window.clearTimeout(this.discoveryTimer);
    this.reconnectTimer = undefined;
    this.connectionTimer = undefined;
    this.discoveryTimer = undefined;
    this.xhr?.abort();
    this.xhr = undefined;
    this.decoder?.dispose();
    this.decoder = undefined;
    this.overlay?.dispose();
    this.overlay = undefined;
    this.byteCarry = new Uint8Array(0);
  }

  private openRequest(): void {
    if (this.disposed || this.xhr) return;
    const generation = ++this.generation;
    let xhr: XMLHttpRequest;
    try {
      xhr = new XMLHttpRequest();
      this.xhr = xhr;
      this.responseCursor = 0;
      xhr.open("GET", this.url, true);
      xhr.overrideMimeType("text/plain; charset=x-user-defined");
      xhr.onprogress = () => {
        if (this.disposed || generation !== this.generation || this.xhr !== xhr) return;
        try {
          const text = xhr.responseText;
          if (text.length < this.responseCursor) { this.responseCursor = 0; this.byteCarry = new Uint8Array(0); }
          const next = text.length;
          if (next > this.responseCursor) {
            this.consecutiveFailures = 0;
            if (!this.tracks.length && this.status === "unavailable") {
              this.setStatus("pending");
              this.discoveryTimer = window.setTimeout(() => {
                this.discoveryTimer = undefined;
                if (!this.disposed && this.tracks.length === 0) this.setStatus("unavailable");
              }, TRACK_DISCOVERY_TIMEOUT_MS);
            }
            let cursor = this.responseCursor;
            while (cursor < next) {
              const end = Math.min(next, cursor + MAX_BATCH_BYTES);
              this.consumeBinaryText(text, cursor, end);
              cursor = end;
            }
            this.responseCursor = next;
          }
          if (next >= MAX_RESPONSE_CHARS) this.reconnect(generation, xhr);
        } catch { this.fail(generation, xhr); }
      };
      xhr.onerror = () => this.fail(generation, xhr);
      xhr.onabort = () => { if (!this.disposed && generation === this.generation && this.xhr === xhr) this.fail(generation, xhr); };
      xhr.onload = () => this.reconnect(generation, xhr);
      xhr.send();
      this.connectionTimer = window.setTimeout(() => this.reconnect(generation, xhr), MAX_CONNECTION_MS);
    } catch {
      this.fail(generation, this.xhr);
    }
  }

  private consumeBinaryText(text: string, start: number, end: number): void {
    const chunk = new Uint8Array(end - start);
    for (let i = start; i < end; i++) chunk[i - start] = text.charCodeAt(i) & 255;
    let bytes = joinBytes(this.byteCarry, chunk);
    let sync = findTsSync(bytes);
    if (sync < 0) {
      this.byteCarry = bytes.slice(Math.max(0, bytes.length - TS_PACKET_BYTES * 2));
      return;
    }
    if (sync > 0) bytes = bytes.subarray(sync);
    const usable = Math.floor(bytes.length / TS_PACKET_BYTES) * TS_PACKET_BYTES;
    this.byteCarry = bytes.slice(usable);
    if (usable === 0) return;
    const playhead = Math.max(0, Number(this.getPlayheadSeconds()) || 0);
    const packetBytes = bytes.subarray(0, usable);
    const pesPackets = this.scanner.scan(packetBytes, this.anchorPlayheadSeconds ?? playhead);
    const nextTracks = this.scanner.getTracks();
    if (trackSignature(nextTracks) !== trackSignature(this.tracks)) {
      this.tracks = nextTracks;
      if (nextTracks.length) {
        if (this.discoveryTimer !== undefined) window.clearTimeout(this.discoveryTimer);
        this.discoveryTimer = undefined;
        this.setStatus("available");
      }
      if (this.selected) {
        const selected = nextTracks.find((track) => track.id === this.selected?.id);
        if (!selected) this.select(undefined);
        else this.selected = selected;
      }
      this.emitTracks();
    }
    if (this.selected && this.scanner.getSelected()?.id !== this.selected.id) this.scanner.select(this.selected.id);
    const videoPts = this.scanner.getFragmentVideoPts();
    if (this.anchorPlayheadSeconds === undefined && videoPts !== undefined) {
      this.anchorPlayheadSeconds = playhead;
      this.anchorVideoPts = videoPts;
    }
    if (this.decoder && this.selected && this.anchorPlayheadSeconds !== undefined && this.anchorVideoPts !== undefined) {
      for (const pes of pesPackets.slice(0, 16)) {
        const rebased = rebasePesPts(pes, this.anchorPlayheadSeconds, this.anchorVideoPts);
        if (rebased.byteLength <= MAX_PES_BYTES) this.decoder.feed(rebased);
      }
      this.render();
    }
  }

  private render(): void {
    if (!this.enabled || !this.decoder) return;
    const now = Date.now();
    if (now - this.lastRenderAt < 150) return;
    this.lastRenderAt = now;
    const frame = this.decoder.renderFrameDataAtTimestamp(Math.max(0, Number(this.getPlayheadSeconds()) || 0));
    if (frame) this.overlay?.present(frame);
    else this.overlay?.clear();
  }

  private emitTracks(): void { this.onTracks(this.getTracks()); }

  private setStatus(status: "pending" | "available" | "unavailable"): void {
    if (this.status === status) return;
    this.status = status;
    this.emitTracks();
  }

  private reconnect(generation: number, xhr: XMLHttpRequest): void {
    if (this.disposed || generation !== this.generation || this.xhr !== xhr) return;
    this.xhr = undefined;
    if (this.connectionTimer !== undefined) window.clearTimeout(this.connectionTimer);
    this.connectionTimer = undefined;
    xhr.onprogress = xhr.onerror = xhr.onload = xhr.onabort = null;
    try { xhr.abort(); } catch { /* A completed XHR may reject abort(). */ }
    this.byteCarry = new Uint8Array(0);
    this.scanner = new LiveDvbTsScanner();
    if (this.selected) this.scanner.select(this.selected.id);
    this.anchorPlayheadSeconds = undefined;
    this.anchorVideoPts = undefined;
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = undefined;
      this.openRequest();
    }, 250);
  }

  private fail(generation: number, xhr?: XMLHttpRequest): void {
    if (this.disposed || generation !== this.generation) return;
    if (xhr && this.xhr !== xhr) return;
    this.onFailure();
    this.consecutiveFailures++;
    if (this.consecutiveFailures >= 3) this.setStatus("unavailable");
    if (xhr) {
      this.reconnect(generation, xhr);
      if (this.reconnectTimer !== undefined) {
        window.clearTimeout(this.reconnectTimer);
        this.reconnectTimer = window.setTimeout(() => {
          this.reconnectTimer = undefined;
          this.openRequest();
        }, Math.min(5_000, 2_000 * Math.pow(2, Math.min(this.consecutiveFailures - 1, 2))));
      }
    }
  }
}

function findTsSync(bytes: Uint8Array): number {
  const searchEnd = Math.max(0, bytes.length - TS_PACKET_BYTES);
  for (let i = 0; i < searchEnd; i++) if (bytes[i] === 0x47 && (bytes.length < i + TS_PACKET_BYTES * 2 || bytes[i + TS_PACKET_BYTES] === 0x47)) return i;
  return -1;
}

function joinBytes(a: Uint8Array, b: Uint8Array): Uint8Array {
  if (!a.length) return b;
  const out = new Uint8Array(a.length + b.length);
  out.set(a); out.set(b, a.length);
  return out;
}

function trackSignature(tracks: ScannedDvbTrack[]): string { return tracks.map((track) => `${track.id}:${track.language}`).join("|"); }
function languageLabel(language: string): string {
  const labels: Record<string, string> = { fin: "Finnish", fi: "Finnish", swe: "Swedish", dan: "Danish", nor: "Norwegian", eng: "English" };
  return labels[language.toLowerCase()] ?? language.toUpperCase();
}

function rebasePesPts(pes: Uint8Array, anchorSeconds: number, anchorPts: number): Uint8Array {
  if (pes.length < 14 || pes[0] !== 0 || pes[1] !== 0 || pes[2] !== 1) return pes;
  const flags = pes[7]! >> 6;
  if (flags !== 2 && flags !== 3) return pes;
  const pts = ((pes[9]! & 14) * 0x20000000) + (pes[10]! * 0x400000) + ((pes[11]! & 254) * 0x4000) + (pes[12]! * 0x80) + ((pes[13]! & 254) / 2);
  let delta = pts - anchorPts;
  const wrap = 0x200000000;
  if (delta > wrap / 2) delta -= wrap;
  if (delta < -wrap / 2) delta += wrap;
  const value = Math.max(0, Math.round(anchorSeconds * 90_000 + delta)) % 0x200000000;
  const copy = pes.slice();
  copy[9] = (copy[9]! & 0xf0) | (Math.floor(value / 0x20000000) & 14) | 1;
  copy[10] = Math.floor(value / 0x400000) % 256;
  copy[11] = (Math.floor(value / 0x4000) % 256 & 254) | 1;
  copy[12] = Math.floor(value / 0x80) % 256;
  copy[13] = (value % 0x80) * 2 | 1;
  return copy;
}
