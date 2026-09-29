import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { Server as HttpsServer } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCompanionCertificate } from "./create-companion-cert.mjs";
import { createCompanionServer } from "./companion-server.mjs";

let directory = "";
let server;

afterEach(async () => {
  if (server?.listening) await new Promise((resolve) => server.close(resolve));
  server = undefined;
  if (directory) await rm(directory, { recursive: true, force: true });
  directory = "";
});

describe("companion TLS listener", () => {
  it("builds an HTTPS listener from a self-signed certificate", async () => {
    directory = await mkdtemp(join(tmpdir(), "companion-tls-test-"));
    const paths = createCompanionCertificate("127.0.0.1", directory);
    server = createCompanionServer({ cert: await readFile(paths.certPath), key: await readFile(paths.keyPath) });
    expect(server).toBeInstanceOf(HttpsServer);
    expect(server.listening).toBe(false);
  });

  it("rejects a certificate without its matching private key", () => {
    expect(() => createCompanionServer({ cert: Buffer.from("synthetic") })).toThrow("requires both certificate and private key");
  });
});
