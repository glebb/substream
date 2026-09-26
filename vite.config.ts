import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import legacy from "@vitejs/plugin-legacy";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const apiKey = env.OPENSUBTITLES_API_KEY;
  const tmdbApiReadAccessToken = env.TMDB_API_READ_ACCESS_TOKEN;
  const tmdbApiKey = env.TMDB_API_KEY;
  const companionServerUrl = env.COMPANION_SERVER_URL;
  const isPersonalBuild = process.env.PERSONAL_BUILD === "1";
  const useLocalProviderProxy = process.env.CHROMIUM47_PREVIEW === "1";
  const tizenCompatibilityTarget = process.env.TIZEN_COMPAT_TARGET;
  if (tizenCompatibilityTarget !== undefined && tizenCompatibilityTarget !== "tizen6") {
    throw new Error("TIZEN_COMPAT_TARGET must be tizen6 when it is set");
  }
  if (isPersonalBuild && (!env.IPTV_M3U_URL || !apiKey || (!tmdbApiReadAccessToken && !tmdbApiKey))) {
    throw new Error("Personal builds require IPTV_M3U_URL, OPENSUBTITLES_API_KEY, and TMDB_API_READ_ACCESS_TOKEN or TMDB_API_KEY in .env");
  }
  const packageDefaults = {
    ...(companionServerUrl ? { companionServerUrl } : {}),
    ...(isPersonalBuild
      ? { playlistUrl: env.IPTV_M3U_URL, openSubtitlesApiKey: apiKey, tmdbApiReadAccessToken, tmdbApiKey }
      : {}),
  };
  return {
    base: "./",
    // The optional DVB decoder uses a module worker so its WASM decoder and
    // worker-only dependencies never enter the browser UI bundle.
    worker: { format: "es" },
    // libbitsub resolves its DVB decoder WASM relative to its own module URL.
    // Keeping it out of Vite's development prebundle preserves that package
    // relationship; production builds still emit a hashed WASM asset.
    optimizeDeps: { exclude: ["libbitsub"] },
    // Keep the default build unchanged for the existing Tizen 3 package. The
    // Tizen 6 package uses a CSS target appropriate for its Chromium M76 engine.
    ...(tizenCompatibilityTarget === "tizen6" ? {
      build: {
        cssTarget: "chrome76",
      },
    } : {}),
    // Values are only embedded by the explicit personal-TV command. Never use
    // VITE_ variables for them: that would expose them in every browser build.
    define: {
      __SUBSTREAM_PACKAGE_DEFAULTS__: JSON.stringify(packageDefaults),
      __SUBSTREAM_LOCAL_PROVIDER_PROXY__: JSON.stringify(useLocalProviderProxy),
      __SUBSTREAM_TV_UI_PREVIEW__: JSON.stringify(useLocalProviderProxy),
    },
    // UE75MU8005 is a 2017 TV running Tizen 3.0 (Chromium M47), which has
    // no ES-module support. Emit a SystemJS-compatible legacy bundle and
    // automatically include only the polyfills referenced by application code.
    plugins: [
      react(),
      legacy({
        targets: ["Chrome >= 47"],
        // Tizen 6 advertises support for module scripts, but when its modern
        // entry fails Vite's feature probe still prevents the legacy fallback
        // from loading. Ship only the tested SystemJS-compatible entry for
        // this package, avoiding that false-positive path altogether.
        ...(tizenCompatibilityTarget === "tizen6" ? { renderModernChunks: false } : {}),
        polyfills: true,
      }),
    ],
    server: {
      proxy: {
        // Keep local web development convenient while the actual TV relay runs
        // as a separate process. Browser Settings can still point at any LAN
        // relay explicitly; that address bypasses this same-origin proxy.
        "/api": {
          changeOrigin: true,
          target: companionServerUrl || "http://127.0.0.1:8787",
        },
        // TMDb does not permit browser-origin requests in all environments.
        // This development-only proxy keeps the browser request same-origin;
        // the client still supplies its bearer token/API key in the request.
        "/tmdb-api": {
          changeOrigin: true,
          followRedirects: true,
          rewrite: (path) => path.replace(/^\/tmdb-api/, "/3"),
          target: "https://api.themoviedb.org",
        },
        ...(apiKey ? {
        "/opensubtitles-api": {
          changeOrigin: true,
          followRedirects: true,
          configure: (proxy) => {
            proxy.on("proxyReq", (request) => {
              request.setHeader("Api-Key", apiKey);
              request.setHeader("User-Agent", "substream v0.1.0");
            });
          },
          rewrite: (path) => path.replace(/^\/opensubtitles-api/, ""),
          target: "https://api.opensubtitles.com",
        },
        } : {}),
    },
    },
  };
});
