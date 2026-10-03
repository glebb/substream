import { classifyMultiSubChannel } from "../../core/live/multi-sub-relay.ts";

/** Relay settings may come from an explicit device override or a private Tizen build. */
export type LiveRelayConfig = {
  serviceUrl: string;
  deviceCredential: string;
  enabled?: boolean;
  allowLanHttp?: boolean;
  channelMappings?: Record<string, string>;
  offsetMs?: number;
  diagnosticsEnabled?: boolean;
};
export type NormalizedLiveRelayConfig = Required<LiveRelayConfig>;

interface KeyValueStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

const STORAGE_KEY = "substream.live-relay-config";
const DISABLED_SENTINEL = "__disabled__";
const DEVICE_CREDENTIAL_RE = /^[a-f0-9]{64}$/i;

function browserStorage(): KeyValueStorage | null {
  try { return globalThis.localStorage ?? null; } catch { return null; }
}

function isPrivateIpv4(hostname: string): boolean {
  if (!/^\d{1,3}(?:\.\d{1,3}){3}$/.test(hostname)) return false;
  const parts = hostname.split(".").map(Number);
  if (parts.some((part) => part < 0 || part > 255)) return false;
  const [a, b] = parts;
  return a === 10 || a === 172 && b! >= 16 && b! <= 31 || a === 192 && b === 168;
}

/** Accept HTTPS by default; opted-in LAN HTTP is limited to private IPv4 addresses. */
export function normalizeLiveRelayServiceUrl(value: string, allowLanHttp = false): string {
  const trimmed = value.trim();
  let url: URL;
  try { url = new URL(trimmed); } catch { throw new Error("Enter a valid live subtitle relay address."); }
  const loopback = /^(localhost|127(?:\.\d{1,3}){3}|\[?::1\]?)$/i.test(url.hostname);
  const lanHttp = url.protocol === "http:" && allowLanHttp && isPrivateIpv4(url.hostname);
  if ((url.protocol !== "https:" && !(url.protocol === "http:" && loopback) && !lanHttp) || url.username || url.password
    || url.search || url.hash || (url.pathname !== "/" && url.pathname !== "")) {
    throw new Error("Live subtitle relay address must be an HTTPS origin, or opted-in HTTP to a private LAN IPv4 address, without credentials or a path.");
  }
  return url.origin;
}

export function normalizeLiveRelayConfig(value: Partial<LiveRelayConfig>): NormalizedLiveRelayConfig {
  const allowLanHttp = value.allowLanHttp === true;
  const serviceUrl = normalizeLiveRelayServiceUrl(typeof value.serviceUrl === "string" ? value.serviceUrl : "", allowLanHttp);
  const deviceCredential = typeof value.deviceCredential === "string" ? value.deviceCredential.trim().toLowerCase() : "";
  if (!DEVICE_CREDENTIAL_RE.test(deviceCredential)) throw new Error("Enter a valid live subtitle relay device credential.");
  const channelMappings: Record<string, string> = {};
  if (value.channelMappings !== undefined) {
    if (!value.channelMappings || typeof value.channelMappings !== "object" || Array.isArray(value.channelMappings) || Object.keys(value.channelMappings).length > 64) throw new Error("Enter a JSON object with no more than 64 channel mappings.");
    for (const [providerStreamId, channelId] of Object.entries(value.channelMappings)) {
      if (!/^[a-zA-Z0-9_.:-]{1,128}$/.test(providerStreamId) || typeof channelId !== "string" || !/^[a-zA-Z0-9._-]{1,96}$/.test(channelId)) {
        throw new Error("Channel mappings need relay IDs with 1–96 letters, numbers, dots, underscores, or hyphens.");
      }
      channelMappings[providerStreamId] = channelId;
    }
  }
  const offsetMs = value.offsetMs === undefined ? 0 : Number(value.offsetMs);
  if (!Number.isInteger(offsetMs) || offsetMs < -10_000 || offsetMs > 10_000) throw new Error("Timing offset must be a whole number from -10000 to 10000 milliseconds.");
  return {
    enabled: value.enabled === true,
    serviceUrl,
    deviceCredential,
    allowLanHttp,
    channelMappings,
    offsetMs,
    diagnosticsEnabled: value.diagnosticsEnabled !== false,
  };
}

/** Resolves a provider stream to its explicitly configured relay channel ID. */
export function relayChannelId(config: LiveRelayConfig, providerStreamId: string | number, channelName?: string): string | null {
  const id = String(providerStreamId);
  // Explicit mappings take precedence, including a manual mapping to another
  // relay channel. The automatic provider convention covers Multi-Sub titles.
  const manual = config.channelMappings?.[id];
  return manual ?? (channelName ? classifyMultiSubChannel(channelName, id).channelId : null);
}

function bundledDefaults(): NormalizedLiveRelayConfig | null {
  try {
    if (typeof __PERSONAL_LIVE_RELAY_DEFAULTS__ === "undefined" || !__PERSONAL_LIVE_RELAY_DEFAULTS__) return null;
    return normalizeLiveRelayConfig(__PERSONAL_LIVE_RELAY_DEFAULTS__);
  } catch { return null; }
}

/** Stored settings override build defaults; removing settings is an explicit opt-out. */
export function loadLiveRelayConfig(storage: KeyValueStorage | null = browserStorage()): NormalizedLiveRelayConfig | null {
  try {
    const raw = storage?.getItem(STORAGE_KEY);
    if (raw === DISABLED_SENTINEL) return null;
    if (!raw) return bundledDefaults();
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return normalizeLiveRelayConfig(parsed as Partial<LiveRelayConfig>);
  } catch { return null; }
}

/** Persist only the explicitly entered endpoint and device-scoped credential. */
export function saveLiveRelayConfig(value: Partial<LiveRelayConfig>, storage: KeyValueStorage | null = browserStorage()): NormalizedLiveRelayConfig {
  const config = normalizeLiveRelayConfig(value);
  if (!storage) throw new Error("Live subtitle relay settings could not be saved on this device.");
  try { storage.setItem(STORAGE_KEY, JSON.stringify(config)); }
  catch { throw new Error("Live subtitle relay settings could not be saved on this device."); }
  return config;
}

export function clearLiveRelayConfig(storage: KeyValueStorage | null = browserStorage()): void {
  // Persist an explicit opt-out so personal defaults can be disabled from the
  // settings screen. With no storage available, removing remains best effort.
  try { storage?.setItem(STORAGE_KEY, DISABLED_SENTINEL); } catch { /* Removing local credentials is best effort. */ }
}
