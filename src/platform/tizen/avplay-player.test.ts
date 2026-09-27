import { afterEach, describe, expect, it, vi } from "vitest";
import { TizenAvPlayPlayer, isTizenAvPlayAvailable } from "./avplay-player.ts";

const originalWebapis = (globalThis as typeof globalThis & { webapis?: unknown }).webapis;
const originalTizen = (globalThis as typeof globalThis & { tizen?: unknown }).tizen;
const originalXhr = globalThis.XMLHttpRequest;

afterEach(() => {
  if (originalWebapis === undefined) delete (globalThis as typeof globalThis & { webapis?: unknown }).webapis;
  else (globalThis as typeof globalThis & { webapis?: unknown }).webapis = originalWebapis;
  if (originalTizen === undefined) delete (globalThis as typeof globalThis & { tizen?: unknown }).tizen;
  else (globalThis as typeof globalThis & { tizen?: unknown }).tizen = originalTizen;
  globalThis.XMLHttpRequest = originalXhr;
});

describe("TizenAvPlayPlayer", () => {
  it("leaves direct-TS DVB discovery stopped after prepare until explicit opt-in", () => {
    (globalThis as typeof globalThis & { webapis?: unknown }).webapis = { avplay: {
      open: vi.fn(), prepareAsync: vi.fn((success: () => void) => success()), play: vi.fn(), pause: vi.fn(),
      jumpForward: vi.fn(), jumpBackward: vi.fn(), stop: vi.fn(), close: vi.fn(),
      setDisplayRect: vi.fn(), setDisplayMethod: vi.fn(), setSilentSubtitle: vi.fn(),
      getTotalTrackInfo: vi.fn(() => [{ type: "AUDIO", index: 0 }, { type: "VIDEO", index: 1 }]),
      getCurrentStreamInfo: vi.fn(() => []),
    } };
    const container = { getBoundingClientRect: () => ({ left: 0, top: 0, width: 100, height: 100 }) } as unknown as HTMLElement;
    const player = new TizenAvPlayPlayer(container, vi.fn());
    player.setLiveSubtitleMode(true);
    player.setLiveDvbSubtitleUrl("https://example.invalid/live.ts");
    player.load("https://example.invalid/live.m3u8");
    expect(player.getLiveDvbSubtitleStatus()).toBe("DVB subtitle scan not started");
    player.destroy();
  });

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
    expect(setBufferingParam).toHaveBeenNthCalledWith(2, "PLAYER_BUFFER_FOR_RESUME", "PLAYER_BUFFER_SIZE_IN_SECOND", 5);
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

  it("lists AVPlay audio tracks and switches by its provider index", () => {
    const setSelectTrack = vi.fn();
    const getTotalTrackInfo = vi.fn(() => [
      { type: "VIDEO", index: 0, extra_info: "{}" },
      { type: "AUDIO", index: 1, extra_info: '{"language":"eng","codec":"AAC","channels":"2"}' },
      { type: "AUDIO", index: 3, extra_info: '{"track_lang":"fin","fourCC":"AC3","channels":"6"}' },
    ]);
    const getCurrentStreamInfo = vi.fn(() => [{ type: "AUDIO", index: 1, extra_info: "{}" }]);
    (globalThis as typeof globalThis & { webapis?: unknown }).webapis = { avplay: {
      open: vi.fn(), prepareAsync: vi.fn((success: () => void) => success()), play: vi.fn(), pause: vi.fn(),
      jumpForward: vi.fn(), jumpBackward: vi.fn(), stop: vi.fn(), close: vi.fn(),
      setDisplayRect: vi.fn(), setDisplayMethod: vi.fn(), getTotalTrackInfo, getCurrentStreamInfo, setSelectTrack,
    } };
    const container = { getBoundingClientRect: () => ({ left: 0, top: 0, width: 100, height: 100 }) } as unknown as HTMLElement;
    const player = new TizenAvPlayPlayer(container, vi.fn());
    const audioChanges = vi.fn();
    player.setLiveSubtitleMode(true);
    player.setEventHandlers({ onStateChange: vi.fn(), onAudioTracksChange: audioChanges });
    player.load("https://example.invalid/stream.mkv");

    expect(player.getAudioTracks()).toEqual([
      { id: "1", label: "eng · AAC · 2", language: "eng", codec: "AAC", selected: true },
      { id: "3", label: "fin · AC3 · 6", language: "fin", codec: "AC3", selected: false },
    ]);
    expect(player.selectAudioTrack("3")).toBe(true);
    expect(setSelectTrack).toHaveBeenCalledWith("AUDIO", 3);
    expect(audioChanges).toHaveBeenCalledWith(player.getAudioTracks());
    expect(player.selectAudioTrack("bad")).toBe(false);
    player.destroy();
  });

  it("keeps discovered DVB subtitle tracks when AVPlay rejects its native track query", () => {
    (globalThis as typeof globalThis & { webapis?: unknown }).webapis = { avplay: {
      open: vi.fn(), prepareAsync: vi.fn((success: () => void) => success()), play: vi.fn(), pause: vi.fn(),
      jumpForward: vi.fn(), jumpBackward: vi.fn(), stop: vi.fn(), close: vi.fn(),
      setDisplayRect: vi.fn(), setDisplayMethod: vi.fn(), getTotalTrackInfo: vi.fn(() => { throw new Error("not ready"); }),
    } };
    const container = { getBoundingClientRect: () => ({ left: 0, top: 0, width: 100, height: 100 }) } as unknown as HTMLElement;
    const player = new TizenAvPlayPlayer(container, vi.fn());
    player.setLiveSubtitleMode(true);
    player.load("https://example.invalid/live.m3u8");
    (player as unknown as { liveDvbTracks: Array<{ id: string; label: string; language: string; selected: boolean }> }).liveDvbTracks = [
      { id: "dvb:100:1", label: "Finnish · DVB", language: "fin", selected: false },
    ];
    expect(player.getEmbeddedSubtitleTracks()).toEqual([
      { id: "dvb:100:1", label: "Finnish · DVB", language: "fin", selected: false },
    ]);
    player.destroy();
  });

  it("defaults AVPlay audio to Finnish, then English", () => {
    const setSelectTrack = vi.fn();
    const getTotalTrackInfo = vi.fn(() => [
      { type: "AUDIO", index: 0, extra_info: '{"language":"swe"}' },
      { type: "AUDIO", index: 2, extra_info: '{"language":"eng"}' },
      { type: "AUDIO", index: 5, extra_info: '{"track_lang":"fi"}' },
    ]);
    (globalThis as typeof globalThis & { webapis?: unknown }).webapis = { avplay: {
      open: vi.fn(), prepareAsync: vi.fn((success: () => void) => success()), play: vi.fn(), pause: vi.fn(),
      jumpForward: vi.fn(), jumpBackward: vi.fn(), stop: vi.fn(), close: vi.fn(),
      setDisplayRect: vi.fn(), setDisplayMethod: vi.fn(), getTotalTrackInfo,
      getCurrentStreamInfo: vi.fn(() => [{ type: "AUDIO", index: 0, extra_info: "{}" }]), setSelectTrack,
    } };
    const container = { getBoundingClientRect: () => ({ left: 0, top: 0, width: 100, height: 100 }) } as unknown as HTMLElement;
    const player = new TizenAvPlayPlayer(container, vi.fn());
    player.load("https://example.invalid/stream.mkv");
    expect(setSelectTrack).toHaveBeenCalledWith("AUDIO", 5);
    player.destroy();
  });

  it("keeps the live stream's AVPlay default when Finnish and English are unavailable", () => {
    const setSelectTrack = vi.fn();
    (globalThis as typeof globalThis & { webapis?: unknown }).webapis = { avplay: {
      open: vi.fn(), prepareAsync: vi.fn((success: () => void) => success()), play: vi.fn(), pause: vi.fn(),
      jumpForward: vi.fn(), jumpBackward: vi.fn(), stop: vi.fn(), close: vi.fn(),
      setDisplayRect: vi.fn(), setDisplayMethod: vi.fn(),
      getTotalTrackInfo: vi.fn(() => [
        { type: "AUDIO", index: 0, extra_info: '{"language":"swe"}' },
        { type: "AUDIO", index: 5, extra_info: '{"language":"dan"}' },
      ]),
      getCurrentStreamInfo: vi.fn(() => [{ type: "AUDIO", index: 5, extra_info: "{}" }]), setSelectTrack,
    } };
    const container = { getBoundingClientRect: () => ({ left: 0, top: 0, width: 100, height: 100 }) } as unknown as HTMLElement;
    const player = new TizenAvPlayPlayer(container, vi.fn());
    player.setLiveSubtitleMode(true);
    player.load("https://example.invalid/live.m3u8");

    expect(setSelectTrack).not.toHaveBeenCalled();
    expect(player.getAudioTracks().find((track) => track.selected)?.id).toBe("5");
    player.destroy();
  });

  it("defers AVPlay's first-track default while TS audio languages are being probed", () => {
    class PendingXhr {
      timeout = 0;
      responseText = "";
      onprogress: (() => void) | null = null;
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      ontimeout: (() => void) | null = null;
      onabort: (() => void) | null = null;
      open(): void {}
      setRequestHeader(): void {}
      overrideMimeType(): void {}
      send(): void {}
      abort(): void {}
    }
    (globalThis as typeof globalThis & { XMLHttpRequest?: unknown }).XMLHttpRequest = PendingXhr as unknown as typeof XMLHttpRequest;
    const setSelectTrack = vi.fn();
    (globalThis as typeof globalThis & { webapis?: unknown }).webapis = { avplay: {
      open: vi.fn(), prepareAsync: vi.fn((success: () => void) => success()), play: vi.fn(), pause: vi.fn(),
      jumpForward: vi.fn(), jumpBackward: vi.fn(), stop: vi.fn(), close: vi.fn(),
      setDisplayRect: vi.fn(), setDisplayMethod: vi.fn(),
      getTotalTrackInfo: vi.fn(() => [
        { type: "AUDIO", index: 0, extra_info: "{}" },
        { type: "AUDIO", index: 1, extra_info: "{}" },
      ]),
      getCurrentStreamInfo: vi.fn(() => [{ type: "AUDIO", index: 0, extra_info: "{}" }]), setSelectTrack,
    } };
    const container = { getBoundingClientRect: () => ({ left: 0, top: 0, width: 100, height: 100 }) } as unknown as HTMLElement;
    const player = new TizenAvPlayPlayer(container, vi.fn());
    player.setLiveSubtitleMode(true);
    player.setLiveAudioMetadataUrl("https://example.invalid/live.ts");
    player.load("https://example.invalid/live.m3u8");

    expect(player.isAudioTrackSelectionPending()).toBe(true);
    expect(setSelectTrack).not.toHaveBeenCalled();
    player.destroy();
  });

  it("waits for audio tracks that appear after AVPlay preparation", () => {
    let listener: { oncurrentplaytime?(milliseconds: number): void } | undefined;
    const setSelectTrack = vi.fn();
    let tracksReady = false;
    const getTotalTrackInfo = vi.fn(() => tracksReady ? [{ type: "AUDIO", index: 3, extra_info: '{"language":"fin"}' }] : []);
    (globalThis as typeof globalThis & { webapis?: unknown }).webapis = { avplay: {
      open: vi.fn(), prepareAsync: vi.fn((success: () => void) => success()), play: vi.fn(), pause: vi.fn(),
      jumpForward: vi.fn(), jumpBackward: vi.fn(), stop: vi.fn(), close: vi.fn(),
      setDisplayRect: vi.fn(), setDisplayMethod: vi.fn(), getTotalTrackInfo,
      getCurrentStreamInfo: vi.fn(() => []), setSelectTrack,
      setListener: vi.fn((next: NonNullable<typeof listener>) => { listener = next; }),
    } };
    const container = { getBoundingClientRect: () => ({ left: 0, top: 0, width: 100, height: 100 }) } as unknown as HTMLElement;
    const player = new TizenAvPlayPlayer(container, vi.fn());
    player.load("https://example.invalid/stream.mkv");
    tracksReady = true;
    listener?.oncurrentplaytime?.(1_000);
    expect(setSelectTrack).toHaveBeenCalledWith("AUDIO", 3);
    player.destroy();
  });

  it("keeps audio and subtitle tracks when AVPlay rejects the current-stream query", () => {
    const setSelectTrack = vi.fn();
    (globalThis as typeof globalThis & { webapis?: unknown }).webapis = { avplay: {
      open: vi.fn(), prepareAsync: vi.fn((success: () => void) => success()), play: vi.fn(), pause: vi.fn(),
      jumpForward: vi.fn(), jumpBackward: vi.fn(), stop: vi.fn(), close: vi.fn(),
      setDisplayRect: vi.fn(), setDisplayMethod: vi.fn(),
      getTotalTrackInfo: vi.fn(() => [
        { type: "AUDIO", index: "1", extra_info: '{"language":"fin"}' },
        { type: "TEXT", index: "4", extra_info: '{"track_lang":"fin"}' },
      ]),
      getCurrentStreamInfo: vi.fn(() => { throw new Error("not supported"); }), setSelectTrack,
      setSilentSubtitle: vi.fn(),
    } };
    const container = { getBoundingClientRect: () => ({ left: 0, top: 0, width: 100, height: 100 }) } as unknown as HTMLElement;
    const player = new TizenAvPlayPlayer(container, vi.fn());
    player.setLiveSubtitleMode(true);
    player.load("https://example.invalid/stream.mkv");
    expect(player.getAudioTracks()).toHaveLength(1);
    expect(player.getEmbeddedSubtitleTracks()).toHaveLength(1);
    expect(player.getTrackDiagnostics()).toBe("AVPlay tracks: 1 audio, 1 subtitle, 0 video · TS probe not started");
    expect(setSelectTrack).toHaveBeenCalledWith("AUDIO", 1);
    player.destroy();
  });

  it("keeps native subtitle tracks hidden until an explicit track is selected", () => {
    const setSelectTrack = vi.fn();
    const setSilentSubtitle = vi.fn();
    let listener: { onbufferingcomplete?(): void } | undefined;
    const getTotalTrackInfo = vi.fn(() => [
      { type: "TEXT", index: 4, extra_info: '{"track_lang":"swe","codec":"DVB"}' },
      { type: "TEXT", index: 6, extra_info: '{"language":"fin","codec":"DVB"}' },
    ]);
    (globalThis as typeof globalThis & { webapis?: unknown }).webapis = { avplay: {
      open: vi.fn(), prepareAsync: vi.fn((success: () => void) => success()), play: vi.fn(), pause: vi.fn(),
      jumpForward: vi.fn(), jumpBackward: vi.fn(), stop: vi.fn(), close: vi.fn(),
      setDisplayRect: vi.fn(), setDisplayMethod: vi.fn(), getTotalTrackInfo,
      getCurrentStreamInfo: vi.fn(() => [{ type: "TEXT", index: 4, extra_info: "{}" }]), setSelectTrack, setSilentSubtitle,
      setListener: vi.fn((next: NonNullable<typeof listener>) => { listener = next; }),
    } };
    const container = { getBoundingClientRect: () => ({ left: 0, top: 0, width: 100, height: 100 }) } as unknown as HTMLElement;
    const player = new TizenAvPlayPlayer(container, vi.fn());
    const discovered: unknown[] = [];
    player.setEventHandlers({ onStateChange: () => undefined, onEmbeddedSubtitleTracksChange: (tracks) => discovered.push(tracks) });
    player.setLiveSubtitleMode(true);
    player.load("https://example.invalid/live.ts");

    expect(setSilentSubtitle).toHaveBeenCalledWith(true);
    expect(player.getEmbeddedSubtitleTracks()).toEqual([
      { id: "4", label: "swe · DVB", language: "swe", selected: true },
      { id: "6", label: "fin · DVB", language: "fin", selected: false },
    ]);
    expect(player.selectEmbeddedSubtitleTrack("6")).toBe(true);
    expect(setSelectTrack).toHaveBeenCalledWith("TEXT", 6);
    expect(setSilentSubtitle).toHaveBeenLastCalledWith(false);
    listener?.onbufferingcomplete?.();
    expect(setSilentSubtitle).toHaveBeenLastCalledWith(false);
    expect(player.selectEmbeddedSubtitleTrack("off")).toBe(true);
    expect(setSilentSubtitle).toHaveBeenLastCalledWith(true);
    expect(discovered).toContainEqual([
      { id: "4", label: "swe · DVB", language: "swe", selected: true },
      { id: "6", label: "fin · DVB", language: "fin", selected: false },
    ]);
    player.destroy();
  });

  it("does not report live subtitle selection or off when AVPlay cannot mute its text plane", () => {
    const setSelectTrack = vi.fn();
    (globalThis as typeof globalThis & { webapis?: unknown }).webapis = { avplay: {
      open: vi.fn(), prepareAsync: vi.fn((success: () => void) => success()), play: vi.fn(), pause: vi.fn(),
      jumpForward: vi.fn(), jumpBackward: vi.fn(), stop: vi.fn(), close: vi.fn(),
      setDisplayRect: vi.fn(), setDisplayMethod: vi.fn(), getTotalTrackInfo: vi.fn(() => [{ type: "TEXT", index: 2, extra_info: '{"language":"fin"}' }]),
      setSelectTrack,
    } };
    const container = { getBoundingClientRect: () => ({ left: 0, top: 0, width: 100, height: 100 }) } as unknown as HTMLElement;
    const player = new TizenAvPlayPlayer(container, vi.fn());
    player.setLiveSubtitleMode(true);
    player.load("https://example.invalid/live.ts");

    expect(player.selectEmbeddedSubtitleTrack("2")).toBe(false);
    expect(player.selectEmbeddedSubtitleTrack("off")).toBe(false);
    expect(setSelectTrack).toHaveBeenCalledWith("TEXT", 2);
    player.destroy();
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
