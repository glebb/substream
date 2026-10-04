import { describe, expect, it, vi } from "vitest";
import { PlaybackReleaseBarrier } from "./playback-release-barrier.ts";
import { disposeMediaPlayer } from "./playback-lifecycle.ts";
import type { MediaPlayer } from "../platform/media-player.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

describe("PlaybackReleaseBarrier", () => {
  it("starts native cleanup synchronously and gates a replacement route until release", async () => {
    const barrier = new PlaybackReleaseBarrier();
    const cleanup = deferred<void>();
    const close = vi.fn(() => cleanup.promise);
    const release = barrier.release(close);
    expect(close).toHaveBeenCalledTimes(1);
    let replacementStarted = false;
    const replacement = barrier.waitForRelease().then(() => { replacementStarted = true; });
    await Promise.resolve();
    expect(replacementStarted).toBe(false);
    cleanup.resolve();
    await Promise.all([release, replacement]);
    expect(replacementStarted).toBe(true);
  });

  it("retains failed cleanup across routes until explicit retry succeeds", async () => {
    const barrier = new PlaybackReleaseBarrier();
    const close = vi.fn().mockRejectedValueOnce(new Error("native release failed"));
    const retryClose = vi.fn().mockResolvedValue(undefined);
    await expect(barrier.release(close, retryClose)).rejects.toThrow("native release failed");
    await expect(barrier.waitForRelease()).rejects.toThrow("native release failed");
    await barrier.retryRelease();
    await barrier.waitForRelease();
    expect(retryClose).toHaveBeenCalledTimes(1);
  });

  it("coalesces concurrent retries and orders independent cleanup jobs", async () => {
    const barrier = new PlaybackReleaseBarrier();
    const order: string[] = [];
    const firstRetry = deferred<void>();
    await expect(barrier.release(async () => { throw new Error("first failed"); }, async () => { order.push("first"); await firstRetry.promise; })).rejects.toThrow();
    await expect(barrier.release(async () => { throw new Error("second failed"); }, async () => { order.push("second"); })).rejects.toThrow();
    const retryA = barrier.retryRelease();
    const retryB = barrier.retryRelease();
    expect(retryB).toBe(retryA);
    await Promise.resolve();
    expect(order).toEqual(["first"]);
    firstRetry.resolve();
    await Promise.all([retryA, retryB]);
    expect(order).toEqual(["first", "second"]);
    await barrier.waitForRelease();
  });
});

describe("disposeMediaPlayer", () => {
  it("converts synchronous adapter failures into a rejected promise", async () => {
    const player = { setEventHandlers: vi.fn(), destroy() { throw new Error("sync dispose failure"); } } as unknown as MediaPlayer;
    await expect(disposeMediaPlayer(player)).rejects.toThrow("sync dispose failure");
  });

  it("bounds hanging disposal and clears its timer after successful disposal", async () => {
    const hanging = { setEventHandlers: vi.fn(), dispose: vi.fn(() => new Promise<void>(() => {})), destroy: vi.fn() } as unknown as MediaPlayer;
    await expect(disposeMediaPlayer(hanging, 5)).rejects.toThrow("cleanup timed out");
    vi.useFakeTimers();
    const released = { setEventHandlers: vi.fn(), dispose: vi.fn(async () => {}), destroy: vi.fn() } as unknown as MediaPlayer;
    await disposeMediaPlayer(released, 5);
    expect(vi.getTimerCount()).toBe(0);
    vi.useRealTimers();
  });

  it("retries disposal after the previous bounded attempt rejects", async () => {
    const player = { setEventHandlers: vi.fn(), dispose: vi.fn().mockRejectedValueOnce(new Error("first release failed")).mockResolvedValueOnce(undefined), destroy: vi.fn() } as unknown as MediaPlayer;
    await expect(disposeMediaPlayer(player)).rejects.toThrow("first release failed");
    await disposeMediaPlayer(player);
    expect(player.dispose).toHaveBeenCalledTimes(2);
  });
});
