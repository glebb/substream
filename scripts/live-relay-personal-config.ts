import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { networkInterfaces } from "node:os";
import { join } from "node:path";
import { parseEnv } from "node:util";

export function privateLanIpv4(value: string): boolean {
  const parts = value.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  return parts[0] === 10 || parts[0] === 192 && parts[1] === 168 || parts[0] === 172 && parts[1]! >= 16 && parts[1]! <= 31;
}

/** Select the Mac's usual Wi-Fi/Ethernet interface before virtual interfaces. */
export function personalRelayLanAddress(interfaces = networkInterfaces()): string {
  const names = Object.keys(interfaces).sort((a, b) => Number(!/^en\d+$/.test(a)) - Number(!/^en\d+$/.test(b)) || a.localeCompare(b));
  for (const name of names) {
    const address = interfaces[name]?.find((entry) => !entry.internal && entry.family === "IPv4" && privateLanIpv4(entry.address));
    if (address) return address.address;
  }
  throw new Error("No private LAN IPv4 address found. Connect this Mac to the TV's network or set LIVE_SUBTITLE_RELAY_URL.");
}

/** Private defaults shared by the foreground service and personal TV builds. */
export function ensurePersonalRelayEnvironment(root: string, overrides: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const path = join(root, ".env.live-relay");
  const saved = existsSync(path) ? parseEnv(readFileSync(path, "utf8")) : {};
  const values = { ...saved };
  for (const [key, value] of Object.entries(overrides)) if (key.startsWith("LIVE_SUBTITLE_RELAY_") && value !== undefined) values[key] = value;
  const token = values.LIVE_SUBTITLE_RELAY_TOKEN || randomBytes(32).toString("hex");
  if (!/^[a-f0-9]{64}$/i.test(token)) throw new Error("Invalid LIVE_SUBTITLE_RELAY_TOKEN in private relay configuration.");
  const port = values.LIVE_SUBTITLE_RELAY_PORT || "8790";
  if (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535) throw new Error("Invalid LIVE_SUBTITLE_RELAY_PORT.");
  const serviceUrl = values.LIVE_SUBTITLE_RELAY_URL || `http://${personalRelayLanAddress()}:${port}`;
  let url: URL;
  try { url = new URL(serviceUrl); } catch { throw new Error("Invalid LIVE_SUBTITLE_RELAY_URL."); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error("LIVE_SUBTITLE_RELAY_URL must be an origin without credentials.");
  const defaults: Record<string, string> = {
    LIVE_SUBTITLE_RELAY_ENABLED: "1",
    LIVE_SUBTITLE_RELAY_ALLOW_LAN_HTTP: url.protocol === "http:" ? "1" : "0",
    LIVE_SUBTITLE_RELAY_ALLOWED_ORIGINS: "null",
    LIVE_SUBTITLE_RELAY_HOST: "0.0.0.0",
    LIVE_SUBTITLE_RELAY_PORT: port,
    LIVE_SUBTITLE_RELAY_URL: url.origin,
    LIVE_SUBTITLE_RELAY_TOKEN: token.toLowerCase(),
  };
  const result = { ...defaults, ...values, LIVE_SUBTITLE_RELAY_TOKEN: token.toLowerCase(), LIVE_SUBTITLE_RELAY_URL: url.origin };
  // Persist generated fields once so build/start order never rotates credentials.
  if (!existsSync(path) || !saved.LIVE_SUBTITLE_RELAY_TOKEN || !saved.LIVE_SUBTITLE_RELAY_URL) {
    const content = "# Private local subtitle relay configuration. Never share or commit.\n"
      + Object.entries(result).map(([key, value]) => `${key}=${JSON.stringify(value)}`).join("\n") + "\n";
    writeFileSync(path, content, { mode: 0o600 });
    chmodSync(path, 0o600);
  }
  return result;
}
