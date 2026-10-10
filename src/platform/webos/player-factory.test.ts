import { describe, expect, it, vi } from "vitest";
import { WebOsPlaybackPlayerFactory } from "./player-factory.ts";
import { WebOsHtmlVideoPlayer } from "./html-video-player.ts";

vi.mock("./html-video-player.ts", () => ({ WebOsHtmlVideoPlayer: vi.fn(function (this: unknown) { return this; }) }));

describe("WebOsPlaybackPlayerFactory", () => {
  it("creates the shared HTML player only when a video surface is supplied", () => {
    const factory = new WebOsPlaybackPlayerFactory();
    const videoElement = {} as HTMLVideoElement;
    const player = factory.createDirect({ streamUrl: "https://media.example.invalid/synthetic.m3u8", videoElement });

    expect(player).toBeInstanceOf(WebOsHtmlVideoPlayer);
    expect(vi.mocked(WebOsHtmlVideoPlayer)).toHaveBeenCalledOnce();
    expect(vi.mocked(WebOsHtmlVideoPlayer)).toHaveBeenCalledWith(videoElement);
    expect(factory.createDirect({ streamUrl: "https://media.example.invalid/synthetic.m3u8", videoElement: null })).toBeNull();
  });

  it("does not expose relay playback", () => {
    expect(new WebOsPlaybackPlayerFactory()).not.toHaveProperty("createRelay");
  });
});
