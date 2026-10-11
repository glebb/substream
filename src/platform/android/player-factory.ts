import type { PlaybackPlayerFactory } from "../media-player.ts";
import { AndroidNativePlayer } from "./native-player.ts";

export class AndroidPlaybackPlayerFactory implements PlaybackPlayerFactory {
  createDirect(request: Parameters<PlaybackPlayerFactory["createDirect"]>[0]) {
    return request.container ? new AndroidNativePlayer(request.container, request.playbackKind ?? "vod", request.resumeSeconds) : null;
  }
}
