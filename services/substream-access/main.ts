import { createAccessService } from './service.ts';

function port(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > 65535) throw new Error('invalid_port');
  return value;
}

async function main(): Promise<void> {
  const configPath = process.env.SUBSTREAM_ACCESS_CONFIG_FILE;
  if (!configPath) throw new Error('configuration_required');
  const service = await createAccessService({
    configPath,
    portalPort: port('SUBSTREAM_PORTAL_PORT', 8792),
    authPort: port('SUBSTREAM_AUTH_PORT', 8791),
  });
  await service.listen();
  process.stdout.write('Substream access service listening on loopback.\n');
  let stopping = false;
  const shutdown = () => {
    if (stopping) return;
    stopping = true;
    const deadline = setTimeout(() => process.exit(1), 10_000);
    deadline.unref();
    void service.close().then(() => clearTimeout(deadline)).catch(() => {
      process.stderr.write('Substream access service shutdown failed.\n');
      process.exitCode = 1;
    });
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

main().catch(() => {
  process.stderr.write('Substream access service startup failed. Check private configuration and storage.\n');
  process.exitCode = 1;
});
