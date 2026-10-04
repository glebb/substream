import type { PlaybackPlayerFactory } from "./media-player.ts";
import { HtmlVideoPlayer } from "./browser/html-video-player.ts";
import { TizenAvPlayPlayer, isTizenAvPlayAvailable } from "./tizen/avplay-player.ts";
import { TizenLiveRelayPlayer } from "./tizen/live-relay-player.ts";

/** Default browser/Tizen player adapter. Other platforms can provide the same contract. */
export class BrowserTizenPlaybackPlayerFactory implements PlaybackPlayerFactory {
  createDirect(request: Parameters<PlaybackPlayerFactory["createDirect"]>[0]) {
    if (isTizenAvPlayAvailable() && request.container) {
      const player = new TizenAvPlayPlayer(request.container, request.onSubtitleCue ?? (() => {}));
      if (request.transportStreamMetadataUrl) player.setLiveAudioMetadataUrl(request.transportStreamMetadataUrl);
      return player;
    }
    return request.videoElement ? new HtmlVideoPlayer(request.videoElement) : null;
  }

  createRelay(request: Parameters<NonNullable<PlaybackPlayerFactory["createRelay"]>>[0]) {
    if (!isTizenAvPlayAvailable()) return null;
    return new TizenLiveRelayPlayer(request.container, request.config, request.channelId, {
      preferredLanguage: request.preferredLanguage === "en" ? "en" : "fi",
      ...(request.mediaToPlayheadOffsetMs !== undefined ? { mediaToPlayheadOffsetMs: request.mediaToPlayheadOffsetMs } : {}),
    });
  }
}
