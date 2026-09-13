import { afterEach, describe, expect, it, vi } from "vitest";
import { TizenAvPlayPlayer, isTizenAvPlayAvailable } from "./avplay-player.ts";

const originalWebapis = (globalThis as typeof globalThis & { webapis?: unknown }).webapis;
const originalTizen = (globalThis as typeof globalThis & { tizen?: unknown }).tizen;

afterEach(() => {
  if (originalWebapis === undefined) delete (globalThis as typeof globalThis & { webapis?: unknown }).webapis;
  else (globalThis as typeof globalThis & { webapis?: unknown }).webapis = originalWebapis;
  if (originalTizen === undefined) delete (globalThis as typeof globalThis & { tizen?: unknown }).tizen;
  else (globalThis as typeof globalThis & { tizen?: unknown }).tizen = originalTizen;
});

describe("TizenAvPlayPlayer", () => {
  it("opens, positions, starts, and attaches a temporary SAMI subtitle", async () => {
    const open = vi.fn();
    const prepareAsync = vi.fn((success: () => void) => success());
    const play = vi.fn();
    const pause = vi.fn();
    const jumpForward = vi.fn((_milliseconds: number, onSuccess?: () => void) => onSuccess?.());
    const jumpBackward = vi.fn((_milliseconds: number, onSuccess?: () => void) => onSuccess?.());
    const stop = vi.fn();
    const close = vi.fn();
    const setDisplayRect = vi.fn();
    const setDisplayMethod = vi.fn();
    const setBufferingParam = vi.fn();
    const seekTo = vi.fn((milliseconds: number, onSuccess?: () => void) => onSuccess?.());
    const getCurrentStreamInfo = vi.fn(() => [{ type: "VIDEO", extra_info: "{\"Width\":\"1920\",\"Height\":\"1080\"}" }]);
    let listener: {
      oncurrentplaytime?(milliseconds: number): void;
      onbufferingstart?(): void;
      onbufferingcomplete?(): void;
      onstreamcompleted?(): void;
    } | undefined;
    const setListener = vi.fn((nextListener: NonNullable<typeof listener>) => { listener = nextListener; });
    const getDuration = vi.fn(() => 125_000);
    (globalThis as typeof globalThis & { webapis?: unknown }).webapis = { avplay: { open, prepareAsync, play, pause, jumpForward, jumpBackward, stop, close, getDuration, setDisplayRect, setDisplayMethod, setBufferingParam, setListener, seekTo, getCurrentStreamInfo } };
    const container = { getBoundingClientRect: () => ({ left: 10.2, top: 20.7, width: 1280, height: 720 }) } as unknown as HTMLElement;

    const onSubtitleCue = vi.fn();
    const progress: Array<{ currentTimeSeconds: number; durationSeconds: number }> = [];
    const player = new TizenAvPlayPlayer(container, onSubtitleCue);
    const states: string[] = [];
    player.setEventHandlers({ onStateChange: (state) => states.push(state), onProgress: (value) => progress.push(value) });
    expect(isTizenAvPlayAvailable()).toBe(true);
    player.load("https://example.invalid/stream.mkv");
    player.seekTo(84);
    expect(seekTo).toHaveBeenCalledWith(84_000, expect.any(Function), expect.any(Function));
    expect(player.getVideoResolution()).toBe("1920 × 1080");
    player.pause();
    player.play();
    player.restart();
    player.resize();
    player.setDisplayMode("fit");
    player.skip(60);
    player.skip(-60);
    player.skip(Number.NaN);
    player.skip(Number.POSITIVE_INFINITY);
    expect(open).toHaveBeenCalledWith("https://example.invalid/stream.mkv");
    expect(setBufferingParam).toHaveBeenNthCalledWith(1, "PLAYER_BUFFER_FOR_PLAY", "PLAYER_BUFFER_SIZE_IN_SECOND", 5);
    expect(setBufferingParam).toHaveBeenNthCalledWith(2, "PLAYER_BUFFER_FOR_RESUME", "PLAYER_BUFFER_SIZE_IN_SECOND", 15);
    expect(open.mock.invocationCallOrder[0]).toBeLessThan(setBufferingParam.mock.invocationCallOrder[0]!);
    expect(setBufferingParam.mock.invocationCallOrder[1]).toBeLessThan(prepareAsync.mock.invocationCallOrder[0]!);
    expect(setDisplayRect).toHaveBeenCalledWith(10, 21, 1280, 720);
    expect(setDisplayMethod).toHaveBeenNthCalledWith(1, "PLAYER_DISPLAY_MODE_AUTO_ASPECT_RATIO");
    expect(setDisplayMethod).toHaveBeenLastCalledWith("PLAYER_DISPLAY_MODE_LETTER_BOX");
    expect(play).toHaveBeenCalledTimes(3);
    expect(pause).toHaveBeenCalledOnce();
    expect(jumpForward).toHaveBeenCalledWith(60_000, expect.any(Function), expect.any(Function));
    expect(jumpBackward).toHaveBeenCalledWith(60_000, expect.any(Function), expect.any(Function));
    expect(jumpForward).toHaveBeenCalledTimes(1);
    expect(jumpBackward).toHaveBeenCalledTimes(1);
    await expect(player.setSubtitle("1\n00:00:01,000 --> 00:00:02,000\nHello", "English", "en")).resolves.toEqual({ enabled: true });
    listener?.oncurrentplaytime?.(1_500);
    listener?.oncurrentplaytime?.(2_500);
    listener?.onbufferingstart?.();
    listener?.onbufferingcomplete?.();
    listener?.onstreamcompleted?.();
    expect(onSubtitleCue).toHaveBeenCalledWith("Hello");
    expect(onSubtitleCue).toHaveBeenLastCalledWith("");
    expect(progress).toEqual([
      { currentTimeSeconds: 1.5, durationSeconds: 125 },
      { currentTimeSeconds: 2.5, durationSeconds: 125 },
    ]);
    expect(play).toHaveBeenCalledTimes(3);
    expect(states).toContain("loading");
    expect(states).toContain("buffering");
    expect(states).toContain("playing");
    expect(states).toContain("paused");
    expect(states).toContain("ended");
    player.destroy();
    expect(stop).toHaveBeenCalledTimes(2);
    expect(close).toHaveBeenCalledOnce();
  });

  it("ignores prepare callbacks from a replaced stream", () => {
    const prepareCallbacks: Array<{ success: () => void; error: (error: unknown) => void }> = [];
    const play = vi.fn();
    const playerApi = {
      open: vi.fn(),
      prepareAsync: vi.fn((success: () => void, error: (error: unknown) => void) => prepareCallbacks.push({ success, error })),
      play,
      pause: vi.fn(),
      jumpForward: vi.fn(),
      jumpBackward: vi.fn(),
      stop: vi.fn(),
      close: vi.fn(),
      setDisplayRect: vi.fn(),
      setDisplayMethod: vi.fn(),
    };
    (globalThis as typeof globalThis & { webapis?: unknown }).webapis = { avplay: playerApi };
    const container = { getBoundingClientRect: () => ({ left: 0, top: 0, width: 100, height: 100 }) } as unknown as HTMLElement;
    const onPlaybackError = vi.fn();
    const onSubtitleCue = vi.fn();
    const player = new TizenAvPlayPlayer(container, onSubtitleCue);
    const states: string[] = [];
    player.setEventHandlers({ onStateChange: (state) => states.push(state) });

    player.load("https://example.invalid/first.mkv");
    player.load("https://example.invalid/second.mkv");
    prepareCallbacks[0]?.success();
    prepareCallbacks[0]?.error(new Error("stale"));
    expect(play).not.toHaveBeenCalled();
    expect(onPlaybackError).not.toHaveBeenCalled();

    prepareCallbacks[1]?.success();
    expect(play).toHaveBeenCalledOnce();
    expect(states).toContain("playing");
    player.destroy();
  });

  it("serializes and coalesces rapid skips, then recovers from a seek error", () => {
    const jumps: Array<{
      direction: "forward" | "backward";
      milliseconds: number;
      success: (() => void) | undefined;
      error: ((reason: unknown) => void) | undefined;
    }> = [];
    const playerApi = {
      open: vi.fn(),
      prepareAsync: vi.fn((success: () => void) => success()),
      play: vi.fn(),
      pause: vi.fn(),
      jumpForward: vi.fn((milliseconds: number, success?: () => void, error?: (reason: unknown) => void) => {
        jumps.push({ direction: "forward", milliseconds, success, error });
      }),
      jumpBackward: vi.fn((milliseconds: number, success?: () => void, error?: (reason: unknown) => void) => {
        jumps.push({ direction: "backward", milliseconds, success, error });
      }),
      stop: vi.fn(), close: vi.fn(), setDisplayRect: vi.fn(), setDisplayMethod: vi.fn(),
    };
    (globalThis as typeof globalThis & { webapis?: unknown }).webapis = { avplay: playerApi };
    const container = { getBoundingClientRect: () => ({ left: 0, top: 0, width: 100, height: 100 }) } as unknown as HTMLElement;
    const states: string[] = [];
    const player = new TizenAvPlayPlayer(container, vi.fn());
    player.setEventHandlers({ onStateChange: (state) => states.push(state) });

    player.load("https://example.invalid/stream.mkv");
    player.skip(10);
    player.skip(20);
    player.skip(-5);
    expect(jumps).toHaveLength(1);
    expect(jumps[0]).toMatchObject({ direction: "forward", milliseconds: 10_000 });

    jumps[0]?.success?.();
    expect(jumps).toHaveLength(2);
    expect(jumps[1]).toMatchObject({ direction: "forward", milliseconds: 15_000 });

    player.skip(-3);
    expect(jumps).toHaveLength(2);
    jumps[1]?.error?.(new Error("seek rejected"));
    expect(jumps).toHaveLength(3);
    expect(jumps[2]).toMatchObject({ direction: "backward", milliseconds: 3_000 });
    expect(states).not.toContain("error");

    jumps[2]?.success?.();
    player.skip(2);
    expect(jumps).toHaveLength(4);
    expect(jumps[3]).toMatchObject({ direction: "forward", milliseconds: 2_000 });
    player.destroy();
  });

  it("discards queued skips when the stream is destroyed", () => {
    const jumps: Array<{ success: (() => void) | undefined }> = [];
    const playerApi = {
      open: vi.fn(), prepareAsync: vi.fn((success: () => void) => success()),
      play: vi.fn(), pause: vi.fn(),
      jumpForward: vi.fn((_milliseconds: number, success?: () => void) => jumps.push({ success })),
      jumpBackward: vi.fn((_milliseconds: number, success?: () => void) => jumps.push({ success })),
      stop: vi.fn(), close: vi.fn(), setDisplayRect: vi.fn(), setDisplayMethod: vi.fn(),
    };
    (globalThis as typeof globalThis & { webapis?: unknown }).webapis = { avplay: playerApi };
    const container = { getBoundingClientRect: () => ({ left: 0, top: 0, width: 100, height: 100 }) } as unknown as HTMLElement;
    const player = new TizenAvPlayPlayer(container, vi.fn());
    player.load("https://example.invalid/stream.mkv");
    player.skip(10);
    player.skip(20);
    player.destroy();
    jumps[0]?.success?.();
    expect(jumps).toHaveLength(1);
  });

  it("shifts app-rendered cue windows for signed subtitle offsets and updates immediately", async () => {
    let listener: { oncurrentplaytime?(milliseconds: number): void } | undefined;
    const playerApi = {
      open: vi.fn(), prepareAsync: vi.fn((success: () => void) => success()), play: vi.fn(), pause: vi.fn(),
      jumpForward: vi.fn(), jumpBackward: vi.fn(), stop: vi.fn(), close: vi.fn(),
      setDisplayRect: vi.fn(), setDisplayMethod: vi.fn(),
      setListener: vi.fn((next: NonNullable<typeof listener>) => { listener = next; }),
    };
    (globalThis as typeof globalThis & { webapis?: unknown }).webapis = { avplay: playerApi };
    const container = { getBoundingClientRect: () => ({ left: 0, top: 0, width: 100, height: 100 }) } as unknown as HTMLElement;
    const onSubtitleCue = vi.fn();
    const player = new TizenAvPlayPlayer(container, onSubtitleCue);
    player.load("https://example.invalid/stream.mkv");
    player.setSubtitleTimingOffset(1);
    listener?.oncurrentplaytime?.(1_500);
    await player.setSubtitle("1\n00:00:01,000 --> 00:00:02,000\nHello", "English", "en");

    expect(onSubtitleCue).toHaveBeenLastCalledWith("");
    listener?.oncurrentplaytime?.(2_500);
    expect(onSubtitleCue).toHaveBeenLastCalledWith("Hello");
    player.setSubtitleEnabled(false);
    expect(onSubtitleCue).toHaveBeenLastCalledWith("");
    listener?.oncurrentplaytime?.(2_750);
    expect(onSubtitleCue).toHaveBeenLastCalledWith("");
    player.setSubtitleEnabled(true);
    expect(onSubtitleCue).toHaveBeenLastCalledWith("Hello");
    player.setSubtitleTimingOffset(-0.5);
    expect(onSubtitleCue).toHaveBeenLastCalledWith("");
    listener?.oncurrentplaytime?.(750);
    expect(onSubtitleCue).toHaveBeenLastCalledWith("Hello");
    player.destroy();
  });

  it("reports synchronous open and prepare failures instead of throwing", () => {
    const container = { getBoundingClientRect: () => ({ left: 0, top: 0, width: 100, height: 100 }) } as unknown as HTMLElement;
    const states: string[] = [];
    const failedOpen = new TizenAvPlayPlayer(container, vi.fn());
    failedOpen.setEventHandlers({ onStateChange: (state) => states.push(state) });
    (globalThis as typeof globalThis & { webapis?: unknown }).webapis = { avplay: {
      open: vi.fn(() => { throw new Error("private signed URL"); }),
      prepareAsync: vi.fn(), play: vi.fn(), pause: vi.fn(), jumpForward: vi.fn(), jumpBackward: vi.fn(),
      stop: vi.fn(), close: vi.fn(), setDisplayRect: vi.fn(), setDisplayMethod: vi.fn(),
    } };
    expect(() => failedOpen.load("https://private.example/signed" )).not.toThrow();
    expect(states).toEqual(["loading", "error"]);

    const close = vi.fn();
    const failedPrepare = new TizenAvPlayPlayer(container, vi.fn());
    const prepareStates: string[] = [];
    failedPrepare.setEventHandlers({ onStateChange: (state) => prepareStates.push(state) });
    (globalThis as typeof globalThis & { webapis?: unknown }).webapis = { avplay: {
      open: vi.fn(), prepareAsync: vi.fn(() => { throw new Error("prepare failed"); }), play: vi.fn(), pause: vi.fn(),
      jumpForward: vi.fn(), jumpBackward: vi.fn(), stop: vi.fn(), close, setDisplayRect: vi.fn(), setDisplayMethod: vi.fn(),
    } };
    expect(() => failedPrepare.load("https://private.example/signed")).not.toThrow();
    expect(prepareStates).toEqual(["loading", "error"]);
    expect(close).toHaveBeenCalledOnce();
  });

  it("continues playback when AVPlay does not support buffer tuning", () => {
    const prepareAsync = vi.fn((success: () => void) => success());
    const play = vi.fn();
    (globalThis as typeof globalThis & { webapis?: unknown }).webapis = { avplay: {
      open: vi.fn(), prepareAsync, play, pause: vi.fn(), jumpForward: vi.fn(), jumpBackward: vi.fn(),
      stop: vi.fn(), close: vi.fn(), setDisplayRect: vi.fn(), setDisplayMethod: vi.fn(),
      setBufferingParam: vi.fn(() => { throw new Error("unsupported"); }),
    } };
    const container = { getBoundingClientRect: () => ({ left: 0, top: 0, width: 100, height: 100 }) } as unknown as HTMLElement;
    const states: string[] = [];
    const player = new TizenAvPlayPlayer(container, vi.fn());
    player.setEventHandlers({ onStateChange: (state) => states.push(state) });

    expect(() => player.load("https://example.invalid/stream.mkv")).not.toThrow();
    expect(prepareAsync).toHaveBeenCalledOnce();
    expect(play).toHaveBeenCalledOnce();
    expect(states).toContain("playing");
    expect(states).not.toContain("error");
    player.destroy();
  });

});
