import { readFile } from 'node:fs/promises';
import { isAbsolute, parse as parsePath } from 'node:path';

export interface RelayConfig {
  apiToken: string;
  channels: Record<string, string>;
  sessionRoot: string;
  maxSessions: number;
  sessionLeaseMs: number;
  prepareTimeoutMs: number;
  maxBodyBytes: number;
  allowedOrigins: string[];
  allowedRedirectHosts: string[];
  allowPublicRedirects?: boolean;
}

export interface RelayConfigInput {
  apiToken: string;
  channels: Record<string, string>;
  sessionRoot?: string;
  maxSessions?: number;
  sessionLeaseMs?: number;
  prepareTimeoutMs?: number;
  maxBodyBytes?: number;
  allowedOrigins?: string[];
  allowedRedirectHosts?: string[];
  allowPublicRedirects?: boolean;
}

const DEFAULTS = {
  sessionRoot: '/tmp/live-subtitle-relay/sessions',
  maxSessions: 2,
  sessionLeaseMs: 60_000,
  prepareTimeoutMs: 30_000,
  maxBodyBytes: 8 * 1024,
  allowedOrigins: [] as string[],
  allowedRedirectHosts: [] as string[],
};

export function validateRelayConfig(input: RelayConfigInput): RelayConfig {
  if (input.allowPublicRedirects !== undefined && typeof input.allowPublicRedirects !== 'boolean') throw new Error('invalid_config');
  if (typeof input.apiToken !== 'string' || !/^[a-f0-9]{64}$/.test(input.apiToken)) {
    throw new Error('invalid_config');
  }
  if (!input.channels || typeof input.channels !== 'object' || Array.isArray(input.channels)) {
    throw new Error('invalid_config');
  }
  const channels: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const [id, rawUrl] of Object.entries(input.channels)) {
    if (!/^[a-zA-Z0-9._-]{1,96}$/.test(id) || typeof rawUrl !== 'string') {
      throw new Error('invalid_config');
    }
    let url: URL;
    try {
      url = new URL(rawUrl);
    } catch {
      throw new Error('invalid_config');
    }
    if (!['http:', 'https:'].includes(url.protocol) || url.hostname.length === 0) {
      throw new Error('invalid_config');
    }
    channels[id] = url.toString();
  }
  const sessionRoot = input.sessionRoot ?? DEFAULTS.sessionRoot;
  if (!isAbsolute(sessionRoot) || parsePath(sessionRoot).root === sessionRoot) throw new Error('invalid_config');
  const allowedOrigins = input.allowedOrigins ?? DEFAULTS.allowedOrigins;
  if (!Array.isArray(allowedOrigins) || allowedOrigins.some((origin) => {
    if (origin === 'null') return false;
    try { const parsed = new URL(origin); return parsed.origin !== origin || !['http:', 'https:'].includes(parsed.protocol); }
    catch { return true; }
  })) throw new Error('invalid_config');
  const allowedRedirectHosts = input.allowedRedirectHosts ?? Object.values(channels).map((value) => new URL(value).hostname.toLowerCase());
  if (!Array.isArray(allowedRedirectHosts) || allowedRedirectHosts.some((host) => typeof host !== 'string' || host.length > 253 || !/^[a-zA-Z0-9.-]+$/.test(host))) throw new Error('invalid_config');
  return {
    apiToken: input.apiToken,
    channels,
    sessionRoot,
    maxSessions: positiveInt(input.maxSessions, DEFAULTS.maxSessions, 1, 32),
    sessionLeaseMs: positiveInt(input.sessionLeaseMs, DEFAULTS.sessionLeaseMs, 10_000, 10 * 60_000),
    prepareTimeoutMs: positiveInt(input.prepareTimeoutMs, DEFAULTS.prepareTimeoutMs, 1_000, 5 * 60_000),
    maxBodyBytes: positiveInt(input.maxBodyBytes, DEFAULTS.maxBodyBytes, 256, 64 * 1024),
    allowedOrigins,
    allowedRedirectHosts: allowedRedirectHosts.map((host) => host.toLowerCase()),
    ...(input.allowPublicRedirects !== undefined ? { allowPublicRedirects: input.allowPublicRedirects } : {}),
  };
}

function positiveInt(value: number | undefined, fallback: number, min: number, max: number): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error('invalid_config');
  return value;
}

/** Load the private JSON config. Callers should never print parse or file errors verbatim. */
export async function loadRelayConfig(path: string): Promise<RelayConfig> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
    const record = parsed as Record<string, unknown>;
    if ('allowPublicRedirects' in record && typeof record.allowPublicRedirects !== 'boolean') throw new Error();
    if (!record.channels || typeof record.channels !== 'object' || Array.isArray(record.channels)) throw new Error();
    for (const key of ['sessionRoot'] as const) if (key in record && typeof record[key] !== 'string') throw new Error();
    for (const key of ['maxSessions', 'sessionLeaseMs', 'prepareTimeoutMs', 'maxBodyBytes'] as const) if (key in record && typeof record[key] !== 'number') throw new Error();
    if ('allowedOrigins' in record && (!Array.isArray(record.allowedOrigins) || !record.allowedOrigins.every((x) => typeof x === 'string'))) throw new Error();
    if ('allowedRedirectHosts' in record && (!Array.isArray(record.allowedRedirectHosts) || !record.allowedRedirectHosts.every((x) => typeof x === 'string'))) throw new Error();
    return validateRelayConfig({
      apiToken: typeof record.apiToken === 'string' ? record.apiToken : '',
      channels: record.channels as Record<string, string>,
      ...(typeof record.allowPublicRedirects === 'boolean' ? { allowPublicRedirects: record.allowPublicRedirects } : {}),
      ...(typeof record.sessionRoot === 'string' ? { sessionRoot: record.sessionRoot } : {}),
      ...(typeof record.maxSessions === 'number' ? { maxSessions: record.maxSessions } : {}),
      ...(typeof record.sessionLeaseMs === 'number' ? { sessionLeaseMs: record.sessionLeaseMs } : {}),
      ...(typeof record.prepareTimeoutMs === 'number' ? { prepareTimeoutMs: record.prepareTimeoutMs } : {}),
      ...(typeof record.maxBodyBytes === 'number' ? { maxBodyBytes: record.maxBodyBytes } : {}),
      ...(Array.isArray(record.allowedOrigins)
        ? { allowedOrigins: record.allowedOrigins as string[] }
        : {}),
      ...(Array.isArray(record.allowedRedirectHosts)
        ? { allowedRedirectHosts: record.allowedRedirectHosts as string[] }
        : {}),
    });
  } catch {
    throw new Error('invalid_config');
  }
}
