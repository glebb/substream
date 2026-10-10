import { isIP } from "node:net";

/** Build-time app defaults for LG, isolated from device-management settings. */
export function createWebosPackageDefaults(env, { personal = false, publicBuild = false, webos = false } = {}) {
  if (publicBuild) return {};
  let companionServerUrl = env.COMPANION_SERVER_URL;
  if (webos && personal && env.LG_WEBOS_LOCAL_IP) {
    const host = env.LG_WEBOS_LOCAL_IP.trim();
    const ipVersion = isIP(host);
    const validHostname = host.length <= 253
      && host.split(".").every((label) => label.length > 0 && label.length <= 63
        && /^[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?$/.test(label));
    if (!ipVersion && !validHostname) {
      throw new Error("LG_WEBOS_LOCAL_IP must be an IP address or hostname without credentials, path, query, or port");
    }

    let protocol = "http:";
    let port = "8787";
    if (env.COMPANION_SERVER_URL) {
      let configured;
      try {
        configured = new URL(env.COMPANION_SERVER_URL);
      } catch {
        throw new Error("COMPANION_SERVER_URL must be a valid HTTP or HTTPS URL when using LG_WEBOS_LOCAL_IP");
      }
      if (configured.protocol !== "http:" && configured.protocol !== "https:") {
        throw new Error("COMPANION_SERVER_URL must use HTTP or HTTPS when using LG_WEBOS_LOCAL_IP");
      }
      protocol = configured.protocol;
      port = configured.port || (protocol === "https:" ? "443" : "80");
    }
    const formattedHost = ipVersion === 6 ? `[${host}]` : host;
    companionServerUrl = `${protocol}//${formattedHost}:${port}`;
  }
  return {
    ...(companionServerUrl ? { companionServerUrl } : {}),
    ...(personal ? {
      playlistUrl: env.IPTV_M3U_URL,
      openSubtitlesApiKey: env.OPENSUBTITLES_API_KEY,
      tmdbApiReadAccessToken: env.TMDB_API_READ_ACCESS_TOKEN,
      tmdbApiKey: env.TMDB_API_KEY,
    } : {}),
  };
}
