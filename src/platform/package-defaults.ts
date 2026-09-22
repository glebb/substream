export interface PackageDefaults {
  playlistUrl?: string;
  openSubtitlesApiKey?: string;
  tmdbApiReadAccessToken?: string;
  tmdbApiKey?: string;
  /** A non-secret LAN address used by the optional companion service. */
  companionServerUrl?: string;
}

declare const __SUBSTREAM_PACKAGE_DEFAULTS__: PackageDefaults;

// Vite replaces this value during every build. Personal provider credentials
// are embedded only by the opt-in personal build. The companion server address
// is intentionally non-secret and may be included in any local build.
export const packageDefaults: PackageDefaults = __SUBSTREAM_PACKAGE_DEFAULTS__;
