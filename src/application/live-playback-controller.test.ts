import type { CancellationSignal } from "../contracts/cancellation.ts";
import { describe, expect, it, vi } from "vitest";
import { LivePlaybackController, PlaybackCleanupError, type RelayServiceState } from "./live-playback-controller.ts";
import { disposeMediaPlayer, PlaybackSessionGuard } from "./playback-lifecycle.ts";
import type { MediaPlayer, MediaPlayerEventHandlers, RelayMediaPlayer } from "../platform/media-player.ts";

function player(relay = false) {
  let handlers: MediaPlayerEventHandlers | null = null;
  const value = {
    setEventHandlers: vi.fn((next: MediaPlayerEventHandlers | null) => { handlers = next; }),
    load: vi.fn(), play: vi.fn(), pause: vi.fn(), restart: vi.fn(), skip: vi.fn(), setDisplayMode: vi.fn(), resize: vi.fn(), destroy: vi.fn(),
    setSubtitle: vi.fn(async () => ({ enabled: false })), setSubtitleEnabled: vi.fn(),
    ...(relay ? { start: vi.fn(async () => {}), close: vi.fn(async () => {}) } : {}),
    emit(state: "playing" | "error") { handlers?.onStateChange(state); },
    emitProgress() { handlers?.onProgress?.({ currentTimeSeconds: 1, durationSeconds: 2 }); },
    emitTracks() { handlers?.onAudioTracksChange?.([]); handlers?.onEmbeddedSubtitleTracksChange?.([]); handlers?.onLiveBufferWindowChange?.(null); },
  } as unknown as MediaPlayer & { emit(state: "playing" | "error"): void; emitProgress(): void; emitTracks(): void; start?: ReturnType<typeof vi.fn>; close?: ReturnType<typeof vi.fn>; load: ReturnType<typeof vi.fn> };
  return value;
}

describe("LivePlaybackController", () => {
  it("opens direct live channels on Chromium 47 without AbortController", async () => {
    vi.stubGlobal("AbortController", undefined);
    try {
      const direct = player();
      const controller = new LivePlaybackController({ directStreamUrl: "fixture://live", createDirect: () => direct, onPlayer: () => {} });
      await controller.start();
      expect(direct.load).toHaveBeenCalledWith("fixture://live");
      await controller.close();
    } finally { vi.unstubAllGlobals(); }
  });

  it("cancels discovery on Chromium 47 without opening a competing player", async () => {
    vi.stubGlobal("AbortController", undefined);
    try {
      const direct = player();
      let signal!: CancellationSignal;
      const controller = new LivePlaybackController({ directStreamUrl: "fixture://live", createDirect: () => direct, onPlayer: () => {},
        prepareRelay: (value) => new Promise<void>((resolve) => { signal = value; value.addEventListener("abort", resolve); }) });
      const pending = controller.start();
      await controller.close(); await pending;
      expect(signal.aborted).toBe(true);
      expect(direct.load).not.toHaveBeenCalled();
    } finally { vi.unstubAllGlobals(); }
  });

  it("finishes discovery before opening relay or direct playback", async () => {
    let finish!: () => void;
    const direct = player();
    const createRelay = vi.fn(() => null);
    const controller = new LivePlaybackController({ directStreamUrl: "fixture://stream", createDirect: () => direct,
      createRelay, onPlayer: () => {}, prepareRelay: () => new Promise<void>((resolve) => { finish = resolve; }) });
    const start = controller.start();
    expect(createRelay).not.toHaveBeenCalled(); expect(direct.load).not.toHaveBeenCalled();
    finish(); await start;
    expect(createRelay).toHaveBeenCalledOnce(); expect(direct.load).toHaveBeenCalledOnce();
    await controller.close();
  });

  it("cancels discovery on exit and never opens an obsolete player", async () => {
    const direct = player();
    let signal!: CancellationSignal;
    const controller = new LivePlaybackController({ directStreamUrl: "fixture://stream", createDirect: () => direct, onPlayer: () => {},
      prepareRelay: (value) => new Promise<void>((resolve) => { signal = value; value.addEventListener("abort", () => resolve()); }) });
    const start = controller.start();
    await controller.close(); await start;
    expect(signal.aborted).toBe(true); expect(direct.load).not.toHaveBeenCalled();
  });

  it("falls back only after relay cleanup and starts the direct stream once", async () => {
    const hosted = player(true) as RelayMediaPlayer & ReturnType<typeof player>;
    const direct = player();
    const states: RelayServiceState[] = [];
    const controller = new LivePlaybackController({
      directStreamUrl: "https://fixture.invalid/live.m3u8",
      createRelay: () => hosted,
      createDirect: () => direct,
      onPlayer: () => {}, onRelayState: (state) => states.push(state),
    });
    await controller.start();
    hosted.start.mockRejectedValueOnce(new Error("synthetic startup failure"));
    // The first start above succeeded; simulate a later relay failure instead.
    hosted.emit("error");
    await vi.waitFor(() => expect(direct.load).toHaveBeenCalledWith("https://fixture.invalid/live.m3u8"));
    expect(hosted.close).toHaveBeenCalledTimes(1);
    expect(states).toContain("unavailable");
  });

  it("does not open a second stream when relay release cannot be confirmed", async () => {
    const hosted = player(true) as RelayMediaPlayer & ReturnType<typeof player>;
    hosted.close.mockImplementation(() => new Promise(() => {}));
    const direct = player();
    const states: RelayServiceState[] = [];
    const controller = new LivePlaybackController({
      directStreamUrl: "https://fixture.invalid/live.m3u8", cleanupTimeoutMs: 1_000,
      createRelay: () => hosted, createDirect: () => direct,
      onPlayer: () => {}, onRelayState: (state) => states.push(state),
    });
    await controller.start();
    hosted.emit("error");
    await vi.waitFor(() => expect(states).toContain("cleanup-blocked"), { timeout: 1_500 });
    expect(direct.load).not.toHaveBeenCalled();
  });

  it("uses a direct player when relay support is absent", async () => {
    const direct = player();
    const controller = new LivePlaybackController({ directStreamUrl: "fixture://stream", createDirect: () => direct, onPlayer: () => {} });
    await controller.start();
    expect(direct.load).toHaveBeenCalledWith("fixture://stream");
  });

  it("falls back when the relay emits an error during start even if start resolves", async () => {
    const hosted = player(true) as RelayMediaPlayer & ReturnType<typeof player>;
    hosted.start.mockImplementation(async () => { hosted.emit("error"); });
    const direct = player();
    const controller = new LivePlaybackController({
      directStreamUrl: "fixture://stream", createRelay: () => hosted,
      createDirect: () => direct, onPlayer: () => {},
    });
    await controller.start();
    await vi.waitFor(() => expect(direct.load).toHaveBeenCalledWith("fixture://stream"));
    expect(hosted.close).toHaveBeenCalledTimes(1);
  });

  it("ignores late player events after the session closes", async () => {
    const direct = player();
    const states: string[] = [];
    const delivered: string[] = [];
    const controller = new LivePlaybackController({ directStreamUrl: "fixture://stream", createDirect: () => direct, onPlayer: () => {}, onState: (state) => states.push(state), onPlayerEvents: () => ({ onProgress: () => delivered.push("progress"), onAudioTracksChange: () => delivered.push("audio"), onEmbeddedSubtitleTracksChange: () => delivered.push("subtitles"), onLiveBufferWindowChange: () => delivered.push("buffer") }) });
    await controller.start();
    await controller.close();
    direct.emit("playing");
    direct.emitProgress();
    direct.emitTracks();
    expect(states).toEqual([]);
    expect(delivered).toEqual([]);
  });

  it("bounds close while relay startup is still pending and reuses the same close promise", async () => {
    const hosted = player(true) as RelayMediaPlayer & ReturnType<typeof player>;
    hosted.start.mockImplementation(() => new Promise(() => {}));
    const controller = new LivePlaybackController({ directStreamUrl: "fixture://stream", createRelay: () => hosted, createDirect: () => player(), onPlayer: () => {}, cleanupTimeoutMs: 1_000 });
    void controller.start();
    const firstClose = controller.close();
    expect(controller.close()).toBe(firstClose);
    await firstClose;
    expect(hosted.close).toHaveBeenCalledTimes(1);
  });

  it("does not report a retry ready when it emits an error during startup", async () => {
    const initial = player(true) as RelayMediaPlayer & ReturnType<typeof player>;
    const retry = player(true) as RelayMediaPlayer & ReturnType<typeof player>;
    retry.start.mockImplementation(async () => { retry.emit("error"); });
    const direct = player();
    const relays = [initial, retry];
    const states: RelayServiceState[] = [];
    const controller = new LivePlaybackController({ directStreamUrl: "fixture://stream", createRelay: () => relays.shift() ?? null, createDirect: () => direct, onPlayer: () => {}, onRelayState: (state) => states.push(state), maxReconnects: 1 });
    await controller.start();
    initial.emit("playing");
    initial.emit("error");
    await vi.waitFor(() => expect(direct.load).toHaveBeenCalledWith("fixture://stream"));
    expect(states.filter((state) => state === "ready")).toHaveLength(1);
  });

  it("rejects failed cleanup and allows an explicit cleanup retry", async () => {
    const hosted = player(true) as RelayMediaPlayer & ReturnType<typeof player>;
    hosted.close.mockRejectedValueOnce(new Error("synthetic release failure"));
    const controller = new LivePlaybackController({ directStreamUrl: "fixture://stream", createRelay: () => hosted, createDirect: () => player(), onPlayer: () => {} });
    await controller.start();
    await expect(controller.close()).rejects.toBeInstanceOf(PlaybackCleanupError);
    await controller.retryCleanup();
    expect(hosted.close).toHaveBeenCalledTimes(2);
  });

  it("guards VOD callbacks and makes player disposal idempotent", async () => {
    const guard = new PlaybackSessionGuard();
    const first = guard.next();
    const second = guard.next();
    expect(guard.isCurrent(first)).toBe(false);
    expect(guard.isCurrent(second)).toBe(true);
    guard.close();
    expect(guard.isCurrent(second)).toBe(false);

    const direct = player();
    const firstDisposal = disposeMediaPlayer(direct);
    const secondDisposal = disposeMediaPlayer(direct);
    expect(secondDisposal).toBe(firstDisposal);
    await Promise.all([firstDisposal, secondDisposal]);
    expect(direct.destroy).toHaveBeenCalledTimes(1);
  });

  it("clears the direct native disposal timeout after release resolves", async () => {
    vi.useFakeTimers();
    const direct = player();
    direct.dispose = vi.fn(async () => {});
    const controller = new LivePlaybackController({ directStreamUrl: "fixture://stream", createDirect: () => direct, onPlayer: () => {} });
    await controller.start();
    await controller.close();
    expect(vi.getTimerCount()).toBe(0);
    vi.useRealTimers();
  });
});
