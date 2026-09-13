import { describe, expect, it, vi } from "vitest";
import { HtmlVideoPlayer } from "./html-video-player.ts";

function fakeVideo(load: () => void = () => undefined): { video: HTMLVideoElement; dispatch(type: string): void } {
  const listeners = new Map<string, EventListener>();
  const video = {
    src: "",
    currentTime: 0,
    duration: 100,
    ended: false,
    style: {},
    play: vi.fn(() => Promise.resolve()),
    pause: vi.fn(),
    load: vi.fn(load),
    addEventListener: vi.fn((type: string, listener: EventListener) => listeners.set(type, listener)),
    removeEventListener: vi.fn((type: string) => listeners.delete(type)),
    removeAttribute: vi.fn(),
    querySelectorAll: vi.fn(() => []),
    append: vi.fn(),
  } as unknown as HTMLVideoElement;
  return { video, dispatch: (type) => listeners.get(type)?.(new Event(type)) };
}

describe("HtmlVideoPlayer", () => {
  it("reports loading, buffering, playing, pause, and completion from video events", () => {
    const { video, dispatch } = fakeVideo();
    const player = new HtmlVideoPlayer(video);
    const states: string[] = [];
    player.setEventHandlers({ onStateChange: (state) => states.push(state) });

    player.load("https://example.invalid/stream.mp4");
    dispatch("loadstart");
    dispatch("playing");
    dispatch("waiting");
    dispatch("pause");
    dispatch("ended");

    expect(states).toEqual(["loading", "loading", "playing", "buffering", "paused", "ended"]);
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
});
