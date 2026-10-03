import { describe, expect, it } from "vitest";
import { RelayCueScheduler } from "./scheduler.ts";
import type { RelayCue } from "./protocol.ts";

const cue = (seq: number, startMs: number, patch: Partial<RelayCue> = {}): RelayCue => ({
  seq, epoch: 1, trackId: "fi", startMs, endMs: startMs + 1000, clear: false,
  imageId: "image", screenWidth: 720, screenHeight: 576, x: 0, y: 0, width: 20, height: 10, ...patch,
});

describe("relay subtitle scheduling", () => {
  it("waits for an explicit anchor and schedules from playhead rather than packet arrival", () => {
    const scheduler = new RelayCueScheduler();
    scheduler.accept({ cues: [cue(1, 10000)], nextCursor: 1, reset: false });
    expect(scheduler.current(10000)).toBeNull();
    scheduler.setAnchor({ epoch: 1, mediaMs: 9000, playheadMs: 2000 });
    expect(scheduler.current(2999)).toBeNull();
    expect(scheduler.current(3000)?.seq).toBe(1);
    expect(scheduler.current(3000)?.seq).toBe(1); // buffering leaves playhead frozen
    expect(scheduler.current(4000)).toBeNull();
  });
  it("deduplicates replay, handles clears and toggles, and invalidates a discontinuity anchor", () => {
    const scheduler = new RelayCueScheduler();
    scheduler.setAnchor({ epoch: 1, mediaMs: 0, playheadMs: 0 });
    scheduler.accept({ cues: [cue(1, 1000), cue(2, 1500, { clear: true })], nextCursor: 2, reset: false });
    scheduler.accept({ cues: [cue(1, 1000)], nextCursor: 2, reset: false });
    expect(scheduler.current(1200)?.seq).toBe(1);
    scheduler.setEnabled(false); expect(scheduler.current(1200)).toBeNull();
    scheduler.setEnabled(true); expect(scheduler.current(1200)?.seq).toBe(1);
    expect(scheduler.current(1500)).toBeNull();
    scheduler.accept({ cues: [cue(3, 1000, { epoch: 2 })], nextCursor: 3, reset: false });
    expect(scheduler.current(1200)).toBeNull();
    scheduler.setAnchor({ epoch: 2, mediaMs: 0, playheadMs: 0 });
    expect(scheduler.current(1200)?.seq).toBe(3);
    scheduler.reset(); expect(scheduler.current(1200)).toBeNull();
  });
  it("replaces stale retained state after a cursor gap", () => {
    const scheduler = new RelayCueScheduler();
    scheduler.setAnchor({ epoch: 1, mediaMs: 0, playheadMs: 0 });
    scheduler.accept({ cues: [cue(1, 1000, { endMs: 10000 })], nextCursor: 1, reset: false });
    scheduler.accept({ cues: [], active: null, reset: true, nextCursor: 30 });
    expect(scheduler.current(2000)).toBeNull();
  });
});
