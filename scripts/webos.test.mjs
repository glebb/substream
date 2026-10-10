import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import { auditIpkArchive, createWebosBuildEnvironment, createWebosCliEnvironment, listIpkDataEntries, readWebosManifest, webosModeConflict } from "./webos.mjs";
import { createWebosPackageDefaults } from "./webos-config.mjs";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const temporaryDirs = [];

function tempDir() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "webos-package-test-"));
  temporaryDirs.push(dir);
  return dir;
}

function syntheticIpk(entries) {
  const tarBlocks = [];
  for (const name of entries) {
    const content = Buffer.from("synthetic fixture");
    const header = Buffer.alloc(512);
    header.write(name, 0, 100, "utf8");
    header.write("0000644\0", 100, 8, "ascii");
    header.write("0000000\0", 108, 8, "ascii");
    header.write("0000000\0", 116, 8, "ascii");
    header.write(`${content.length.toString(8).padStart(11, "0")}\0`, 124, 12, "ascii");
    header.write("00000000000\0", 136, 12, "ascii");
    header[156] = 48;
    header.write("ustar\0", 257, 6, "ascii");
    header.write("00", 263, 2, "ascii");
    let checksum = 0;
    for (const byte of header) checksum += byte;
    header.write(`${checksum.toString(8).padStart(6, "0")}\0 `, 148, 8, "ascii");
    tarBlocks.push(header, content, Buffer.alloc((512 - (content.length % 512)) % 512));
  }
  const tar = Buffer.concat([...tarBlocks, Buffer.alloc(1024)]);
  const dataMember = gzipSync(tar);
  const arHeader = Buffer.alloc(60, 32);
  arHeader.write("data.tar.gz/", 0, "ascii");
  arHeader.write("0", 16, 12, "ascii");
  arHeader.write("0", 28, 6, "ascii");
  arHeader.write("0", 34, 6, "ascii");
  arHeader.write("100644", 40, 8, "ascii");
  arHeader.write(String(dataMember.length).padEnd(10, " "), 48, 10, "ascii");
  arHeader.write("`\n", 58, 2, "ascii");
  return Buffer.concat([Buffer.from("!<arch>\n"), arHeader, dataMember, dataMember.length % 2 ? Buffer.from("\n") : Buffer.alloc(0)]);
}

afterEach(() => {
  for (const dir of temporaryDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("LG webOS package boundary", () => {
  it("includes the configured companion endpoint only in personal app defaults", () => {
    const env = {
      COMPANION_SERVER_URL: "http://192.0.2.20:8787",
      IPTV_M3U_URL: "https://provider.example.test/playlist?username=synthetic&password=synthetic",
      OPENSUBTITLES_API_KEY: "synthetic-opensubtitles-key",
      TMDB_API_READ_ACCESS_TOKEN: "synthetic-tmdb-token",
    };
    expect(createWebosPackageDefaults(env, { publicBuild: true })).toEqual({});
    expect(createWebosPackageDefaults(env, { personal: true, webos: true })).toMatchObject({
      companionServerUrl: "http://192.0.2.20:8787",
      playlistUrl: env.IPTV_M3U_URL,
      openSubtitlesApiKey: "synthetic-opensubtitles-key",
      tmdbApiReadAccessToken: "synthetic-tmdb-token",
    });
    expect(createWebosPackageDefaults(env, { personal: true, webos: true })).not.toHaveProperty("lgWebosLocalIp");
  });

  it("uses the Mac IP for personal LG companion defaults and keeps only scheme and port", () => {
    const defaults = createWebosPackageDefaults({
      LG_WEBOS_LOCAL_IP: "192.0.2.21",
      COMPANION_SERVER_URL: "https://stale-host.example.test:9443/private/path?token=synthetic#section",
    }, { personal: true, webos: true });
    expect(defaults.companionServerUrl).toBe("https://192.0.2.21:9443");
    expect(JSON.stringify(defaults)).not.toMatch(/stale-host|private|token|synthetic|section/);
    expect(createWebosPackageDefaults({ LG_WEBOS_LOCAL_IP: "192.0.2.21" }, { personal: true, webos: true }).companionServerUrl)
      .toBe("http://192.0.2.21:8787");
    expect(createWebosPackageDefaults({ LG_WEBOS_LOCAL_IP: "192.0.2.21" }, { publicBuild: true })).toEqual({});
    expect(createWebosPackageDefaults({
      LG_WEBOS_LOCAL_IP: "not a host/path",
      COMPANION_SERVER_URL: "https://tizen-relay.example.test:7443/relay",
    }, { personal: true }).companionServerUrl).toBe("https://tizen-relay.example.test:7443/relay");
  });

  it("rejects LG companion host overrides that contain URL components or invalid hosts", () => {
    for (const host of ["http://192.0.2.21", "user@192.0.2.21", "192.0.2.21/path", "192.0.2.21?token=x", "host:8787", "bad host"]) {
      expect(() => createWebosPackageDefaults({ LG_WEBOS_LOCAL_IP: host }, { personal: true, webos: true }))
        .toThrow(/LG_WEBOS_LOCAL_IP must be an IP address or hostname/);
    }
  });

  it("gives LG CLI tools only runtime paths and excludes app and deployment secrets", () => {
    expect(createWebosCliEnvironment({
      PATH: "/synthetic/bin", HOME: "/synthetic/home", TMPDIR: "/synthetic/tmp",
      IPTV_M3U_URL: "https://provider.example.test/private", OPENSUBTITLES_API_KEY: "synthetic-subtitle-key",
      TMDB_API_READ_ACCESS_TOKEN: "synthetic-tmdb-token", LG_WEBOS_SECRET: "synthetic-lg-secret",
      OTHER_PRIVATE_SETTING: "synthetic-private-value",
    })).toEqual({ PATH: "/synthetic/bin", HOME: "/synthetic/home", TMPDIR: "/synthetic/tmp" });
  });
  it("forces public Chromium 120 output and drops personal, preview, and Tizen flags", () => {
    const env = createWebosBuildEnvironment({
      PERSONAL_BUILD: "1",
      CHROMIUM47_PREVIEW: "1",
      TIZEN_COMPAT_TARGET: "tizen6",
      PUBLIC_BUILD: "0",
      TMDB_API_KEY: "synthetic-tmdb-key",
      VITE_COMPANION_SERVER_URL: "http://127.0.0.1:8787",
      PATH: "/synthetic/path",
    });
    expect(env).toMatchObject({ PUBLIC_BUILD: "1", WEBOS_BUILD: "1", PATH: "/synthetic/path" });
    expect(env).not.toHaveProperty("PERSONAL_BUILD");
    expect(env).not.toHaveProperty("CHROMIUM47_PREVIEW");
    expect(env).not.toHaveProperty("TIZEN_COMPAT_TARGET");
    expect(env).not.toHaveProperty("VITE_COMPANION_SERVER_URL");
    expect(webosModeConflict({ PERSONAL_BUILD: "1" }, false)).toMatch(/explicit personal webOS command/);
    expect(webosModeConflict({ CHROMIUM47_PREVIEW: "1" }, false)).toMatch(/preview proxy mode/);
    expect(webosModeConflict({ TIZEN_COMPAT_TARGET: "tizen6" }, false)).toMatch(/Tizen compatibility mode/);
    expect(webosModeConflict({}, false)).toBe("");
    // The build process inherits other environment values only in its process
    // environment; Vite's webOS mode never loads .env or embeds these values.
  });

  it("enables personal defaults only through the explicit isolated build mode", () => {
    const env = createWebosBuildEnvironment({
      IPTV_M3U_URL: "https://provider.example/playlist?username=synthetic&password=synthetic",
      OPENSUBTITLES_API_KEY: "synthetic-opensubtitles-key",
      TMDB_API_KEY: "synthetic-tmdb-key",
      PUBLIC_BUILD: "1",
      VITE_COMPANION_SERVER_URL: "http://127.0.0.1:8787",
    }, true);
    expect(env).toMatchObject({ WEBOS_BUILD: "1", PERSONAL_BUILD: "1" });
    expect(env).not.toHaveProperty("PUBLIC_BUILD");
    expect(env).not.toHaveProperty("VITE_COMPANION_SERVER_URL");
    expect(env.IPTV_M3U_URL).toContain("provider.example");
    expect(env.OPENSUBTITLES_API_KEY).toBe("synthetic-opensubtitles-key");
    expect(env.TMDB_API_KEY).toBe("synthetic-tmdb-key");
    expect(webosModeConflict({ PUBLIC_BUILD: "1" }, true)).toMatch(/personal and public/);
    expect(webosModeConflict({ CHROMIUM47_PREVIEW: "1" }, true)).toMatch(/preview proxy mode/);
    expect(webosModeConflict({}, true)).toBe("");
  });

  it("ships a valid manifest and its required icon asset", () => {
    const manifest = readWebosManifest();
    expect(manifest.type).toBe("web");
    expect(manifest.main).toBe("index.html");
    expect(manifest.icon).toBe("icon.png");
    expect(manifest.disableBackHistoryAPI).toBe(true);
    const icon = readFileSync(path.join(projectRoot, "webos", manifest.icon));
    expect(icon.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  });

  it("does not echo private device details from failed LG CLI output", () => {
    const dir = tempDir();
    const binDir = path.join(dir, "bin");
    mkdirSync(binDir);
    const cli = path.join(binDir, "ares-install");
    writeFileSync(cli, "#!/bin/sh\nif [ -n \"$OPENSUBTITLES_API_KEY\" ]; then exit 8; fi\necho 'device=private-tv host=192.0.2.44 key=synthetic-secret'\necho 'private connection detail' >&2\nexit 9\n");
    chmodSync(cli, 0o755);
    const packagePath = path.join(dir, "app.ipk");
    writeFileSync(packagePath, "synthetic package");
    const result = spawnSync(process.execPath, [
      path.join(projectRoot, "scripts", "webos.mjs"), "install", "--device", "private-tv", packagePath,
    ], {
      cwd: projectRoot,
      env: { ...process.env, OPENSUBTITLES_API_KEY: "synthetic-credential", PATH: `${binDir}:${process.env.PATH ?? ""}` },
      encoding: "utf8",
    });
    expect(result.status).toBe(9);
    expect(`${result.stdout}\n${result.stderr}`).not.toContain("192.0.2.44");
    expect(`${result.stdout}\n${result.stderr}`).not.toContain("synthetic-secret");
    expect(`${result.stdout}\n${result.stderr}`).toContain("ares-install failed with exit code 9");
  });

  it("audits the packaged IPK data archive and rejects private config records", () => {
    const clean = syntheticIpk(["index.html", "appinfo.json", "assets/index.js"]);
    expect(listIpkDataEntries(clean)).toEqual(["index.html", "appinfo.json", "assets/index.js"]);
    expect(auditIpkArchive(clean)).toHaveLength(3);
    for (const privateRecord of [".env", ".env.production", ".local/deployment/device.json", "assets/.local.data"]) {
      expect(() => auditIpkArchive(syntheticIpk(["index.html", privateRecord]))).toThrow(/private \.local or \.env records/);
    }
  });
});
