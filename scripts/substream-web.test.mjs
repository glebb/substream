import { promises as fs } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { auditPublicFiles, auditTarArchive, collectPublicFiles, createManifest, createPublicArchive } from "./substream-web.mjs";
import { auditFiles as auditAccessFiles } from "../deploy/substream-access/package.mjs";

const nginxAvailable = process.platform === "linux"
  && spawnSync("nginx", ["-v"], { encoding: "utf8" }).status === 0;
const pythonAvailable = spawnSync("python3", ["--version"], { encoding: "utf8" }).status === 0;
const opensslAvailable = spawnSync("openssl", ["version"], { encoding: "utf8" }).status === 0;
const integrationAvailable = nginxAvailable && pythonAvailable && opensslAvailable;

let temporaryDirectory;
afterEach(async () => {
  if (temporaryDirectory) await fs.rm(temporaryDirectory, { recursive: true, force: true });
  temporaryDirectory = undefined;
});

describe("public web package audit", () => {
  it("accepts a synthetic static build and records only content hashes", async () => {
    const files = {
      "index.html": "<script type=module src=./assets/app.js></script>",
      "assets/app.js": "console.log('synthetic public build', 'decoder.wasm', 'decoder.worker.js');",
      "assets/decoder.wasm": Buffer.from([0, 1]),
      "assets/decoder.worker.js": "self.onmessage = () => {};",
    };
    expect(auditPublicFiles(files)).toEqual([]);
    const manifest = await createManifest(Object.fromEntries(Object.entries(files).map(([name, value]) => [name, Buffer.from(value)])), "a".repeat(40));
    expect(manifest.sourceRevision).toBe("a".repeat(40));
    expect(manifest.files["assets/app.js"]).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(manifest)).not.toContain("synthetic public build");
  });

  it("rejects private build settings, personal defaults, local service addresses and private keys", () => {
    expect(auditPublicFiles({
      "index.html": "<html></html>",
      "assets/app.js": "decoder.wasm decoder.worker.js",
      "assets/decoder.wasm": Buffer.from([1]),
      "assets/decoder.worker.js": "",
      "personal.js": '{"openSubtitlesApiKey":"synthetic"}',
      "local.js": 'companionServerUrl:"http://192.168.1.20:8787"',
      "key.txt": "-----BEGIN RSA PRIVATE KEY-----",
    })).toEqual([
      "personal build default in personal.js",
      "local service default in local.js",
      "private key material in key.txt",
    ]);
  });

  it("rejects root-relative app assets because protected-prefix navigation requires relative URLs", () => {
    expect(auditPublicFiles({
      "index.html": '<script src="/assets/app.js"></script>',
      "assets/app.js": "",
      "assets/a.wasm": Buffer.from([1]),
      "assets/a.worker.js": "",
    })).toContain("root-relative app asset path");
  });

  it("rejects symbolic links while gathering files for a package", async () => {
    temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "substream-web-audit-"));
    await fs.writeFile(path.join(temporaryDirectory, "index.html"), "synthetic");
    await fs.symlink(path.join(temporaryDirectory, "index.html"), path.join(temporaryDirectory, "linked.html"));
    await expect(collectPublicFiles(temporaryDirectory)).rejects.toThrow("symbolic link");
  });

  it("creates a real synthetic tar with exactly the expected members and rejects sidecars", async () => {
    temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "substream-web-tar-"));
    const staging = path.join(temporaryDirectory, "stage");
    const archive = path.join(temporaryDirectory, "fixture.tar.gz");
    await fs.mkdir(path.join(staging, "assets"), { recursive: true });
    await fs.writeFile(path.join(staging, "index.html"), "synthetic index");
    await fs.writeFile(path.join(staging, "assets/app.js"), "synthetic script");
    await fs.writeFile(path.join(staging, "manifest.json"), '{"schemaVersion":1}\n');

    const expected = ["index.html", "assets/app.js", "manifest.json"];
    createPublicArchive(staging, archive, expected);
    auditTarArchive(archive, expected);
    const members = execFileSync("tar", ["-tzf", archive], { encoding: "utf8" });
    expect(members).not.toMatch(/(?:^|\/)\._|__MACOSX/);

    await fs.writeFile(path.join(staging, "unmanifested.txt"), "synthetic extra file");
    expect(() => createPublicArchive(staging, archive, expected)).toThrow("members do not match");
  });
});

describe("deployment contract", () => {
  it("audits the service-only allowlist and accepts its Google auth runtime package", () => {
    const files = {
      "services/substream-access/main.ts": "entrypoint",
      "services/substream-access/config.ts": "config loader",
      "services/substream-access/service.ts": "portal server",
      "services/substream-access/store.ts": "sqlite store",
      "public/branding/substream-icon.png": Buffer.from([1]),
      "package.json": '{"dependencies":{"google-auth-library":"11.1.0"}}',
      "package-lock.json": '{"lockfileVersion":3}',
      "node_modules/google-auth-library/build/src/index.js": "export {};",
      "manifest.json": "{}",
    };
    expect(auditAccessFiles(files)).toEqual([]);
    expect(() => auditAccessFiles({ ...files, "services/substream-access/.env": "synthetic" }))
      .toThrow("Service package includes a private or non-allowlisted path.");
    expect(() => auditAccessFiles({ ...files, "services/substream-access/config.json": "synthetic" }))
      .toThrow("Service package includes a private or non-allowlisted path.");
  });

  it("keeps the HTTPS portal and HTTP player as separate allowlisted surfaces", async () => {
    const configuration = await fs.readFile(new URL("../deploy/substream-web/nginx.conf", import.meta.url), "utf8");
    expect(configuration).toContain("listen 443 ssl;");
    expect(configuration).toMatch(/server \{[\s\S]*?listen 80;[\s\S]*?Referrer-Policy "no-referrer"[\s\S]*?server \{[\s\S]*?listen 443 ssl;[\s\S]*?Referrer-Policy "same-origin"/);
    expect(configuration).toContain("ssl_certificate /etc/letsencrypt/live/substream.example.invalid/fullchain.pem;");
    expect(configuration).toContain("proxy_pass http://127.0.0.1:8792;");
    expect(configuration).toContain("proxy_pass http://127.0.0.1:8791/authorize;");
    expect(configuration).toContain("X-Real-IP $remote_addr;");
    expect(configuration.replace(/^\s*#.*$/gm, "")).not.toMatch(/Strict-Transport-Security|upgrade-insecure-requests/i);
    expect(configuration).toContain("location = /auth/google/callback");
    expect(configuration).toContain("location = /access/revoke");
    expect(configuration).toContain("location = /branding/substream-icon.png");
  });

  it("runs the standalone service as a dedicated loopback-only unit with durable state", async () => {
    const unit = await fs.readFile(new URL("../deploy/substream-access/substream-access.service", import.meta.url), "utf8");
    const operations = await fs.readFile(new URL("../deploy/substream-access/README.md", import.meta.url), "utf8");
    expect(unit).toContain("User=substream-access");
    expect(unit).toContain("Group=substream-access");
    expect(unit).toContain("/etc/substream-access/config.json");
    expect(unit).toContain("ReadWritePaths=/var/lib/substream-access");
    expect(unit).toContain("/opt/live-subtitle-relay/node/bin/node");
    expect(unit).not.toMatch(/BindsTo=.*(?:relay|vpn)|Requires=.*(?:relay|vpn)/i);
    expect(operations).toContain("immutable");
    expect(operations).toContain("google-auth-library");
    expect(operations).toContain("/var/lib/substream-access");
  });

  it.skipIf(!integrationAvailable)("runs the Linux Nginx HTTP/TLS gate against synthetic services", () => {
    const script = fileURLToPath(new URL("./substream-web-integration.py", import.meta.url));
    const result = spawnSync("python3", [script], {
      cwd: path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."),
      encoding: "utf8",
      timeout: 30_000,
    });
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
  });
});
