import { chmod, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { preparePersonalRelay } from './live-relay-personal.ts';

// Metadata-only refresh on the trusted development computer. Never opens media.
try {
  if (!process.argv[2]) throw new Error();
  const path = resolve(process.argv[2]);
  const { config } = await preparePersonalRelay(process.cwd());
  // The verified provider account allows one connection. Keep hosted refreshes
  // from restoring the generic two-session default.
  await writeFile(path, JSON.stringify({ ...config, maxSessions: 1, sessionRoot: '/tmp/live-subtitle-relay/sessions' }), { mode: 0o600 });
  await chmod(path, 0o600);
  console.log(`Private hosted configuration refreshed: ${Object.keys(config.channels).length} Multi-Sub channels. Device credential preserved.`);
} catch {
  console.error('Hosted configuration refresh failed. Check private configuration, destination permissions and provider metadata access.');
  process.exitCode = 1;
}
