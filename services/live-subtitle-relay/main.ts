import { loadRelayConfig } from "./config.ts";
import { createRelayServer } from "./service.ts";

async function main(): Promise<void> {
  const configPath = process.env.RELAY_CONFIG_FILE;
  if (!configPath) throw new Error("configuration_required");
  const port = Number(process.env.RELAY_PORT ?? 8790);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("invalid_port");
  const config = await loadRelayConfig(configPath);
  const server = await createRelayServer(config, {
    onDiagnostic: (event) => process.stdout.write("[subtitle-relay] " + JSON.stringify(event) + "\n"),
  });
  let stopping = false;
  const shutdown = () => {
    if (stopping) return;
    stopping = true;
    const deadline = setTimeout(() => process.exit(1), 10_000);
    deadline.unref();
    void server.shutdown().then(() => { clearTimeout(deadline); })
      .catch(() => { process.stderr.write("Live subtitle relay shutdown failed.\n"); process.exitCode = 1; });
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, process.env.RELAY_HOST ?? "127.0.0.1", resolve);
  });
  // Never print config, request URLs, session capabilities, or underlying errors.
  process.stdout.write("Live subtitle relay listening.\n");
}

main().catch(() => {
  process.stderr.write("Live subtitle relay startup failed. Check private configuration and service availability.\n");
  process.exitCode = 1;
});
