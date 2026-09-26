import { afterEach, describe, expect, it, vi } from "vitest";
import { HtmlVideoPlayer } from "./html-video-player.ts";
import { LIVE_DVB_MAX_FRAGMENT_BYTES, type LiveDvbWorkerRequest, type LiveDvbWorkerResponse, type WorkerPort } from "./live-dvb-worker-protocol.ts";

const hlsHarness = vi.hoisted(() => ({ instance: null as any }));
vi.mock("hls.js", () => {
  class MockHls {
    static Events = { ERROR: "error", FRAG_LOADED: "frag-loaded", FRAG_DECRYPTED: "frag-decrypted", SUBTITLE_TRACKS_UPDATED: "subtitle-tracks-updated", SUBTITLE_TRACK_SWITCH: "subtitle-track-switch" };
    static isSupported = () => true;
    readonly handlers = new Map<string, Array<(event: string, data: Record<string, unknown>) => void>>();
    readonly off = vi.fn((event: string, callback: (event: string, data: Record<string, unknown>) => void) => this.handlers.set(event, (this.handlers.get(event) ?? []).filter((fn) => fn !== callback)));
    readonly on = vi.fn((event: string, callback: (event: string, data: Record<string, unknown>) => void) => this.handlers.set(event, [...(this.handlers.get(event) ?? []), callback]));
    readonly destroy = vi.fn();
    constructor(readonly config: Record<string, unknown>) { hlsHarness.instance = this; }
    loadSource(): void {}
    attachMedia(): void {}
    emit(event: string, data: Record<string, unknown>): void { for (const callback of this.handlers.get(event) ?? []) callback(event, data); }
  }
  return { default: MockHls };
});

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); hlsHarness.instance = null; });

describe("HtmlVideoPlayer isolated DVB path", () => {
  it("disposes a worker that does not acknowledge fragment work before the watchdog", async () => {
    const video = {
      src: "", currentTime: 0, duration: Infinity, paused: false, readyState: 4,
      play: vi.fn(async () => undefined), pause: vi.fn(), load: vi.fn(), canPlayType: () => "",
      addEventListener: vi.fn(), removeEventListener: vi.fn(), removeAttribute: vi.fn(),
      getBoundingClientRect: () => ({ left: 0, top: 0, width: 320, height: 180 }), querySelectorAll: () => [],
      textTracks: { addEventListener: vi.fn(), removeEventListener: vi.fn(), length: 0 },
    } as unknown as HTMLVideoElement;
    const canvas = { style: {}, width: 0, height: 0, setAttribute: vi.fn(), getContext: vi.fn(() => ({ clearRect: vi.fn(), putImageData: vi.fn() })), remove: vi.fn() };
    vi.stubGlobal("document", { createElement: vi.fn(() => canvas), body: { appendChild: vi.fn() } });
    vi.stubGlobal("window", { addEventListener: vi.fn(), removeEventListener: vi.fn() });
    const workerListeners = new Map<string, EventListener>();
    const worker: WorkerPort = {
      postMessage: vi.fn(), addEventListener: (type, listener) => { workerListeners.set(type, listener); },
      removeEventListener: (type) => { workerListeners.delete(type); }, terminate: vi.fn(),
    };
    const player = new HtmlVideoPlayer(video, () => worker);
    player.setLiveSubtitleMode(true);
    player.load("https://example.invalid/live.m3u8");
    await new Promise((resolve) => setTimeout(resolve, 20));
    const hls = hlsHarness.instance;
    expect(hls).toBeTruthy();
    vi.useFakeTimers();
    (video as { currentTime: number }).currentTime = 1;
    hls.emit("frag-loaded", { payload: new ArrayBuffer(2048), frag: { type: "main", start: 3 } });
    await vi.advanceTimersByTimeAsync(8_000);

    expect(worker.terminate).toHaveBeenCalledOnce();
    expect(canvas.remove).toHaveBeenCalledOnce();
    expect(player.getEmbeddedSubtitleTracks()).toEqual([]);
    expect(video.pause).not.toHaveBeenCalled();
    player.destroy();
    vi.useRealTimers();
  });

  it("discovers/selects worker tracks and disposes subtitle resources without failing playback", async () => {
    const videoListeners = new Map<string, EventListener>();
    const context = { clearRect: vi.fn(), putImageData: vi.fn() };
    const canvas = { style: {}, width: 0, height: 0, setAttribute: vi.fn(), getContext: vi.fn(() => context), remove: vi.fn() };
    const video = {
      src: "", currentTime: 0, duration: Infinity, paused: false, readyState: 4,
      play: vi.fn(async () => undefined), pause: vi.fn(), load: vi.fn(), canPlayType: () => "",
      addEventListener: vi.fn((type: string, listener: EventListener) => videoListeners.set(type, listener)),
      removeEventListener: vi.fn((type: string) => videoListeners.delete(type)),
      removeAttribute: vi.fn(), getBoundingClientRect: () => ({ left: 0, top: 0, width: 320, height: 180 }),
      querySelectorAll: () => [],
      textTracks: { addEventListener: vi.fn(), removeEventListener: vi.fn(), length: 0 },
    } as unknown as HTMLVideoElement;
    const windowListeners = new Map<string, EventListener>();
    vi.stubGlobal("document", { createElement: vi.fn(() => canvas), body: { appendChild: vi.fn() } });
    vi.stubGlobal("window", { addEventListener: (type: string, listener: EventListener) => windowListeners.set(type, listener), removeEventListener: (type: string) => windowListeners.delete(type) });
    vi.stubGlobal("ImageData", class { constructor(readonly data: Uint8ClampedArray, readonly width: number, readonly height: number) {} });

    const workerListeners = new Map<string, EventListener>();
    const posted: LiveDvbWorkerRequest[] = [];
    const worker: WorkerPort = {
      postMessage: (message) => { posted.push(message); },
      addEventListener: (type, listener) => { workerListeners.set(type, listener); },
      removeEventListener: (type) => { workerListeners.delete(type); },
      terminate: vi.fn(),
    };
    const states: string[] = [];
    const player = new HtmlVideoPlayer(video, () => worker);
    player.setEventHandlers({ onStateChange: (state) => states.push(state) });
    player.setLiveSubtitleMode(true);
    player.load("https://example.invalid/live.m3u8");
    await new Promise((resolve) => setTimeout(resolve, 20));

    const hls = hlsHarness.instance;
    expect(hls).toBeTruthy();
    expect(hls.config).toMatchObject({ enableWebVTT: false, enableIMSC1: false, enableCEA708Captions: false, enableWorker: true });
    hls.emit("frag-loaded", { payload: new ArrayBuffer(2048), frag: { type: "main", start: 3 } });
    expect(posted.find((message) => message.type === "fragment")).toBeTruthy();
    workerListeners.get("message")?.(new MessageEvent("message", { data: { type: "tracks", tracks: [] } satisfies LiveDvbWorkerResponse }));
    expect(player.selectEmbeddedSubtitleTrack("off")).toBe(true);
    expect(player.selectEmbeddedSubtitleTrack("off")).toBe(true);
    expect(posted.filter((message) => message.type === "select")).toHaveLength(0);
    workerListeners.get("message")?.(new MessageEvent("message", { data: { type: "ack" } satisfies LiveDvbWorkerResponse }));
    const windowBytes = Math.floor(LIVE_DVB_MAX_FRAGMENT_BYTES / 188) * 188;
    const segment = new ArrayBuffer(1024 * 1024);
    const segmentBytes = new Uint8Array(segment);
    segmentBytes[0] = 0x11;
    segmentBytes[windowBytes] = 0x22;
    segmentBytes[windowBytes * 2] = 0x33;
    const fragment = { type: "main", start: 6 };
    hls.emit("frag-loaded", { payload: segment, frag: fragment });
    hls.emit("frag-decrypted", { payload: new ArrayBuffer(segment.byteLength), frag: fragment });
    expect(posted.filter((message) => message.type === "fragment")).toHaveLength(2);
    workerListeners.get("message")?.(new MessageEvent("message", { data: { type: "ack" } satisfies LiveDvbWorkerResponse }));
    workerListeners.get("message")?.(new MessageEvent("message", { data: { type: "ack" } satisfies LiveDvbWorkerResponse }));
    const windows = posted.filter((message) => message.type === "fragment") as Extract<LiveDvbWorkerRequest, { type: "fragment" }>[];
    expect(windows).toHaveLength(4);
    expect(windows.slice(1).map(({ buffer }) => buffer.byteLength)).toEqual([windowBytes, windowBytes, 1024 * 1024 - windowBytes * 2]);
    expect(windows.slice(1).map(({ buffer }) => new Uint8Array(buffer)[0])).toEqual([0x11, 0x22, 0x33]);
    workerListeners.get("message")?.(new MessageEvent("message", { data: { type: "ack" } satisfies LiveDvbWorkerResponse }));
    const overCap = new ArrayBuffer(10 * 1024 * 1024 + 188);
    hls.emit("frag-loaded", { payload: overCap, frag: { type: "main", start: 8 } });
    expect(posted.filter((message) => message.type === "fragment")).toHaveLength(4);
    const tracks: LiveDvbWorkerResponse = { type: "tracks", tracks: [{ id: "288:1", language: "fin", label: "fin · DVB" }] };
    workerListeners.get("message")?.(new MessageEvent("message", { data: tracks }));
    expect(player.getEmbeddedSubtitleTracks()).toContainEqual({ id: "dvb:288:1", language: "fin", label: "fin · DVB", selected: false });
    expect(player.selectEmbeddedSubtitleTrack("dvb:288:1")).toBe(true);
    expect(posted.some((message) => message.type === "select" && message.trackId === "288:1")).toBe(true);
    expect(player.selectEmbeddedSubtitleTrack("dvb:288:1")).toBe(true);
    expect(posted.filter((message) => message.type === "select" && message.trackId === "288:1")).toHaveLength(1);
    workerListeners.get("message")?.(new MessageEvent("message", { data: {
      type: "frame", width: 2, height: 1, screenWidth: 4, screenHeight: 2, x: 1, y: 1, rgba: new ArrayBuffer(8),
    } satisfies LiveDvbWorkerResponse }));
    expect(context.putImageData).toHaveBeenCalledOnce();
    expect(player.selectEmbeddedSubtitleTrack("off")).toBe(true);
    expect(player.selectEmbeddedSubtitleTrack("off")).toBe(true);
    expect(posted.filter((message) => message.type === "select" && message.trackId === "")).toHaveLength(1);

    workerListeners.get("message")?.(new MessageEvent("message", { data: { type: "error" } satisfies LiveDvbWorkerResponse }));
    expect(worker.terminate).toHaveBeenCalledOnce();
    expect(canvas.remove).toHaveBeenCalledOnce();
    expect(player.getEmbeddedSubtitleTracks()).toEqual([]);
    expect(states).not.toContain("error");
    expect(video.pause).not.toHaveBeenCalled();
    expect(windowListeners.size).toBe(0);
    player.destroy();
  });
});
