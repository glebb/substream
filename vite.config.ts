import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const apiKey = env.OPENSUBTITLES_API_KEY;
  return {
    base: "./",
    plugins: [react()],
    server: {
      proxy: apiKey ? {
        "/opensubtitles-api": {
          changeOrigin: true,
          followRedirects: true,
          configure: (proxy) => {
            proxy.on("proxyReq", (request) => {
              request.setHeader("Api-Key", apiKey);
              request.setHeader("User-Agent", "my-m3u v0.1.0");
            });
          },
          rewrite: (path) => path.replace(/^\/opensubtitles-api/, ""),
          target: "https://api.opensubtitles.com",
        },
      } : undefined,
    },
  };
});
