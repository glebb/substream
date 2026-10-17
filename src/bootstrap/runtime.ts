import type { AppRuntime, AppRuntimeOverrides } from "../contracts/runtime.ts";
import type { PreferencesRepository, RuntimeFetch } from "../contracts/repository.ts";
import { BrowserTizenPlaybackPlayerFactory } from "../platform/player-factory.ts";
import { PlaybackReleaseBarrier } from "../application/playback-release-barrier.ts";
import { createIndexedDbCatalogRepositoryFactory } from "../platform/web/catalogue-repository.ts";
import { isTizenAvPlayAvailable } from "../platform/tizen/avplay-player.ts";
import { isTizenRuntime, registerTizenPlaybackKeys } from "../platform/tizen/remote.ts";

import { discoverTizenEmbeddedSubtitles } from "../platform/tizen/embedded-subtitle-discovery.ts";
import { AndroidPlaybackPlayerFactory } from "../platform/android/player-factory.ts";
import { isAndroidRuntime } from "../platform/android/runtime.ts";
import { androidFetch } from "../platform/android/native-fetch.ts";
import { WebOsPlaybackPlayerFactory } from "../platform/webos/player-factory.ts";
import { invokeWebOsPlatformBack, isWebOsKeyboardVisible, isWebOsRuntime, registerWebOsPlaybackKeys } from "../platform/webos/runtime.ts";

import { stableId } from "../core/catalog/normalize.ts";
import { discoverEmbeddedSubtitles, EmbeddedSubtitleMetadataCache } from "../platform/browser/embedded-subtitle-discovery.ts";

const localPreferences: PreferencesRepository = {
  get(key) {
    try { return globalThis.localStorage?.getItem(key) ?? null; } catch { return null; }
  },
  set(key, value) {
    try { globalThis.localStorage?.setItem(key, value); } catch { /* Storage may be unavailable in private contexts. */ }
  },
  remove(key) {
    try { globalThis.localStorage?.removeItem(key); } catch { /* Storage may be unavailable in private contexts. */ }
  },
};

const browserFetch: RuntimeFetch = (input, init) => globalThis.fetch(input, init);

/** Platform detection and global APIs stay at the application composition boundary. */
export function createAppRuntime(overrides: AppRuntimeOverrides = {}): AppRuntime {
  const tizen = isTizenRuntime();
  const webos = !tizen && isWebOsRuntime();
  const android = !tizen && !webos && isAndroidRuntime();
  const nativeVideoSurface = android || (!webos && isTizenAvPlayAvailable());
  const previewTvProfile = typeof __SUBSTREAM_TV_UI_PREVIEW__ !== "undefined" && __SUBSTREAM_TV_UI_PREVIEW__;
  const touchProfile = typeof globalThis.matchMedia === "function" && globalThis.matchMedia("(pointer: coarse) and (hover: none)").matches;
  const playbackFactory = android
    ? new AndroidPlaybackPlayerFactory()
    : webos
    ? new WebOsPlaybackPlayerFactory()
    : new BrowserTizenPlaybackPlayerFactory();
  const preferences = overrides.preferences ?? localPreferences;
  const subtitleCache = new EmbeddedSubtitleMetadataCache({ getItem: (key) => preferences.get(key), setItem: (key, value) => preferences.set(key, value) });
  const defaults: AppRuntime = {
    platform: tizen ? "tizen" : webos ? "webos" : android ? "android" : "browser",
    interactionProfile: tizen || webos || android || previewTvProfile ? "tv" : touchProfile ? "touch" : "desktop",
    capabilities: {
      nativeVideoSurface,
      tvInput: android || webos || (tizen && Boolean((globalThis as typeof globalThis & { tizen?: { tvinputdevice?: unknown } }).tizen?.tvinputdevice)),
      supportsLocalMediaPicker: !tizen && !webos && !android,
      directGuideRequests: tizen || webos || android,
      supportsCompanion: true,
      supportsLiveRelay: !webos && !android && nativeVideoSurface,
      // LG's native progressive pipeline exhausts memory on long companion files; HLS stays bounded.
      companionLocalMediaTransport: webos ? "hls" : "progressive",
    },
    input: {
      registerKeys: webos ? registerWebOsPlaybackKeys : registerTizenPlaybackKeys,
      ...(webos ? { platformBack: invokeWebOsPlatformBack, isKeyboardVisible: isWebOsKeyboardVisible } : {}),
    },
    transport: { fetch: android ? androidFetch : browserFetch },
    preferences,
    playbackFactory,
    playbackRelease: new PlaybackReleaseBarrier(),
    catalogue: createIndexedDbCatalogRepositoryFactory(),
    subtitleDiscovery: { discover: async (url, signal) => {
      const cacheKey = stableId(url);
      const cached = subtitleCache.get(cacheKey, "media");
      if (cached) return cached;
      const result = tizen && !overrides.transport?.fetch
        ? await discoverTizenEmbeddedSubtitles(url, signal)
        : await discoverEmbeddedSubtitles(url, signal, (input, init) => (overrides.transport?.fetch ?? browserFetch)(input, init));
      subtitleCache.set(cacheKey, "media", result);
      return result;
    } },
  };
  return {
    ...defaults,
    ...overrides,
    capabilities: { ...defaults.capabilities, ...overrides.capabilities },
    input: { ...defaults.input, ...overrides.input },
    transport: { ...defaults.transport, ...overrides.transport },
    playbackFactory: overrides.playbackFactory ?? playbackFactory,
    catalogue: overrides.catalogue ?? defaults.catalogue,
  };
}
