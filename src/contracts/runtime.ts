import type { PlaybackPlayerFactory } from "../platform/media-player.ts";
import type { PlaybackReleaseBarrier } from "../application/playback-release-barrier.ts";
import type { CatalogueRepositoryFactory, PreferencesRepository, TransportRepository } from "./repository.ts";

export type RuntimePlatform = "browser" | "tizen";
export type InteractionProfile = "desktop" | "tv";

export interface RuntimeCapabilities {
  nativeVideoSurface: boolean;
  tvInput: boolean;
  supportsLocalMediaPicker: boolean;
  directGuideRequests: boolean;
  supportsCompanion: boolean;
  supportsLiveRelay: boolean;
}

export interface AppRuntime {
  platform: RuntimePlatform;
  interactionProfile: InteractionProfile;
  capabilities: RuntimeCapabilities;
  input: { registerKeys(): void };
  playbackFactory: PlaybackPlayerFactory;
  playbackRelease: PlaybackReleaseBarrier;
  transport: TransportRepository;
  preferences: PreferencesRepository;
  catalogue: CatalogueRepositoryFactory;
  subtitleDiscovery?: { discover(streamUrl: string, signal?: AbortSignal): Promise<import("../platform/browser/embedded-subtitle-discovery.ts").EmbeddedSubtitleDiscoveryResult> };
}

/** Narrow overrides let platforms and tests replace device services without changing app code. */
export type AppRuntimeOverrides = Partial<Omit<AppRuntime, "capabilities" | "input" | "transport" | "preferences" | "playbackFactory" | "catalogue">> & {
  capabilities?: Partial<RuntimeCapabilities>;
  input?: Partial<AppRuntime["input"]>;
  transport?: Partial<TransportRepository>;
  preferences?: PreferencesRepository;
  playbackFactory?: PlaybackPlayerFactory;
  catalogue?: CatalogueRepositoryFactory;
};
