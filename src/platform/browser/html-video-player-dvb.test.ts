import { afterEach, describe, expect, it, vi } from "vitest";
import { HtmlVideoPlayer } from "./html-video-player.ts";
import type { LiveDvbWorkerRequest, LiveDvbWorkerResponse, WorkerPort } from "./live-dvb-worker-protocol.ts";

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

afterEach(() => { vi.unstubAllGlobals(); hlsHarness.instance = null; });

describe("HtmlVideoPlayer isolated DVB path", () => {
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
    const tracks: LiveDvbWorkerResponse = { type: "tracks", tracks: [{ id: "288:1", language: "fin", label: "fin · DVB" }] };
    workerListeners.get("message")?.(new MessageEvent("message", { data: tracks }));
    expect(player.getEmbeddedSubtitleTracks()).toContainEqual({ id: "dvb:288:1", language: "fin", label: "fin · DVB", selected: false });
    expect(player.selectEmbeddedSubtitleTrack("dvb:288:1")).toBe(true);
    expect(posted.some((message) => message.type === "select" && message.trackId === "288:1")).toBe(true);
    workerListeners.get("message")?.(new MessageEvent("message", { data: {
      type: "frame", width: 2, height: 1, screenWidth: 4, screenHeight: 2, x: 1, y: 1, rgba: new ArrayBuffer(8),
    } satisfies LiveDvbWorkerResponse }));
    expect(context.putImageData).toHaveBeenCalledOnce();

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
