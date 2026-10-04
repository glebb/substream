import type { AppRuntime, AppRuntimeOverrides } from "../contracts/runtime.ts";
import type { PreferencesRepository, RuntimeFetch } from "../contracts/repository.ts";
import { BrowserTizenPlaybackPlayerFactory } from "../platform/player-factory.ts";
import { PlaybackReleaseBarrier } from "../application/playback-release-barrier.ts";
import { createIndexedDbCatalogRepositoryFactory } from "../platform/web/catalogue-repository.ts";
import { isTizenAvPlayAvailable } from "../platform/tizen/avplay-player.ts";
import { isTizenRuntime, registerTizenPlaybackKeys } from "../platform/tizen/remote.ts";

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
  const nativeVideoSurface = isTizenAvPlayAvailable();
  const previewTvProfile = typeof __SUBSTREAM_TV_UI_PREVIEW__ !== "undefined" && __SUBSTREAM_TV_UI_PREVIEW__;
  const playbackFactory = new BrowserTizenPlaybackPlayerFactory();
  const defaults: AppRuntime = {
    platform: tizen ? "tizen" : "browser",
    interactionProfile: tizen || previewTvProfile ? "tv" : "desktop",
    capabilities: {
      nativeVideoSurface,
      tvInput: tizen && Boolean((globalThis as typeof globalThis & { tizen?: { tvinputdevice?: unknown } }).tizen?.tvinputdevice),
      supportsLocalMediaPicker: !tizen,
      directGuideRequests: tizen,
      supportsCompanion: true,
      supportsLiveRelay: nativeVideoSurface,
    },
    input: { registerKeys: registerTizenPlaybackKeys },
    transport: { fetch: browserFetch },
    preferences: localPreferences,
    playbackFactory,
    playbackRelease: new PlaybackReleaseBarrier(),
    catalogue: createIndexedDbCatalogRepositoryFactory(),
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
