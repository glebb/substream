import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadRelayConfig, validateRelayConfig } from './config.ts';

describe('live subtitle relay config', () => {
  it('accepts private API credentials and configured channel IDs without mutating URLs', () => {
    const config = validateRelayConfig({ apiToken: 'a'.repeat(64), channels: { 'sky-fi': 'https://stream.example/live?key=fixture' } });
    expect(config.channels['sky-fi']).toContain('https://stream.example/live?key=fixture');
    expect(config.allowedRedirectHosts).toEqual(['stream.example']);
  });

  it('rejects weak credentials, invalid protocols, and filesystem roots', () => {
    expect(() => validateRelayConfig({ apiToken: 'weak', channels: {} })).toThrow('invalid_config');
    expect(() => validateRelayConfig({ apiToken: 'a'.repeat(64), channels: { x: 'file:///etc/passwd' } })).toThrow('invalid_config');
    expect(() => validateRelayConfig({ apiToken: 'a'.repeat(64), channels: {}, sessionRoot: '/' })).toThrow('invalid_config');
  });

  it('accepts opaque widget origin only when explicitly configured', () => {
    const defaults = validateRelayConfig({ apiToken: 'a'.repeat(64), channels: {} });
    expect(defaults.allowedOrigins).toEqual([]);
    expect(validateRelayConfig({ apiToken: 'a'.repeat(64), channels: {}, allowedOrigins: ['null'] }).allowedOrigins).toEqual(['null']);
  });

  it('rejects malformed private JSON values instead of silently applying defaults', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'relay-config-test-'));
    const path = join(directory, 'relay-config.json');
    try {
      await writeFile(path, JSON.stringify({ apiToken: 'a'.repeat(64), channels: {}, maxSessions: '2' }));
      await expect(loadRelayConfig(path)).rejects.toThrow('invalid_config');
      await writeFile(path, JSON.stringify({ apiToken: 'a'.repeat(64), channels: {}, allowedOrigins: [4] }));
      await expect(loadRelayConfig(path)).rejects.toThrow('invalid_config');
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
});
