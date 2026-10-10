import { afterEach, describe, expect, it, vi } from "vitest";
import { HtmlVideoPlayer } from "./html-video-player.ts";
import { WebOsHtmlVideoPlayer } from "../webos/html-video-player.ts";
import { VodSubtitleController } from "../../application/vod-subtitle-controller.ts";

const { isHlsSupported, hlsInstances } = vi.hoisted(() => ({ isHlsSupported: vi.fn(() => false), hlsInstances: [] as unknown[] }));
const { canRemux, remuxInstances } = vi.hoisted(() => ({ canRemux: vi.fn(() => false), remuxInstances: [] as Array<{
  start: ReturnType<typeof vi.fn>; seek: ReturnType<typeof vi.fn>; dispose: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn>;
  handlers: { onReady(): void; onError(reason: "cors-range" | "unsupported-audio"): void };
}> }));
vi.mock("./browser-vod-remux.ts", () => ({
  canRemuxBrowserVod: canRemux,
  BrowserVodRemuxSession: class {
    start = vi.fn(); seek = vi.fn(); dispose = vi.fn(); stop = vi.fn();
    getBufferDiagnostics = () => "Buffer: 0.0s · Refill: active";
    constructor(_video: HTMLVideoElement, readonly handlers: { onReady(): void; onError(reason: "cors-range" | "unsupported-audio"): void }) {
      remuxInstances.push(this);
    }
  },
}));
vi.mock("hls.js", () => ({ default: class MockHls {
  static Events = { ERROR: "error" };
  static isSupported = isHlsSupported;
  levels: unknown[] = [{}];
  on = vi.fn();
  loadSource = vi.fn();
  attachMedia = vi.fn();
  startLoad = vi.fn();
  recoverMediaError = vi.fn();
  destroy = vi.fn();
  constructor() { hlsInstances.push(this); }
} }));

function fakeVideo(load: () => void = () => undefined): { video: HTMLVideoElement; dispatch(type: string): void; tracks: HTMLTrackElement[] } {
  const listeners = new Map<string, EventListener[]>();
  const tracks: HTMLTrackElement[] = [];
  const video = {
    src: "",
    currentTime: 0,
    duration: 100,
    ended: false,
    style: {},
    canPlayType: vi.fn(() => ""),
    play: vi.fn(() => Promise.resolve()),
    pause: vi.fn(),
    load: vi.fn(load),
    addEventListener: vi.fn((type: string, listener: EventListener) => listeners.set(type, [...(listeners.get(type) ?? []), listener])),
    removeEventListener: vi.fn((type: string, listener: EventListener) => listeners.set(type, (listeners.get(type) ?? []).filter((entry) => entry !== listener))),
    removeAttribute: vi.fn(),
    querySelectorAll: vi.fn(() => tracks),
    append: vi.fn((track: HTMLTrackElement) => tracks.push(track)),
  } as unknown as HTMLVideoElement;
  return { video, dispatch: (type) => listeners.get(type)?.forEach((listener) => listener(new Event(type))), tracks };
}

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); isHlsSupported.mockReset().mockReturnValue(false); hlsInstances.length = 0; canRemux.mockReset().mockReturnValue(false); remuxInstances.length = 0; });

describe("HtmlVideoPlayer", () => {
  it("plays LG MKV VOD directly despite missing capability probes and supports seek/subtitle discovery", async () => {
    const { video, dispatch } = fakeVideo();
    // LG can decode native MKV even though its MIME probe is empty and its
    // MP4 MSE path rejects Dolby. H.264 support also exercises the DEV guard.
    vi.mocked(video.canPlayType).mockImplementation((mime) => mime.includes("avc1") ? "probably" : "");
    canRemux.mockReturnValue(true);
    const player = new WebOsHtmlVideoPlayer(video);
    player.setVodSubtitleMode(true);
    const url = "https://provider.example.invalid/series/fixture-user/fixture-password/42.mkv";
    player.load(url);
    await Promise.resolve();
    expect(video.src).toBe(url);
    expect(video.play).toHaveBeenCalledOnce();
    expect(canRemux).not.toHaveBeenCalled();
    expect(remuxInstances).toHaveLength(0);
    expect(player.getPlaybackDiagnostics()).not.toContain("Remux:");
    player.seekTo(42);
    Object.assign(video, { readyState: 4 });
    dispatch("loadedmetadata");
    expect(video.currentTime).toBe(42);
    expect(player.isVodSubtitleDiscoveryComplete()).toBe(true);
    player.destroy();
  });

  it("releases the active source while keeping only a safe resume snapshot", () => {
    class LifecycleTestPlayer extends HtmlVideoPlayer {
      suspend() { return this.suspendForBackground(); }
      resume(snapshot: NonNullable<ReturnType<HtmlVideoPlayer["suspendForBackground"]>>) { this.resumeFromBackground(snapshot); }
    }
    const { video } = fakeVideo();
    Object.assign(video, { duration: 100, currentTime: 42, paused: false, ended: false });
    const player = new LifecycleTestPlayer(video);
    const progress = vi.fn();
    player.setEventHandlers({ onStateChange: vi.fn(), onProgress: progress });
    player.load("https://media.example.invalid/synthetic.mp4");

    const snapshot = player.suspend();
    expect(snapshot).toEqual({ streamUrl: "https://media.example.invalid/synthetic.mp4", currentTimeSeconds: 42, restorePosition: true, wasPlaying: true });
    expect(video.pause).toHaveBeenCalled();
    expect(video.removeAttribute).toHaveBeenCalledWith("src");
    expect(progress).toHaveBeenLastCalledWith({ currentTimeSeconds: 42, durationSeconds: 100 });

    player.resume(snapshot!);
    expect(video.src).toBe("https://media.example.invalid/synthetic.mp4");
    expect(video.currentTime).toBe(42);
    player.destroy();
  });

  it("preserves a pending VOD seek but does not restore an absolute live playhead", () => {
    class LifecycleTestPlayer extends HtmlVideoPlayer {
      suspend() { return this.suspendForBackground(); }
    }
    const vod = fakeVideo();
    Object.assign(vod.video, { readyState: 0, duration: 100, currentTime: 0, paused: true });
    const vodPlayer = new LifecycleTestPlayer(vod.video);
    vodPlayer.load("https://media.example.invalid/synthetic.mp4");
    vodPlayer.seekTo(66);
    const vodSnapshot = vodPlayer.suspend();
    expect(vodSnapshot?.currentTimeSeconds).toBe(66);
    expect(vodSnapshot?.restorePosition).toBe(true);
    vodPlayer.destroy();

    const live = fakeVideo();
    Object.assign(live.video, { readyState: 2, duration: Number.POSITIVE_INFINITY, currentTime: 340, paused: false });
    const livePlayer = new LifecycleTestPlayer(live.video);
    // Use a synthetic direct media URL: the live-duration behavior under test
    // does not need to start a background hls.js dynamic import.
    livePlayer.load("https://media.example.invalid/synthetic.ts");
    const liveSnapshot = livePlayer.suspend();
    expect(liveSnapshot?.restorePosition).toBe(false);
    livePlayer.destroy();
  });

  it("retries a buffered native network failure at the saved position without exposing credentials", async () => {
    vi.useFakeTimers();
    const { video, dispatch } = fakeVideo();
    Object.assign(video, { readyState: 4, networkState: 1, duration: 500, paused: false, error: { code: 2 } });
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const player = new HtmlVideoPlayer(video);
    const states: string[] = [];
    player.setEventHandlers({ onStateChange: (state) => states.push(state) });
    const url = "https://provider.example.invalid/movie/synthetic-user/synthetic-password/1.mkv";
    player.load(url);
    video.currentTime = 120;
    dispatch("error");
    dispatch("error"); // duplicate notifications share the pending attempt
    expect(states.at(-1)).toBe("buffering");
    expect(states).not.toContain("error");
    vi.advanceTimersByTime(999);
    expect(video.load).toHaveBeenCalledOnce();
    vi.advanceTimersByTime(1);
    expect(video.load).toHaveBeenCalledTimes(2);
    expect(video.src).toBe(url);
    Object.assign(video, { currentTime: 0, error: null });
    dispatch("loadedmetadata");
    expect(video.currentTime).toBe(120);
    expect(fetchSpy).not.toHaveBeenCalled();
    Object.assign(video, { currentTime: 121, duration: 500 });
    dispatch("timeupdate");
    expect(states.at(-1)).toBe("playing");
    expect(player.getPlaybackDiagnostics()).toContain("Recovery: 1/3");
    expect(player.getPlaybackDiagnostics()).not.toContain("synthetic-password");
    player.destroy();
  });

  it("bounds native retries with backoff and leaves a terminal error visible", () => {
    vi.useFakeTimers();
    const { video, dispatch } = fakeVideo();
    Object.assign(video, { error: { code: 2 } });
    const player = new HtmlVideoPlayer(video);
    const states: string[] = [];
    player.setEventHandlers({ onStateChange: (state) => states.push(state) });
    player.load("https://media.example.invalid/movie.mp4");
    for (const delay of [1_000, 2_000, 4_000]) {
      dispatch("error");
      vi.advanceTimersByTime(delay - 1);
      expect(states).not.toContain("error");
      vi.advanceTimersByTime(1);
    }
    dispatch("error");
    dispatch("playing");
    expect(states.at(-1)).toBe("error");
    expect(video.load).toHaveBeenCalledTimes(4);
    player.destroy();
  });

  it("times out a retry even when Chrome retains stale enough-data state", () => {
    vi.useFakeTimers();
    const { video, dispatch } = fakeVideo();
    Object.assign(video, { readyState: 4, paused: false, error: { code: 2 } });
    const player = new HtmlVideoPlayer(video);
    player.setVodSubtitleMode(true);
    const states: string[] = [];
    player.setEventHandlers({ onStateChange: (state) => states.push(state) });
    player.load("https://media.example.invalid/movie.mp4");
    video.currentTime = 30;
    dispatch("error");
    vi.advanceTimersByTime(1_000);
    dispatch("canplay");
    dispatch("playing");
    dispatch("timeupdate"); // the clock has not advanced
    vi.advanceTimersByTime(45_000);
    expect(states.at(-1)).toBe("error");
    expect(player.getPlaybackDiagnostics()).toContain("Startup timed out");
    player.destroy();
  });

  it.each(["pause", "destroy", "replace"])("cancels a pending retry on %s", (action) => {
    vi.useFakeTimers();
    const { video, dispatch } = fakeVideo();
    Object.assign(video, { error: { code: 2 } });
    const player = new HtmlVideoPlayer(video);
    player.load("https://media.example.invalid/first.mp4");
    dispatch("error");
    if (action === "replace") player.load("https://media.example.invalid/second.mp4");
    else if (action === "pause") player.pause();
    else player.destroy();
    const loads = vi.mocked(video.load).mock.calls.length;
    vi.advanceTimersByTime(1_000);
    expect(video.load).toHaveBeenCalledTimes(loads);
    if (action !== "destroy") player.destroy();
  });

  it.each([3, 4])("does not retry permanent native media error %s", (code) => {
    vi.useFakeTimers();
    const { video, dispatch } = fakeVideo();
    Object.assign(video, { error: { code } });
    const player = new HtmlVideoPlayer(video);
    const states: string[] = [];
    player.setEventHandlers({ onStateChange: (state) => states.push(state) });
    player.load("https://media.example.invalid/movie.mp4");
    dispatch("error");
    vi.advanceTimersByTime(4_000);
    expect(states.at(-1)).toBe("error");
    expect(video.load).toHaveBeenCalledOnce();
    player.destroy();
  });

  it.each(["networkError", "mediaError"])("recovers fatal HLS %s without replacing the source", async (type) => {
    vi.useFakeTimers();
    isHlsSupported.mockReturnValue(true);
    const { video, dispatch } = fakeVideo();
    const player = new HtmlVideoPlayer(video);
    const states: string[] = [];
    player.setEventHandlers({ onStateChange: (state) => states.push(state) });
    player.load("https://media.example.invalid/movie.m3u8");
    await vi.waitFor(() => expect(hlsInstances).toHaveLength(1), { timeout: 5_000 });
    expect(hlsInstances).toHaveLength(1);
    const hls = hlsInstances[0] as { on: ReturnType<typeof vi.fn>; startLoad: ReturnType<typeof vi.fn>; recoverMediaError: ReturnType<typeof vi.fn>; loadSource: ReturnType<typeof vi.fn> };
    const error = hls.on.mock.calls.find(([event]) => event === "error")![1];
    video.currentTime = 35;
    if (type === "mediaError") {
      Object.assign(video, { error: { code: 3 } });
      dispatch("error"); // Chrome may report the media error before hls.js
    }
    error("error", { fatal: true, type });
    expect(states.at(-1)).toBe("buffering");
    vi.advanceTimersByTime(1_000);
    if (type === "networkError") expect(hls.startLoad).toHaveBeenCalledWith(35);
    else {
      expect(hls.recoverMediaError).toHaveBeenCalledOnce();
      expect(states).not.toContain("error");
    }
    expect(hls.loadSource).toHaveBeenCalledOnce();
    player.load("https://media.example.invalid/second.mp4");
    error("error", { fatal: true, type });
    expect(states.at(-1)).toBe("loading");
    player.destroy();
  });

  it("retries a failed initial HLS manifest using the same source", async () => {
    vi.useFakeTimers();
    isHlsSupported.mockReturnValue(true);
    const { video } = fakeVideo();
    const player = new HtmlVideoPlayer(video);
    const url = "https://media.example.invalid/movie.m3u8";
    player.load(url);
    await vi.dynamicImportSettled();
    expect(hlsInstances).toHaveLength(1);
    const hls = hlsInstances[0] as { levels: unknown[]; on: ReturnType<typeof vi.fn>; loadSource: ReturnType<typeof vi.fn>; startLoad: ReturnType<typeof vi.fn> };
    hls.levels = [];
    hls.on.mock.calls.find(([event]) => event === "error")![1]("error", { fatal: true, type: "networkError" });
    vi.advanceTimersByTime(1_000);
    expect(hls.loadSource).toHaveBeenNthCalledWith(2, url);
    expect(hls.startLoad).not.toHaveBeenCalled();
    player.destroy();
  });

  it("retries transient remux requests locally but fails unsupported audio immediately", () => {
    vi.useFakeTimers();
    canRemux.mockReturnValue(true);
    const { video } = fakeVideo();
    const player = new HtmlVideoPlayer(video);
    player.setVodSubtitleMode(true);
    const states: string[] = [];
    player.setEventHandlers({ onStateChange: (state) => states.push(state) });
    player.load("https://media.example.invalid/movie.mkv");
    video.currentTime = 40;
    const session = remuxInstances[0]!;
    session.handlers.onError("cors-range");
    expect(states.at(-1)).toBe("buffering");
    vi.advanceTimersByTime(1_000);
    expect(session.seek).toHaveBeenCalledWith(40);
    session.handlers.onError("unsupported-audio");
    expect(states.at(-1)).toBe("error");
    player.destroy();
  });

  it("reports the active HLS rendition and discovered track counts without copying URLs", () => {
    const { video } = fakeVideo();
    const player = new HtmlVideoPlayer(video);
    const hls = {
      currentLevel: 0, levels: [{ videoCodec: "avc1.640028", audioCodec: "mp4a.40.2", frameRate: 50, bitrate: 6000000, url: "https://example.invalid/private?token=synthetic" }],
      audioTrack: 0, audioTracks: [{ lang: "en", audioCodec: "mp4a.40.2" }, { lang: "fi" }],
      subtitleTrack: 0, subtitleTracks: [{ lang: "fi" }, { lang: "en" }], destroy: vi.fn(),
    };
    (player as unknown as { hls: unknown }).hls = hls;
    expect(player.getStreamInformation()).toMatchObject({ videoCodec: "avc1.640028", audioCodec: "mp4a.40.2", frameRate: 50, streamBitrate: 6000000, audioTrackCount: 2, subtitleTrackCount: 2, audioLanguage: "en", subtitleLanguage: "fi" });
    expect(JSON.stringify(player.getStreamInformation())).not.toContain("token");
    player.destroy();
  });

  it("routes browser MKV VOD through the client remux session and preserves seek/restart controls", async () => {
    canRemux.mockReturnValue(true);
    const { video } = fakeVideo();
    const player = new HtmlVideoPlayer(video);
    player.setVodSubtitleMode(true);
    player.load("https://provider.example.invalid/movie/synthetic-user/synthetic-password/1.mkv");
    const session = remuxInstances[0]!;
    expect(session.start).toHaveBeenCalledWith("https://provider.example.invalid/movie/synthetic-user/synthetic-password/1.mkv");
    expect(video.src).toBe("");
    session.handlers.onReady();
    await Promise.resolve();
    expect(video.play).toHaveBeenCalledOnce();
    player.seekTo(60);
    expect(session.seek).toHaveBeenLastCalledWith(60);
    player.restart();
    expect(session.seek).toHaveBeenLastCalledWith(0);
    video.currentTime = 20;
    player.skip(10);
    expect(session.seek).toHaveBeenLastCalledWith(30);
    player.destroy();
    expect(session.dispose).toHaveBeenCalledOnce();
  });

  it("reports remux failures safely and ignores a replaced session", () => {
    canRemux.mockReturnValue(true);
    const { video } = fakeVideo();
    const player = new HtmlVideoPlayer(video);
    player.setVodSubtitleMode(true);
    const states: string[] = [];
    player.setEventHandlers({ onStateChange: (state) => states.push(state) });
    player.load("https://provider.example.invalid/movie/synthetic-user/synthetic-password/1.mkv");
    const oldSession = remuxInstances[0]!;
    player.load("https://provider.example.invalid/movie/synthetic-user/synthetic-password/2.mkv");
    oldSession.handlers.onError("cors-range");
    expect(states).not.toContain("error");
    remuxInstances[1]!.handlers.onError("unsupported-audio");
    expect(states.at(-1)).toBe("error");
    expect(player.getPlaybackDiagnostics()).toContain("Remux: audio requires conversion");
    expect(player.getPlaybackDiagnostics()).not.toContain("synthetic-password");
    player.destroy();
  });

  it("stops timed-out remux work while keeping the session available for retry", async () => {
    vi.useFakeTimers();
    canRemux.mockReturnValue(true);
    const { video } = fakeVideo();
    const player = new HtmlVideoPlayer(video);
    player.setVodSubtitleMode(true);
    player.load("https://media.example.invalid/movie.mkv");
    vi.advanceTimersByTime(45_000);
    const session = remuxInstances[0]!;
    expect(session.stop).toHaveBeenCalledOnce();
    player.play();
    expect(session.seek).toHaveBeenCalledWith(0);
    expect(player.getPlaybackDiagnostics()).not.toContain("Startup timed out");
    player.destroy();
  });

  it("keeps an autoplay-blocked stream available for an explicit Play tap", async () => {
    vi.useFakeTimers();
    const { video, dispatch } = fakeVideo();
    vi.mocked(video.play).mockRejectedValueOnce(new DOMException("Gesture required", "NotAllowedError"));
    const player = new HtmlVideoPlayer(video);
    const states: string[] = [];
    player.setEventHandlers({ onStateChange: (state) => states.push(state) });
    player.load("https://media.example.invalid/movie.mp4");
    await Promise.resolve();
    expect(states).toContain("paused");
    expect(player.getPlaybackDiagnostics()).toContain("Play: permission required");
    vi.advanceTimersByTime(10_000);
    expect(states).not.toContain("error");
    player.play();
    dispatch("playing");
    expect(video.play).toHaveBeenCalledTimes(2);
    expect(states.at(-1)).toBe("playing");
    player.destroy();
  });

  it("automatically uses external subtitles when browser playback exposes no embedded tracks", async () => {
    const { video, dispatch } = fakeVideo();
    Object.defineProperty(video, "textTracks", { value: [] });
    const player = new HtmlVideoPlayer(video);
    player.setVodSubtitleMode(true);
    dispatch("loadedmetadata");
    const activate = vi.fn(() => true);
    const searchExternal = vi.fn(async (language: string) => ({ language, activate }));
    const controller = new VodSubtitleController({
      preferredLanguage: "fi",
      discoverEmbedded: async () => player.getEmbeddedSubtitleTracks(),
      selectEmbedded: (track) => player.selectEmbeddedSubtitleTrack(track.id),
      searchExternal,
    });
    expect(player.isVodSubtitleDiscoveryComplete()).toBe(true);
    expect(await controller.start()).toEqual({ source: "external", language: "fi" });
    expect(searchExternal).toHaveBeenCalledExactlyOnceWith("fi");
    expect(activate).toHaveBeenCalledOnce();
    player.destroy();
  });

  it("surfaces a missing compatibility server instead of silently playing unsupported MKV audio", async () => {
    const { video } = fakeVideo();
    (video as unknown as { canPlayType(type: string): string }).canPlayType = vi.fn((type: string) => type.includes("avc1") ? "probably" : "");
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false })));
    const player = new HtmlVideoPlayer(video);
    const states: string[] = [];
    player.setEventHandlers({ onStateChange: (state) => states.push(state) });

    player.load("https://media.example.invalid/episode.mkv");
    await vi.waitFor(() => expect(states).toContain("error"));

    expect(video.src).toBe("");
    expect(video.play).not.toHaveBeenCalled();
    player.destroy();
  });

  it("reports the probed source duration and keeps resume pending until HLS duration reaches it", async () => {
    const { video, dispatch } = fakeVideo();
    (video as unknown as { canPlayType(type: string): string }).canPlayType = vi.fn((type: string) => type.includes("avc1") ? "probably" : "");
    const media = video as unknown as { readyState: number; duration: number; currentTime: number };
    media.readyState = 0;
    isHlsSupported.mockReturnValue(true);
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({ url: "/api/media/synthetic/index.m3u8", durationSeconds: 3323, startSeconds: 87 }) })));
    const player = new HtmlVideoPlayer(video);
    const progress: Array<{ currentTimeSeconds: number; durationSeconds: number }> = [];
    player.setEventHandlers({ onStateChange: () => undefined, onProgress: (value) => progress.push(value) });
    const subtitleBlobs: Blob[] = [];
    vi.stubGlobal("URL", {
      createObjectURL: vi.fn((blob: Blob) => { subtitleBlobs.push(blob); return `blob:compat-subtitle-${subtitleBlobs.length}`; }),
      revokeObjectURL: vi.fn(),
    });
    vi.stubGlobal("document", { createElement: vi.fn(() => ({ default: false, kind: "", label: "", srclang: "", src: "", track: { mode: "disabled" }, remove: vi.fn() })) });

    player.load("https://media.example.invalid/episode.mkv");
    player.seekTo(87);
    await vi.waitFor(() => expect(fetch).toHaveBeenCalled());
    const prepRequest = vi.mocked(fetch).mock.calls[0]?.[1];
    expect(JSON.parse(String(prepRequest?.body))).toMatchObject({ startSeconds: 87 });
    await vi.dynamicImportSettled();
    expect(hlsInstances).toHaveLength(1);

    media.readyState = 1;
    media.duration = 7.8;
    dispatch("loadedmetadata");
    expect(media.currentTime).toBe(0);
    media.currentTime = 1.5;
    dispatch("timeupdate");
    expect(progress.at(-1)).toEqual({ currentTimeSeconds: 88.5, durationSeconds: 3323 });

    media.duration = 120;
    dispatch("durationchange");
    expect(media.currentTime).toBe(1.5);
    expect(progress.at(-1)).toEqual({ currentTimeSeconds: 88.5, durationSeconds: 3323 });

    await player.setSubtitle("1\n00:01:27.500 --> 00:01:28.000\nResume cue\n", "English", "en");
    expect(await subtitleBlobs[0]!.text()).toContain("00:00:00.500 --> 00:00:01.000");
    player.restart();
    await vi.waitFor(() => expect(vi.mocked(fetch).mock.calls.filter(([url]) => url === "/api/media/prepare")).toHaveLength(2));
    const prepareCalls = vi.mocked(fetch).mock.calls.filter(([url]) => url === "/api/media/prepare");
    expect(JSON.parse(String(prepareCalls[1]?.[1]?.body))).toMatchObject({ startSeconds: 0 });
    player.destroy();
  });

  it("reports loading, buffering, playing, pause, and completion from video events", () => {
    vi.useFakeTimers();
    const { video, dispatch } = fakeVideo();
    const player = new HtmlVideoPlayer(video);
    const states: string[] = [];
    player.setEventHandlers({ onStateChange: (state) => states.push(state) });

    player.load("https://example.invalid/stream.mp4");
    dispatch("loadstart");
    dispatch("playing");
    dispatch("waiting");
    vi.advanceTimersByTime(750);
    dispatch("pause");
    dispatch("ended");

    expect(states).toEqual(["loading", "loading", "playing", "buffering", "paused", "ended"]);
    player.destroy();
  });

  it("does not report buffering for a transient live waiting event", () => {
    vi.useFakeTimers();
    const { video, dispatch } = fakeVideo();
    const player = new HtmlVideoPlayer(video);
    const states: string[] = [];
    player.setEventHandlers({ onStateChange: (state) => states.push(state) });

    dispatch("waiting");
    dispatch("playing");
    vi.advanceTimersByTime(750);

    expect(states).toEqual(["playing"]);
    player.destroy();
  });

  it("does not report buffering when frames continue advancing during waiting", () => {
    vi.useFakeTimers();
    const { video, dispatch } = fakeVideo();
    const player = new HtmlVideoPlayer(video);
    const states: string[] = [];
    player.setEventHandlers({ onStateChange: (state) => states.push(state) });

    dispatch("waiting");
    video.currentTime = 1;
    vi.advanceTimersByTime(750);

    expect(states).toEqual([]);
    player.destroy();
  });

  it("treats a live timeupdate as playing even if readyState briefly lags", () => {
    vi.useFakeTimers();
    const { video, dispatch } = fakeVideo();
    (video as unknown as { readyState: number }).readyState = 1;
    const player = new HtmlVideoPlayer(video);
    const states: string[] = [];
    player.setEventHandlers({ onStateChange: (state) => states.push(state) });

    dispatch("waiting");
    video.currentTime = 1;
    dispatch("timeupdate");
    vi.advanceTimersByTime(750);

    expect(states).toEqual(["playing"]);
    player.destroy();
  });

  it("recovers from a late live load event once media is advancing", () => {
    const { video, dispatch } = fakeVideo();
    const media = video as unknown as { paused: boolean; readyState: number };
    media.paused = false;
    media.readyState = 4;
    const player = new HtmlVideoPlayer(video);
    const states: string[] = [];
    player.setEventHandlers({ onStateChange: (state) => states.push(state) });

    dispatch("playing");
    dispatch("loadstart");
    dispatch("timeupdate");

    expect(states).toEqual(["playing", "loading", "playing"]);
    player.destroy();
  });

  it("fails a browser stream that never produces playable media without blocking the UI", () => {
    vi.useFakeTimers();
    const { video, dispatch } = fakeVideo();
    const media = video as unknown as { paused: boolean; readyState: number };
    media.paused = false;
    media.readyState = 2;
    const player = new HtmlVideoPlayer(video);
    const states: string[] = [];
    player.setEventHandlers({ onStateChange: (state) => states.push(state) });

    player.load("https://example.invalid/stream.mp4");
    dispatch("playing");
    dispatch("loadstart");
    dispatch("canplay");
    vi.advanceTimersByTime(8_000);

    expect(states).toEqual(["loading", "playing", "loading", "playing", "error"]);
    expect(video.pause).toHaveBeenCalled();
    player.destroy();
    vi.useRealTimers();
  });

  it("allows VOD to start after the live startup deadline", async () => {
    vi.useFakeTimers();
    const { video, dispatch } = fakeVideo();
    const media = video as unknown as { paused: boolean; readyState: number };
    media.paused = false;
    media.readyState = 1;
    const player = new HtmlVideoPlayer(video);
    player.setVodSubtitleMode(true);
    const states: string[] = [];
    player.setEventHandlers({ onStateChange: (state) => states.push(state) });

    player.load("https://media.example.invalid/movie.mp4");
    await Promise.resolve();
    vi.advanceTimersByTime(12_000);
    expect(states).not.toContain("error");
    expect(video.pause).not.toHaveBeenCalled();

    media.readyState = 4;
    video.currentTime = 1;
    dispatch("playing");
    dispatch("timeupdate");
    vi.advanceTimersByTime(45_000);
    expect(states.at(-1)).toBe("playing");
    expect(states).not.toContain("error");
    player.destroy();
  });

  it.each(["startup", "resume"])("keeps intentionally paused LG VOD paused beyond the %s deadline and rearms on play", async (phase) => {
    vi.useFakeTimers();
    const { video, dispatch } = fakeVideo();
    Object.assign(video, { paused: false, readyState: 1 });
    const player = new WebOsHtmlVideoPlayer(video);
    player.setVodSubtitleMode(true);
    const states: string[] = [];
    player.setEventHandlers({ onStateChange: (state) => states.push(state) });
    player.load("https://media.example.invalid/episode.mkv");
    await Promise.resolve();
    if (phase === "resume") {
      Object.assign(video, { readyState: 4, currentTime: 42 });
      dispatch("playing");
      dispatch("timeupdate");
      player.pause();
      Object.assign(video, { paused: true });
      dispatch("pause");
      player.play();
      Object.assign(video, { paused: false });
      await Promise.resolve();
      dispatch("playing");
    }
    dispatch("waiting");
    player.pause();
    Object.assign(video, { paused: true });
    dispatch("pause");
    const stateCount = states.length;
    vi.advanceTimersByTime(90_000);
    expect(states.at(-1)).toBe("paused");
    expect(states).toHaveLength(stateCount);
    expect(player.getPlaybackDiagnostics()).not.toContain("Startup timed out");
    // Resume still detects a genuine startup stall with a fresh VOD deadline.
    Object.assign(video, { readyState: 1 });
    player.play();
    Object.assign(video, { paused: false });
    await Promise.resolve();
    vi.advanceTimersByTime(44_999);
    expect(states).not.toContain("error");
    vi.advanceTimersByTime(1);
    expect(states.at(-1)).toBe("error");
    expect(player.getPlaybackDiagnostics()).toContain("Startup timed out");
    player.destroy();
  });

  it("still times out stalled VOD and gives an explicit retry the VOD deadline", async () => {
    vi.useFakeTimers();
    const { video } = fakeVideo();
    const media = video as unknown as { paused: boolean; readyState: number };
    media.paused = false;
    media.readyState = 1;
    const player = new HtmlVideoPlayer(video);
    player.setVodSubtitleMode(true);
    const states: string[] = [];
    player.setEventHandlers({ onStateChange: (state) => states.push(state) });

    player.load("https://media.example.invalid/movie.mp4");
    await Promise.resolve();
    vi.advanceTimersByTime(45_000);
    expect(states.at(-1)).toBe("error");
    expect(player.getPlaybackDiagnostics()).toContain("Media: metadata received");
    expect(player.getPlaybackDiagnostics()).toContain("Startup timed out");
    expect(video.pause).toHaveBeenCalledTimes(1);

    states.length = 0;
    player.play();
    await Promise.resolve();
    expect(player.getPlaybackDiagnostics()).not.toContain("Startup timed out");
    vi.advanceTimersByTime(8_000);
    expect(states).not.toContain("error");
    vi.advanceTimersByTime(37_000);
    expect(states.at(-1)).toBe("error");
    expect(video.pause).toHaveBeenCalledTimes(2);
    player.destroy();
  });

  it("reports only fixed diagnostic labels even when browser errors contain credentials", async () => {
    const { video } = fakeVideo();
    Object.assign(video, {
      readyState: 0, networkState: 2,
      error: { code: 4, message: "https://provider.example.invalid/movie/synthetic-user/synthetic-password/1.mkv?token=synthetic-token" },
    });
    const player = new HtmlVideoPlayer(video);
    player.load("https://provider.example.invalid/movie/synthetic-user/synthetic-password/1.mp4?token=synthetic-token");
    await Promise.resolve();
    expect(player.getPlaybackDiagnostics()).toBe("Source: MP4 · Media: no metadata · Network: loading · Error: source unsupported · Play: none");
    expect(player.getPlaybackDiagnostics()).not.toMatch(/provider|synthetic|https|token/);
    player.destroy();
  });

  it("keeps a startup failure visible after the asynchronous cleanup pause event", async () => {
    vi.useFakeTimers();
    const { video, dispatch } = fakeVideo();
    const player = new HtmlVideoPlayer(video);
    player.setVodSubtitleMode(true);
    const states: string[] = [];
    player.setEventHandlers({ onStateChange: (state) => states.push(state) });
    player.load("https://media.example.invalid/movie.mp4");
    await Promise.resolve();
    vi.advanceTimersByTime(45_000);
    dispatch("pause");
    expect(states.at(-1)).toBe("error");
    expect(states).not.toContain("paused");
    player.play();
    await Promise.resolve();
    dispatch("playing");
    player.pause();
    dispatch("pause");
    expect(states.at(-1)).toBe("paused");
    player.destroy();
  });

  it("surfaces an unsupported play request as an error even without video.error", async () => {
    const { video } = fakeVideo();
    vi.mocked(video.play).mockRejectedValueOnce(new DOMException("synthetic private URL", "NotSupportedError"));
    const player = new HtmlVideoPlayer(video);
    const states: string[] = [];
    player.setEventHandlers({ onStateChange: (state) => states.push(state) });
    player.load("https://media.example.invalid/movie.mp4");
    await Promise.resolve();
    expect(states.at(-1)).toBe("error");
    expect(player.getPlaybackDiagnostics()).toContain("Play: source unsupported");
    expect(player.getPlaybackDiagnostics()).not.toContain("synthetic private URL");
    player.destroy();
  });

  it("ignores a play rejection from the previous source", async () => {
    const { video } = fakeVideo();
    let rejectPrevious: (reason: unknown) => void = () => {};
    vi.mocked(video.play).mockImplementationOnce(() => new Promise<void>((_resolve, reject) => { rejectPrevious = reject; }));
    const player = new HtmlVideoPlayer(video);
    const states: string[] = [];
    player.setEventHandlers({ onStateChange: (state) => states.push(state) });
    player.load("https://media.example.invalid/old.mp4");
    player.load("https://media.example.invalid/new.mp4");
    rejectPrevious(new DOMException("Interrupted", "AbortError"));
    await Promise.resolve();
    expect(states).toEqual(["loading", "loading"]);
    player.destroy();
  });

  it("reports elapsed time and duration when browser media metadata is available", () => {
    const { video, dispatch } = fakeVideo();
    const player = new HtmlVideoPlayer(video);
    const progress: Array<{ currentTimeSeconds: number; durationSeconds: number }> = [];
    player.setEventHandlers({ onStateChange: () => undefined, onProgress: (value) => progress.push(value) });

    video.currentTime = 42;
    dispatch("timeupdate");
    (video as unknown as { duration: number }).duration = Number.POSITIVE_INFINITY;
    dispatch("durationchange");

    expect(progress).toEqual([{ currentTimeSeconds: 42, durationSeconds: 100 }]);
    player.destroy();
  });

  it("exposes and seeks only within a provider's rolling live window", () => {
    const { video, dispatch } = fakeVideo();
    const media = video as unknown as { currentTime: number; seekable: TimeRanges };
    media.currentTime = 115;
    media.seekable = { length: 1, start: () => 90, end: () => 120 } as TimeRanges;
    const player = new HtmlVideoPlayer(video);
    const windows: unknown[] = [];
    player.setEventHandlers({ onStateChange: () => undefined, onLiveBufferWindowChange: (value) => windows.push(value) });

    expect(player.getLiveBufferWindow()).toEqual({ startSeconds: 90, endSeconds: 120, currentSeconds: 115 });
    player.seekLiveBuffer?.(20);
    expect(video.currentTime).toBe(90);
    player.goLive?.();
    expect(video.currentTime).toBe(110);
    dispatch("progress");
    expect(windows).toContainEqual({ startSeconds: 90, endSeconds: 120, currentSeconds: 110 });
    player.destroy();
  });

  it("returns to the HLS safety position and clamps stale sync points to the live window", () => {
    const { video } = fakeVideo();
    (video as unknown as { seekable: TimeRanges }).seekable = { length: 1, start: () => 90, end: () => 120 };
    const player = new HtmlVideoPlayer(video);
    const hls = { liveSyncPosition: 102, destroy: vi.fn() };
    (player as unknown as { hls: unknown }).hls = hls;
    player.goLive();
    expect(video.currentTime).toBe(102);
    hls.liveSyncPosition = 80;
    player.goLive();
    expect(video.currentTime).toBe(90);
    hls.liveSyncPosition = NaN;
    player.goLive();
    expect(video.currentTime).toBe(110);
    player.destroy();
  });

  it("resumes at a saved position after metadata loads and exposes only video dimensions", () => {
    const { video, dispatch } = fakeVideo();
    const media = video as unknown as { readyState: number; videoWidth: number; videoHeight: number; currentTime: number };
    media.readyState = 1;
    media.videoWidth = 1920;
    media.videoHeight = 1080;
    const player = new HtmlVideoPlayer(video);

    player.seekTo(84);
    dispatch("loadedmetadata");
    expect(video.currentTime).toBe(84);
    expect(player.getVideoResolution()).toBe("1920 × 1080");
    (video as unknown as { buffered: TimeRanges }).buffered = { length: 1, start: () => 80, end: () => 100 };
    (video as unknown as { getVideoPlaybackQuality: () => { totalVideoFrames: number; droppedVideoFrames: number } }).getVideoPlaybackQuality = () => ({ totalVideoFrames: 120, droppedVideoFrames: 2 });
    expect(player.getStreamInformation()).toMatchObject({ bufferedSeconds: 16, decodedFrames: 120, droppedFrames: 2 });
    expect(player.getStreamInformation().audioTrackCount).toBeUndefined();
    player.destroy();
  });

  it("lists and selects audio tracks when the browser exposes its non-standard audioTracks API", () => {
    const { video } = fakeVideo();
    const tracks = [
      { label: "English", language: "en", enabled: true },
      { label: "Finnish", language: "fi", enabled: false },
    ];
    (video as unknown as { audioTracks: typeof tracks }).audioTracks = tracks;
    const player = new HtmlVideoPlayer(video);
    const audioTracksChanged = vi.fn();
    player.setEventHandlers({ onStateChange: vi.fn(), onAudioTracksChange: audioTracksChanged });

    expect(player.getAudioTracks()).toEqual([
      { id: "0", label: "English", language: "en", selected: true },
      { id: "1", label: "Finnish", language: "fi", selected: false },
    ]);
    expect(player.selectAudioTrack("1")).toBe(true);
    expect(tracks.map((track) => track.enabled)).toEqual([false, true]);
    expect(audioTracksChanged).toHaveBeenLastCalledWith([
      { id: "0", label: "English", language: "en", selected: false },
      { id: "1", label: "Finnish", language: "fi", selected: true },
    ]);
    expect(player.selectAudioTrack("not-a-track")).toBe(false);
    player.destroy();
  });

  it("reports no selectable audio tracks when the browser does not expose them", () => {
    const { video } = fakeVideo();
    const player = new HtmlVideoPlayer(video);
    expect(player.getAudioTracks()).toEqual([]);
    expect(player.selectAudioTrack("0")).toBe(false);
    player.destroy();
  });

  it("keeps live native subtitle defaults hidden and selects Finnish, English, or off", () => {
    const { video } = fakeVideo();
    const changes = new Map<string, EventListener>();
    const tracks = [
      { kind: "subtitles", label: "English", language: "en", mode: "showing" },
      { kind: "captions", label: "Finnish", language: "fi", mode: "showing" },
    ] as unknown as TextTrack[] & { addEventListener(type: string, listener: EventListener): void; removeEventListener(type: string): void };
    tracks.addEventListener = vi.fn((type: string, listener: EventListener) => changes.set(type, listener));
    tracks.removeEventListener = vi.fn((type: string) => changes.delete(type));
    (video as unknown as { textTracks: typeof tracks }).textTracks = tracks;
    const player = new HtmlVideoPlayer(video);
    const trackChanges: unknown[] = [];
    player.setEventHandlers({ onStateChange: () => undefined, onEmbeddedSubtitleTracksChange: (value) => trackChanges.push(value) });
    player.setLiveSubtitleMode(true);

    expect((tracks[0] as unknown as { mode: string }).mode).toBe("disabled");
    expect((tracks[1] as unknown as { mode: string }).mode).toBe("disabled");
    expect(player.getEmbeddedSubtitleTracks()).toEqual([
      { id: "text:0", label: "English", language: "en", playable: true, selected: false },
      { id: "text:1", label: "Finnish", language: "fi", playable: true, selected: false },
    ]);
    expect(player.selectEmbeddedSubtitleTrack("text:1")).toBe(true);
    expect((tracks[0] as unknown as { mode: string }).mode).toBe("disabled");
    expect((tracks[1] as unknown as { mode: string }).mode).toBe("showing");
    expect(player.selectEmbeddedSubtitleTrack("off")).toBe(true);
    expect((tracks[1] as unknown as { mode: string }).mode).toBe("disabled");
    expect(trackChanges.length).toBeGreaterThan(0);
    player.setLiveSubtitleMode(false);
    expect(player.getEmbeddedSubtitleTracks()).toEqual([]);
    player.destroy();
  });

  it("discovers native VOD text tracks and switches cleanly between embedded and external subtitles", async () => {
    const { video, dispatch, tracks: attached } = fakeVideo();
    const textTracks = [
      { kind: "subtitles", label: "Finnish", language: "fi", mode: "showing" },
      { kind: "captions", label: "English", language: "en", mode: "disabled" },
    ] as unknown as TextTrack[];
    (video as unknown as { textTracks: TextTrack[] }).textTracks = textTracks;
    vi.stubGlobal("URL", { createObjectURL: vi.fn(() => "blob:synthetic-vod-subtitle"), revokeObjectURL: vi.fn() });
    vi.stubGlobal("document", { createElement: vi.fn(() => ({ default: false, kind: "", label: "", srclang: "", src: "", track: { mode: "disabled" }, remove: vi.fn(() => { attached.splice(0); }) })) });
    const player = new HtmlVideoPlayer(video);
    player.setVodSubtitleMode?.(true);
    expect((textTracks[0] as unknown as { mode: string }).mode).toBe("disabled");
    player.load("https://media.example.invalid/movie.mp4");
    dispatch("loadedmetadata");

    expect(player.isVodSubtitleDiscoveryComplete?.()).toBe(true);
    expect(player.getEmbeddedSubtitleTracks()).toHaveLength(2);
    expect(player.selectEmbeddedSubtitleTrack("text:0")).toBe(true);
    expect((textTracks[0] as unknown as { mode: string }).mode).toBe("showing");
    expect(await player.setSubtitle("1\n00:00:01,000 --> 00:00:02,000\nExternal", "External", "fi")).toEqual({ enabled: true });
    expect((textTracks[0] as unknown as { mode: string }).mode).toBe("disabled");
    expect(attached).toHaveLength(1);
    expect(player.selectEmbeddedSubtitleTrack("off")).toBe(true);
    expect(attached).toHaveLength(1);
    textTracks.push((attached[0] as unknown as { track: TextTrack }).track);
    player.setSubtitleEnabled(true);
    expect((attached[0] as unknown as { track: { mode: string } }).track.mode).toBe("showing");
    // Real browser TextTrackLists include the injected external track. Playing
    // and metadata refreshes must not suppress it as a native default.
    Object.assign((attached[0] as unknown as { track: TextTrack }).track, { kind: "subtitles", label: "External", language: "fi" });
    dispatch("playing");
    dispatch("loadedmetadata");
    expect((attached[0] as unknown as { track: { mode: string } }).track.mode).toBe("showing");
    expect(player.getEmbeddedSubtitleTracks()).toHaveLength(2);
    player.setSubtitleEnabled(false);
    dispatch("playing");
    expect((attached[0] as unknown as { track: { mode: string } }).track.mode).toBe("disabled");
    player.setSubtitleEnabled(true);
    dispatch("playing");
    expect((attached[0] as unknown as { track: { mode: string } }).track.mode).toBe("showing");
    expect(player.selectEmbeddedSubtitleTrack("text:1")).toBe(true);
    expect(attached).toHaveLength(0);
    expect((textTracks[1] as unknown as { mode: string }).mode).toBe("showing");
    player.destroy();
  });

  it("contains synchronous load failures and reports a playback error", () => {
    const { video } = fakeVideo(() => { throw new Error("private signed stream URL"); });
    const player = new HtmlVideoPlayer(video);
    const states: string[] = [];
    player.setEventHandlers({ onStateChange: (state) => states.push(state) });

    expect(() => player.load("https://private.example/signed")).not.toThrow();
    expect(states).toEqual(["loading", "error"]);
  });

  it("falls back to native HLS when hls.js is unsupported in live subtitle mode", async () => {
    const { video } = fakeVideo();
    (video as unknown as { canPlayType(type: string): string }).canPlayType = vi.fn(() => "probably");
    const player = new HtmlVideoPlayer(video);
    const states: string[] = [];
    player.setEventHandlers({ onStateChange: (state) => states.push(state) });
    player.setLiveSubtitleMode(true);

    player.load("https://example.invalid/live.m3u8");
    await vi.waitFor(() => expect(video.src).toBe("https://example.invalid/live.m3u8"));

    expect(video.load).toHaveBeenCalledOnce();
    expect(video.play).toHaveBeenCalledOnce();
    expect(states).toEqual(["loading"]);
    player.destroy();
  });

  it("rebuilds browser WebVTT tracks from the original subtitle and revokes replaced and destroyed URLs", async () => {
    const { video, tracks } = fakeVideo();
    const createdBlobs: Blob[] = [];
    const revokedUrls: string[] = [];
    let nextUrl = 0;
    vi.stubGlobal("URL", {
      createObjectURL: vi.fn((blob: Blob) => {
        createdBlobs.push(blob);
        nextUrl += 1;
        return `blob:subtitle-${nextUrl}`;
      }),
      revokeObjectURL: vi.fn((url: string) => revokedUrls.push(url)),
    });
    vi.stubGlobal("document", {
      createElement: vi.fn(() => ({
        default: false,
        track: { mode: "disabled" },
        kind: "",
        label: "",
        srclang: "",
        src: "",
        remove: vi.fn(function(this: HTMLTrackElement) {
          const index = tracks.indexOf(this);
          if (index >= 0) tracks.splice(index, 1);
        }),
      } as unknown as HTMLTrackElement)),
    });

    const player = new HtmlVideoPlayer(video);
    player.setSubtitleTimingOffset(1);
    const source = "1\n00:00:00,500 --> 00:00:02,000\nHello\n";
    expect(await player.setSubtitle(source, "Finnish", "fi")).toEqual({ enabled: true });
    expect(tracks).toHaveLength(1);
    expect(tracks[0]).toMatchObject({ default: true, kind: "subtitles", label: "Finnish", srclang: "fi", src: "blob:subtitle-1" });
    expect(tracks[0]!.track.mode).toBe("showing");
    expect(await createdBlobs[0]!.text()).toContain("00:00:01.500 --> 00:00:03.000");

    player.setSubtitleEnabled(false);
    expect(tracks[0]!.track.mode).toBe("disabled");

    player.setSubtitleTimingOffset(-0.5);
    expect(tracks).toHaveLength(1);
    expect(tracks[0]!.src).toBe("blob:subtitle-2");
    expect(tracks[0]!.track.mode).toBe("disabled");
    expect(await createdBlobs[1]!.text()).toContain("00:00:00.000 --> 00:00:01.500");
    expect(revokedUrls).toEqual(["blob:subtitle-1"]);

    player.setSubtitleEnabled(true);
    expect(tracks[0]!.track.mode).toBe("showing");
    expect(createdBlobs).toHaveLength(2);
    expect(revokedUrls).toEqual(["blob:subtitle-1"]);

    player.destroy();
    expect(tracks).toHaveLength(0);
    expect(revokedUrls).toEqual(["blob:subtitle-1", "blob:subtitle-2"]);
  });
});
