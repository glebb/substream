import { describe, expect, it } from "vitest";
import { playbackCapabilities } from "./media-player.ts";

describe("playback capabilities", () => {
  it("prevents VOD-only transport controls for live streams", () => {
    expect(playbackCapabilities({ kind: "live", streamUrl: "https://example.test/live.m3u8", channelId: "channel" }))
      .toEqual({ seek: false, restart: false, pause: false, tracks: true });
    expect(playbackCapabilities({ kind: "vod", streamUrl: "https://example.test/movie.mp4", titleId: "movie" }).seek).toBe(true);
  });
});
