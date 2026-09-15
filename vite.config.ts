import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import legacy from "@vitejs/plugin-legacy";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const apiKey = env.OPENSUBTITLES_API_KEY;
  const isPersonalBuild = process.env.PERSONAL_BUILD === "1";
  const tizenCompatibilityTarget = process.env.TIZEN_COMPAT_TARGET;
  if (tizenCompatibilityTarget !== undefined && tizenCompatibilityTarget !== "tizen6") {
    throw new Error("TIZEN_COMPAT_TARGET must be tizen6 when it is set");
  }
  if (isPersonalBuild && (!env.IPTV_M3U_URL || !apiKey)) {
    throw new Error("Personal builds require IPTV_M3U_URL and OPENSUBTITLES_API_KEY in .env");
  }
  const packageDefaults = isPersonalBuild
    ? { playlistUrl: env.IPTV_M3U_URL, openSubtitlesApiKey: apiKey }
    : {};
  return {
    base: "./",
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
      proxy: apiKey ? {
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
      } : {},
    },
  };
});
