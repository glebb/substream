import { afterEach, describe, expect, it, vi } from "vitest";
import { HtmlVideoPlayer } from "./html-video-player.ts";

function fakeVideo(load: () => void = () => undefined): { video: HTMLVideoElement; dispatch(type: string): void; tracks: HTMLTrackElement[] } {
  const listeners = new Map<string, EventListener>();
  const tracks: HTMLTrackElement[] = [];
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
    querySelectorAll: vi.fn(() => tracks),
    append: vi.fn((track: HTMLTrackElement) => tracks.push(track)),
  } as unknown as HTMLVideoElement;
  return { video, dispatch: (type) => listeners.get(type)?.(new Event(type)), tracks };
}

afterEach(() => vi.unstubAllGlobals());

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

  it("contains synchronous load failures and reports a playback error", () => {
    const { video } = fakeVideo(() => { throw new Error("private signed stream URL"); });
    const player = new HtmlVideoPlayer(video);
    const states: string[] = [];
    player.setEventHandlers({ onStateChange: (state) => states.push(state) });

    expect(() => player.load("https://private.example/signed")).not.toThrow();
    expect(states).toEqual(["loading", "error"]);
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
