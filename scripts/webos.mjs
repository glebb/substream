import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const webosRoot = path.join(projectRoot, "webos");
const distDir = path.join(webosRoot, "dist");
const packageDir = path.join(webosRoot, "packages");
const personalDistDir = path.join(webosRoot, "personal-dist");
const personalPackageDir = path.join(webosRoot, "personal-packages");
const manifestPath = path.join(webosRoot, "appinfo.json");

/** LG tooling needs runtime paths and its external key store, not app credentials. */
export function createWebosCliEnvironment(environment = process.env) {
  const names = [
    "PATH", "HOME", "USER", "LOGNAME", "SHELL", "LANG", "LC_ALL", "LC_CTYPE", "TERM",
    "TMPDIR", "TMP", "TEMP", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "SystemRoot",
    "SYSTEMROOT", "WINDIR", "PATHEXT", "COMSPEC", "HOMEDRIVE", "HOMEPATH",
    "SSH_AUTH_SOCK", "XDG_CONFIG_HOME",
  ];
  return Object.fromEntries(names.filter((name) => environment[name] !== undefined).map((name) => [name, environment[name]]));
}

export function webosModeConflict(environment, personal) {
  if (personal && environment.PUBLIC_BUILD === "1") return "personal and public build modes cannot be combined";
  if (!personal && environment.PERSONAL_BUILD === "1") return "personal mode requires the explicit personal webOS command";
  if (environment.CHROMIUM47_PREVIEW === "1") return "Chromium 47 preview proxy mode is not supported for webOS builds";
  if (environment.TIZEN_COMPAT_TARGET) return "Tizen compatibility mode is not supported for webOS builds";
  return "";
}

export function createWebosBuildEnvironment(environment = process.env, personal = false) {
  const clean = { ...environment };
  for (const name of Object.keys(clean)) {
    if (name.startsWith("VITE_")) delete clean[name];
  }
  delete clean.CHROMIUM47_PREVIEW;
  delete clean.TIZEN_COMPAT_TARGET;
  if (personal) {
    delete clean.PUBLIC_BUILD;
    clean.PERSONAL_BUILD = "1";
  } else {
    delete clean.PERSONAL_BUILD;
    clean.PUBLIC_BUILD = "1";
  }
  clean.WEBOS_BUILD = "1";
  return clean;
}

export function readWebosManifest() {
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  if (manifest.type !== "web" || manifest.main !== "index.html" || !manifest.id || !manifest.version || manifest.disableBackHistoryAPI !== true) {
    throw new Error("webos/appinfo.json is missing required web app metadata");
  }
  return manifest;
}

function parseTarEntries(data) {
  const entries = [];
  let offset = 0;
  let nextName = "";
  while (offset + 512 <= data.length) {
    const header = data.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const field = (start, end) => header.subarray(start, end).toString("utf8").replace(/\0.*$/s, "").trim();
    const sizeText = field(124, 136);
    const size = Number.parseInt(sizeText || "0", 8);
    if (!Number.isFinite(size) || size < 0 || offset + 512 + size > data.length) {
      throw new Error("IPK contains an invalid application archive");
    }
    const body = data.subarray(offset + 512, offset + 512 + size);
    const type = String.fromCharCode(header[156] || 48);
    const name = field(345, 500) ? `${field(345, 500)}/${field(0, 100)}` : field(0, 100);
    if (type === "L") {
      nextName = body.toString("utf8").replace(/\0.*$/s, "");
    } else if (type === "x" || type === "g") {
      const pax = body.toString("utf8");
      const match = pax.match(/(?:^|\n)\d+ path=([^\n]+)\n/);
      if (match) nextName = match[1];
    } else if (name) {
      entries.push(nextName || name);
      nextName = "";
    }
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  return entries;
}

export function listIpkDataEntries(archive) {
  if (!archive.subarray(0, 8).equals(Buffer.from("!<arch>\n"))) {
    throw new Error("LG CLI output is not a valid IPK archive");
  }
  let offset = 8;
  while (offset + 60 <= archive.length) {
    const header = archive.subarray(offset, offset + 60);
    const name = header.subarray(0, 16).toString("ascii").trim().replace(/\/$/, "");
    const size = Number.parseInt(header.subarray(48, 58).toString("ascii").trim(), 10);
    if (!Number.isFinite(size) || size < 0 || offset + 60 + size > archive.length) {
      throw new Error("LG CLI output is not a valid IPK archive");
    }
    const member = archive.subarray(offset + 60, offset + 60 + size);
    if (name === "data.tar.gz") return parseTarEntries(gunzipSync(member));
    offset += 60 + size + (size % 2);
  }
  throw new Error("IPK does not contain an application data archive");
}

export function privateConfigEntries(entries) {
  return entries.filter((entry) => entry.split("/").some((part) =>
    part === ".local" || part.startsWith(".local.") || part === ".env" || part.startsWith(".env.")));
}

export function auditIpkArchive(archive) {
  const entries = listIpkDataEntries(archive);
  if (privateConfigEntries(entries).length) {
    throw new Error("IPK contains private .local or .env records");
  }
  return entries;
}

function requireOutputFile(file, label) {
  try {
    if (!statSync(file).isFile()) throw new Error();
  } catch {
    throw new Error(`LG webOS build is missing ${label}`);
  }
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: projectRoot,
    env: process.env,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    timeout: 120_000,
    ...options,
  });
  if (result.error?.code === "ENOENT") {
    return { ok: false, missing: true, status: null };
  }
  return { ok: result.status === 0, missing: false, status: result.status, timedOut: result.error?.code === "ETIMEDOUT" };
}

function failCli(command) {
  console.error(`Required LG webOS CLI command is unavailable: ${command}. Install the official webOS TV CLI and add its ares commands to PATH.`);
  console.error("https://webostv.developer.lge.com/develop/tools/cli-installation");
  process.exitCode = 1;
}

function cliRun(command, args) {
  const result = run(command, args, { env: createWebosCliEnvironment() });
  if (result.missing) {
    failCli(command);
    return false;
  }
  if (!result.ok) {
    console.error(result.timedOut
      ? `${command} timed out. Check the LG CLI setup and target device configuration.`
      : `${command} failed with exit code ${result.status ?? "unknown"}. Check the LG CLI setup and target device configuration.`);
    process.exitCode = result.status || 1;
    return false;
  }
  return true;
}

function build(personal = false) {
  const modeConflict = webosModeConflict(process.env, personal);
  if (modeConflict) {
    console.error(`Cannot build LG webOS app: ${modeConflict}.`);
    process.exitCode = 2;
    return false;
  }
  const outputDir = personal ? personalDistDir : distDir;
  const vitePath = path.join(projectRoot, "node_modules", "vite", "bin", "vite.js");
  const result = run(process.execPath, [vitePath, "build", "--outDir", outputDir], {
    env: createWebosBuildEnvironment(process.env, personal),
    timeout: 180_000,
  });
  if (result.missing) {
    console.error("Vite is unavailable. Install the project dependencies before building the webOS app.");
    process.exitCode = 1;
    return false;
  }
  if (!result.ok) {
    console.error(result.timedOut
      ? "LG webOS build timed out."
      : `LG webOS build failed with exit code ${result.status ?? "unknown"}.`);
    process.exitCode = result.status || 1;
    return false;
  }

  const manifest = readWebosManifest();
  requireOutputFile(path.join(outputDir, manifest.main), manifest.main);
  requireOutputFile(path.join(webosRoot, manifest.icon), manifest.icon);
  copyFileSync(manifestPath, path.join(outputDir, "appinfo.json"));
  copyFileSync(path.join(webosRoot, manifest.icon), path.join(outputDir, manifest.icon));
  console.log(personal
    ? `Built PRIVATE personal webOS app in ${path.relative(projectRoot, outputDir)} for Chromium 120.`
    : `Built credential-free webOS app in ${path.relative(projectRoot, outputDir)} for Chromium 120.`);
  return true;
}

function packageApp(personal = false) {
  if (!build(personal)) return;
  const outputDir = personal ? personalDistDir : distDir;
  const outputPackageDir = personal ? personalPackageDir : packageDir;
  rmSync(outputPackageDir, { recursive: true, force: true });
  mkdirSync(outputPackageDir, { recursive: true });
  if (!cliRun("ares-package", ["--outdir", outputPackageDir, outputDir])) return;
  const packages = readdirSync(outputPackageDir).filter((name) => name.endsWith(".ipk"));
  if (packages.length !== 1) {
    console.error("LG CLI packaging finished without producing exactly one .ipk file.");
    process.exitCode = 1;
    return;
  }
  try {
    auditIpkArchive(readFileSync(path.join(outputPackageDir, packages[0])));
  } catch (error) {
    console.error(error instanceof Error && error.message === "IPK contains private .local or .env records"
      ? "The IPK contains private .local or .env records and cannot be used."
      : "The LG CLI produced an invalid or unreadable IPK archive.");
    rmSync(path.join(outputPackageDir, packages[0]), { force: true });
    process.exitCode = 1;
    return;
  }
  console.log(`${personal ? "Created PRIVATE personal artifact" : "Created"} ${path.join(path.relative(projectRoot, outputPackageDir), packages[0])}.`);
  return path.join(outputPackageDir, packages[0]);
}

/** Build first, then replace and launch one registered TV app; never echo CLI output. */
export function deployPersonalWebos(device, steps = {}) {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(device ?? "")) {
    console.error("Pass a valid registered LG device name, or set LG_WEBOS_DEVICE in .env.");
    process.exitCode = 2;
    return false;
  }
  const packagePath = (steps.packageApp ?? packageApp)(true);
  if (!packagePath) return false;
  const manifest = readWebosManifest();
  const runCli = steps.cliRun ?? cliRun;
  // Closing is best effort because a first installation has no running app.
  // Installation and launch failures below remain fatal.
  (steps.closeApp ?? (() => run("ares-launch", ["--device", device, "--close", manifest.id], { env: createWebosCliEnvironment() })))();
  if (!runCli("ares-install", ["--device", device, packagePath])) return false;
  if (!runCli("ares-launch", ["--device", device, manifest.id])) return false;
  console.log("Personal LG app deployed and launched.");
  return true;
}

function install(args) {
  const parsed = parseDevice(args);
  if (process.exitCode) return;
  const packagePath = parsed.rest[0];
  if (!packagePath || parsed.rest.length !== 1 || !packagePath.endsWith(".ipk")) {
    console.error("Usage: npm run install:webos -- --device <configured-device-name> <package.ipk>");
    process.exitCode = 2;
    return;
  }
  const absolutePackage = path.resolve(projectRoot, packagePath);
  try {
    if (!statSync(absolutePackage).isFile()) throw new Error();
  } catch {
    console.error("The specified .ipk package was not found.");
    process.exitCode = 2;
    return;
  }
  cliRun("ares-install", ["--device", parsed.device, absolutePackage]);
}

function launch(args) {
  const parsed = parseDevice(args);
  if (process.exitCode) return;
  if (parsed.rest.length) {
    console.error("Usage: npm run launch:webos -- --device <configured-device-name>");
    process.exitCode = 2;
    return;
  }
  const manifest = readWebosManifest();
  cliRun("ares-launch", ["--device", parsed.device, manifest.id]);
}

function parseDevice(args) {
  const deviceIndex = args.indexOf("--device");
  const device = deviceIndex >= 0 ? args[deviceIndex + 1] : "";
  if (!device || device.startsWith("--")) {
    console.error("Pass the device name you configured with ares-setup-device using --device.");
    process.exitCode = 2;
    return { device: "", rest: [] };
  }
  const rest = args.filter((_, index) => index !== deviceIndex && index !== deviceIndex + 1);
  return { device, rest };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [action, ...args] = process.argv.slice(2);
  switch (action) {
    case "build":
      build();
      break;
    case "build-personal":
      build(true);
      break;
    case "package":
      packageApp();
      break;
    case "package-personal":
      packageApp(true);
      break;
    case "install":
      install(args);
      break;
    case "launch":
      launch(args);
      break;
    case "deploy-personal": {
      const parsed = parseDevice(args);
      if (!process.exitCode && !parsed.rest.length) deployPersonalWebos(parsed.device);
      else if (!process.exitCode) {
        console.error("Usage: node scripts/webos.mjs deploy-personal --device <configured-device-name>");
        process.exitCode = 2;
      }
      break;
    }
    default:
      console.error("Usage: node scripts/webos.mjs <build|build-personal|package|package-personal|install|launch|deploy-personal>");
      process.exitCode = 2;
  }
}
