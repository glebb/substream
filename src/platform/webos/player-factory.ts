import type { PlaybackPlayerFactory } from "../media-player.ts";
import { WebOsHtmlVideoPlayer } from "./html-video-player.ts";

/** webOS uses the shared HTML media implementation and its browser-native HLS/MSE paths. */
export class WebOsPlaybackPlayerFactory implements PlaybackPlayerFactory {
  createDirect(request: Parameters<PlaybackPlayerFactory["createDirect"]>[0]) {
    return request.videoElement ? new WebOsHtmlVideoPlayer(request.videoElement) : null;
  }
}
