export interface PackageDefaults {
  playlistUrl?: string;
  openSubtitlesApiKey?: string;
}

declare const __MY_M3U_PACKAGE_DEFAULTS__: PackageDefaults;

// Vite replaces this value during every build. Standard browser and Tizen
// builds receive an empty object; only the opt-in personal Tizen build embeds
// local .env values into the package.
export const packageDefaults: PackageDefaults = __MY_M3U_PACKAGE_DEFAULTS__;
