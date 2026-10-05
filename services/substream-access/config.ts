import { readFile } from 'node:fs/promises';
import { isAbsolute } from 'node:path';

export interface AccessConfig {
  googleClientId: string;
  googleClientSecret: string;
  allowedEmails: string[];
  portalOrigin: string;
  playerOrigin: string;
  databasePath: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function parseOrigin(value: unknown, protocol: 'https:' | 'http:'): string {
  if (typeof value !== 'string') throw new Error('invalid_config');
  let parsed: URL;
  try { parsed = new URL(value); } catch { throw new Error('invalid_config'); }
  if (parsed.protocol !== protocol || parsed.origin !== value || parsed.username || parsed.password) {
    throw new Error('invalid_config');
  }
  return parsed.origin;
}

export function validateAccessConfig(input: unknown): AccessConfig {
  if (!isRecord(input)) throw new Error('invalid_config');
  const googleClientId = input.googleClientId;
  const googleClientSecret = input.googleClientSecret;
  const databasePath = input.databasePath;
  if (typeof googleClientId !== 'string' || googleClientId.length < 8 || googleClientId.length > 512 ||
      typeof googleClientSecret !== 'string' || googleClientSecret.length < 8 || googleClientSecret.length > 512 ||
      typeof databasePath !== 'string' || !isAbsolute(databasePath) || databasePath.length > 2048 ||
      !Array.isArray(input.allowedEmails) || input.allowedEmails.length > 1000 ||
      !input.allowedEmails.every((email) => typeof email === 'string' && email.length <= 320 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))) {
    throw new Error('invalid_config');
  }
  const allowedEmails = [...new Set((input.allowedEmails as string[]).map((email) => email.trim().toLowerCase()))];
  return {
    googleClientId,
    googleClientSecret,
    allowedEmails,
    portalOrigin: parseOrigin(input.portalOrigin, 'https:'),
    playerOrigin: parseOrigin(input.playerOrigin, 'http:'),
    databasePath,
  };
}

/** Load config without exposing path, parse, or secret details to callers. */
export async function loadAccessConfig(path: string): Promise<AccessConfig> {
  try {
    return validateAccessConfig(JSON.parse(await readFile(path, 'utf8')) as unknown);
  } catch {
    throw new Error('invalid_config');
  }
}
