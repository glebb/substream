import { mkdir, writeFile, chmod } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { parseEnv } from "node:util";
import { classifyMultiSubChannel } from "../src/core/live/multi-sub-relay.ts";
import { validateRelayConfig, type RelayConfig } from "../services/live-subtitle-relay/config.ts";
import { ensurePersonalRelayEnvironment } from "./live-relay-personal-config.ts";

type LiveRecord = { stream_id?: unknown; name?: unknown };
const MAX_METADATA_BYTES = 32 * 1024 * 1024;

/** Discover every marked live channel; this never opens a live media connection. */
export async function discoverPersonalRelayChannels(playlistUrl: string, request: typeof fetch = fetch): Promise<Record<string, string>> {
  const playlist = new URL(playlistUrl);
  const username = playlist.searchParams.get("username");
  const password = playlist.searchParams.get("password");
  if (!['http:', 'https:'].includes(playlist.protocol) || !/\/get\.php$/i.test(playlist.pathname) || !username || !password) throw new Error("Personal relay requires an Xtream playlist in .env.");
  const api = new URL(playlist.pathname.replace(/get\.php$/i, "player_api.php"), playlist.origin);
  api.search = new URLSearchParams({ username, password, action: "get_live_streams" }).toString();
  const response = await request(api, { signal: AbortSignal.timeout(60_000) });
  if (!response.ok || !response.body) throw new Error("Provider channel discovery failed.");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_METADATA_BYTES) throw new Error("Provider channel metadata exceeds the relay limit.");
      chunks.push(value);
    }
  } finally { await reader.cancel().catch(() => undefined); }
  const records: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (!Array.isArray(records)) throw new Error("Invalid provider channel metadata.");
  const channels: Record<string, string> = Object.create(null) as Record<string, string>;
  const base = playlist.origin + playlist.pathname.slice(0, playlist.pathname.lastIndexOf('/') + 1);
  for (const record of records as LiveRecord[]) {
    if (!record || typeof record !== "object" || typeof record.name !== "string") continue;
    const id = String(record.stream_id ?? "");
    if (!/^\d{1,20}$/.test(id)) continue;
    const classified = classifyMultiSubChannel(record.name, id);
    if (classified.channelId) channels[classified.channelId] = `${base}live/${encodeURIComponent(username)}/${encodeURIComponent(password)}/${id}.ts`;
  }
  if (!Object.keys(channels).length) throw new Error("No Multi-Sub live channels found in provider metadata.");
  return channels;
}

export async function preparePersonalRelay(root: string): Promise<{ config: RelayConfig; configPath: string; host: string; port: number }> {
  const env = { ...parseEnv(readFileSync(join(root, ".env"), "utf8")), ...process.env };
  const local = ensurePersonalRelayEnvironment(root);
  const channels = await discoverPersonalRelayChannels(env.IPTV_M3U_URL || "");
  const directory = join(root, ".live-subtitle-relay");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  const config = validateRelayConfig({
    apiToken: local.LIVE_SUBTITLE_RELAY_TOKEN!, channels,
    // Destinations are still vetted and DNS-pinned at every hop. Explicit
    // host overrides restore the stricter manually configured policy.
    allowPublicRedirects: !local.LIVE_SUBTITLE_RELAY_REDIRECT_HOSTS,
    allowedOrigins: (local.LIVE_SUBTITLE_RELAY_ALLOWED_ORIGINS || "null").split(',').map((value) => value.trim()).filter(Boolean),
    ...(local.LIVE_SUBTITLE_RELAY_REDIRECT_HOSTS ? { allowedRedirectHosts: local.LIVE_SUBTITLE_RELAY_REDIRECT_HOSTS.split(',').map((value) => value.trim()).filter(Boolean) } : {}),
  });
  const configPath = join(directory, "config.json");
  await writeFile(configPath, JSON.stringify(config), { mode: 0o600 });
  await chmod(configPath, 0o600);
  return { config, configPath, host: local.LIVE_SUBTITLE_RELAY_HOST!, port: Number(local.LIVE_SUBTITLE_RELAY_PORT) };
}

async function main(): Promise<void> {
  const root = fileURLToPath(new URL("../", import.meta.url));
  const prepared = await preparePersonalRelay(root);
  process.stdout.write(`Personal subtitle relay configured for ${Object.keys(prepared.config.channels).length} Multi-Sub channels.\n`);
  process.env.RELAY_CONFIG_FILE = prepared.configPath;
  process.env.RELAY_HOST = prepared.host;
  process.env.RELAY_PORT = String(prepared.port);
  await import("../services/live-subtitle-relay/main.ts");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) void main().catch(() => {
  process.stderr.write("Personal subtitle relay setup failed. Check .env, .env.live-relay, provider metadata access, and this Mac's network.\n");
  process.exitCode = 1;
});
