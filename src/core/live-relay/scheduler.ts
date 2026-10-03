import type { RelayCue, RelayCueBatch } from "./protocol.ts";

/** A measured relationship; the caller must establish it from media playback. */
export interface RelayPlaybackAnchor {
  epoch: number;
  mediaMs: number;
  playheadMs: number;
}

/** Schedules only from a supplied playback anchor, never network arrival time. */
export class RelayCueScheduler {
  private anchor: RelayPlaybackAnchor | undefined;
  private cues: RelayCue[] = [];
  private enabled = true;
  private cursor = 0;

  setAnchor(anchor: RelayPlaybackAnchor): void {
    if (!Number.isSafeInteger(anchor.epoch) || anchor.epoch < 1
      || !Number.isFinite(anchor.mediaMs) || !Number.isFinite(anchor.playheadMs)) throw new Error("Invalid relay playback anchor");
    this.anchor = { ...anchor };
    this.cues = this.cues.filter((cue) => cue.epoch === anchor.epoch);
  }

  accept(batch: RelayCueBatch): void {
    if (batch.reset) this.cues = batch.active ? [batch.active] : [];
    const incoming = batch.cues.filter((cue) => batch.reset || cue.seq > this.cursor);
    for (const cue of incoming) {
      if (this.anchor && cue.epoch > this.anchor.epoch) {
        this.anchor = undefined;
        this.cues = [];
      }
      if (!this.anchor || cue.epoch === this.anchor.epoch) this.cues.push(cue);
    }
    this.cursor = batch.nextCursor;
    this.cues.sort((a, b) => a.startMs - b.startMs || a.seq - b.seq);
    if (this.cues.length > 256) this.cues.splice(0, this.cues.length - 256);
  }

  setEnabled(enabled: boolean): void { this.enabled = enabled; }

  current(playheadMs: number): RelayCue | null {
    if (!this.enabled || !this.anchor || !Number.isFinite(playheadMs)) return null;
    const mediaMs = this.anchor.mediaMs + playheadMs - this.anchor.playheadMs;
    let current: RelayCue | undefined;
    for (const cue of this.cues) {
      if (cue.epoch === this.anchor.epoch && cue.startMs <= mediaMs) current = cue;
    }
    if (!current || current.clear || (current.endMs !== undefined && current.endMs <= mediaMs)) return null;
    return current;
  }

  reset(): void { this.anchor = undefined; this.cues = []; this.cursor = 0; }
}
