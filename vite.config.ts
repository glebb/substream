import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import legacy from "@vitejs/plugin-legacy";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const apiKey = env.OPENSUBTITLES_API_KEY;
  const isPersonalBuild = process.env.PERSONAL_BUILD === "1";
  if (isPersonalBuild && (!env.IPTV_M3U_URL || !apiKey)) {
    throw new Error("Personal builds require IPTV_M3U_URL and OPENSUBTITLES_API_KEY in .env");
  }
  const packageDefaults = isPersonalBuild
    ? { playlistUrl: env.IPTV_M3U_URL, openSubtitlesApiKey: apiKey }
    : {};
  return {
    base: "./",
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
