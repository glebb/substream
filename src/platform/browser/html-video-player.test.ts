import { afterEach, describe, expect, it, vi } from "vitest";
import { HtmlVideoPlayer } from "./html-video-player.ts";

const { isHlsSupported, hlsInstances } = vi.hoisted(() => ({ isHlsSupported: vi.fn(() => false), hlsInstances: [] as unknown[] }));
vi.mock("hls.js", () => ({ default: class MockHls {
  static Events = { ERROR: "error" };
  static isSupported = isHlsSupported;
  on = vi.fn();
  loadSource = vi.fn();
  attachMedia = vi.fn();
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

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); isHlsSupported.mockReset().mockReturnValue(false); hlsInstances.length = 0; });

describe("HtmlVideoPlayer", () => {
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
    await vi.waitFor(() => expect(hlsInstances).toHaveLength(1));

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
    expect(video.currentTime).toBe(119.75);
    dispatch("progress");
    expect(windows).toContainEqual({ startSeconds: 90, endSeconds: 120, currentSeconds: 119.75 });
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

    expect(player.getAudioTracks()).toEqual([
      { id: "0", label: "English", language: "en", selected: true },
      { id: "1", label: "Finnish", language: "fi", selected: false },
    ]);
    expect(player.selectAudioTrack("1")).toBe(true);
    expect(tracks.map((track) => track.enabled)).toEqual([false, true]);
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
      { id: "text:0", label: "English", language: "en", selected: false },
      { id: "text:1", label: "Finnish", language: "fi", selected: false },
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
