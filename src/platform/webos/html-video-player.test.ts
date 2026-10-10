import { afterEach, describe, expect, it, vi } from "vitest";
import { WebOsHtmlVideoPlayer } from "./html-video-player.ts";

const base = vi.hoisted(() => ({
  instances: [] as Array<{ suspend: ReturnType<typeof vi.fn>; resume: ReturnType<typeof vi.fn>; load: ReturnType<typeof vi.fn>; play: ReturnType<typeof vi.fn>; destroy: ReturnType<typeof vi.fn> }>,
}));
vi.mock("../browser/html-video-player.ts", () => ({
  HtmlVideoPlayer: class {
    suspend = vi.fn(() => ({ streamUrl: "https://media.example.invalid/synthetic.m3u8", currentTimeSeconds: 36, restorePosition: true, wasPlaying: true }));
    resume = vi.fn();
    baseLoad = vi.fn();
    basePlay = vi.fn();
    baseDestroy = vi.fn();
    constructor() { base.instances.push({ suspend: this.suspend, resume: this.resume, load: this.baseLoad, play: this.basePlay, destroy: this.baseDestroy }); }
    protected suspendForBackground() { return this.suspend(); }
    protected resumeFromBackground(snapshot: unknown) { this.resume(snapshot); }
    load() { this.baseLoad(); }
    play() { this.basePlay(); }
    destroy() { this.baseDestroy(); }
  },
}));

class FakeTarget {
  listeners = new Map<string, Set<EventListener>>();
  addEventListener(type: string, listener: EventListener) {
    const current = this.listeners.get(type) ?? new Set<EventListener>();
    current.add(listener); this.listeners.set(type, current);
  }
  removeEventListener(type: string, listener: EventListener) { this.listeners.get(type)?.delete(listener); }
  dispatch(type: string) { this.listeners.get(type)?.forEach((listener) => listener(new Event(type))); }
}

afterEach(() => { base.instances.length = 0; });

describe("WebOsHtmlVideoPlayer lifecycle", () => {
  it("suspends once while hidden, restores active playback on return, and detaches on destroy", () => {
    const document = Object.assign(new FakeTarget(), { visibilityState: "visible" });
    const window = new FakeTarget();
    const player = new WebOsHtmlVideoPlayer({} as HTMLVideoElement, { document, window });
    const calls = base.instances[0]!;
    player.load("https://media.example.invalid/synthetic.m3u8");

    document.visibilityState = "hidden";
    document.dispatch("visibilitychange");
    player.play();
    player.seekTo(50);
    window.dispatch("pagehide");
    expect(calls.suspend).toHaveBeenCalledOnce();
    expect(calls.resume).not.toHaveBeenCalled();
    document.visibilityState = "visible";
    document.dispatch("visibilitychange");
    expect(calls.resume).toHaveBeenCalledOnce();
    expect(calls.resume).toHaveBeenCalledWith({ streamUrl: "https://media.example.invalid/synthetic.m3u8", currentTimeSeconds: 50, restorePosition: true, wasPlaying: true });

    player.destroy();
    document.visibilityState = "hidden";
    document.dispatch("visibilitychange");
    expect(calls.suspend).toHaveBeenCalledOnce();
    expect(calls.destroy).toHaveBeenCalledOnce();
  });

  it("keeps an explicitly paused source suspended until the user presses play", () => {
    const document = Object.assign(new FakeTarget(), { visibilityState: "visible" });
    const window = new FakeTarget();
    const player = new WebOsHtmlVideoPlayer({} as HTMLVideoElement, { document, window });
    const calls = base.instances[0]!;
    calls.suspend.mockReturnValue({ streamUrl: "https://media.example.invalid/paused.mp4", currentTimeSeconds: 18, restorePosition: true, wasPlaying: false });

    document.visibilityState = "hidden";
    document.dispatch("visibilitychange");
    expect(calls.suspend).toHaveBeenCalledOnce();
    document.visibilityState = "visible";
    document.dispatch("visibilitychange");
    expect(calls.resume).not.toHaveBeenCalled();

    player.play();
    expect(calls.resume).toHaveBeenCalledOnce();
    expect(calls.play).not.toHaveBeenCalled();
  });

  it("uses the newest source loaded while hidden and carries its seek to visibility restore", () => {
    const document = Object.assign(new FakeTarget(), { visibilityState: "visible" });
    const window = new FakeTarget();
    const player = new WebOsHtmlVideoPlayer({} as HTMLVideoElement, { document, window });
    const calls = base.instances[0]!;
    document.visibilityState = "hidden";
    document.dispatch("visibilitychange");
    player.load("https://media.example.invalid/old.mp4");
    player.load("https://media.example.invalid/new.mp4");
    player.seekTo(73);
    document.visibilityState = "visible";
    document.dispatch("visibilitychange");

    expect(calls.suspend).toHaveBeenCalledOnce();
    expect(calls.resume).toHaveBeenCalledWith({ streamUrl: "https://media.example.invalid/new.mp4", currentTimeSeconds: 73, restorePosition: true, wasPlaying: true });
  });

  it("keeps play intent when hidden during source loading and handles startup already hidden", () => {
    const document = Object.assign(new FakeTarget(), { visibilityState: "hidden" });
    const window = new FakeTarget();
    const player = new WebOsHtmlVideoPlayer({} as HTMLVideoElement, { document, window });
    const calls = base.instances[0]!;
    player.load("https://media.example.invalid/loading.mp4");
    player.seekTo(24);
    document.visibilityState = "visible";
    document.dispatch("visibilitychange");

    expect(calls.suspend).not.toHaveBeenCalled();
    expect(calls.resume).toHaveBeenCalledWith({ streamUrl: "https://media.example.invalid/loading.mp4", currentTimeSeconds: 24, restorePosition: true, wasPlaying: true });
  });

  it("keeps requested playback through a loading pause state", () => {
    const document = Object.assign(new FakeTarget(), { visibilityState: "visible" });
    const window = new FakeTarget();
    const player = new WebOsHtmlVideoPlayer({} as HTMLVideoElement, { document, window });
    const calls = base.instances[0]!;
    player.load("https://media.example.invalid/loading-native.mp4");
    calls.suspend.mockReturnValue({ streamUrl: "https://media.example.invalid/loading-native.mp4", currentTimeSeconds: 0, restorePosition: false, wasPlaying: false });
    document.visibilityState = "hidden";
    document.dispatch("visibilitychange");
    document.visibilityState = "visible";
    document.dispatch("visibilitychange");

    expect(calls.load).toHaveBeenCalledOnce();
    expect(calls.resume).toHaveBeenCalledWith({ streamUrl: "https://media.example.invalid/loading-native.mp4", currentTimeSeconds: 0, restorePosition: false, wasPlaying: true });
  });

  it("does not restore a suspended source after disposal", () => {
    const document = Object.assign(new FakeTarget(), { visibilityState: "visible" });
    const window = new FakeTarget();
    const player = new WebOsHtmlVideoPlayer({} as HTMLVideoElement, { document, window });
    const calls = base.instances[0]!;
    document.visibilityState = "hidden";
    document.dispatch("visibilitychange");
    player.destroy();
    document.visibilityState = "visible";
    document.dispatch("visibilitychange");
    player.play();

    expect(calls.resume).not.toHaveBeenCalled();
  });
});
