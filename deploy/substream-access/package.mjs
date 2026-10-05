import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const deployRoot = path.dirname(fileURLToPath(import.meta.url));
const archivePrefix = "substream-access-";
const serviceFiles = [
  "services/substream-access/main.ts",
  "services/substream-access/config.ts",
  "services/substream-access/service.ts",
  "services/substream-access/store.ts",
  "public/branding/substream-icon.png",
];

function sha256(data) { return createHash("sha256").update(data).digest("hex"); }
function quoteShell(value) { return `'${String(value).replaceAll("'", "'\\''")}'`; }
function isSshHost(value) { return /^(?:[A-Za-z0-9._-]+@)?[A-Za-z0-9._-]+$/.test(value || ""); }
function sshIdentityArgs() {
  const identity = process.env.SUBSTREAM_SSH_IDENTITY;
  return identity ? ["-i", path.resolve(identity)] : [];
}

async function collectFiles(directory, relative = "") {
  const files = {};
  for (const entry of await fs.readdir(path.join(directory, relative), { withFileTypes: true })) {
    if (entry.name === ".bin") continue;
    const name = path.posix.join(relative, entry.name);
    const absolute = path.join(directory, name);
    if (entry.isSymbolicLink()) throw new Error("Service package contains an unexpected symbolic link.");
    if (entry.isDirectory()) Object.assign(files, await collectFiles(directory, name));
    else if (entry.isFile()) files[name] = await fs.readFile(absolute);
    else throw new Error("Service package contains an unsupported file type.");
  }
  return files;
}

function auditFiles(files) {
  const required = [...serviceFiles, "package.json", "package-lock.json", "manifest.json"];
  for (const name of required) if (!files[name] && name !== "manifest.json") throw new Error(`Service package is missing ${name}.`);
  if (!files["node_modules/google-auth-library/build/src/index.js"]
      && !Object.keys(files).some((name) => name.startsWith("node_modules/google-auth-library/"))) {
    throw new Error("Service package is missing the production Google auth dependency.");
  }
  const sourcePaths = Object.keys(files).filter((name) => !name.startsWith("node_modules/"));
  const forbidden = sourcePaths.filter((name) => /(?:^|\/)(?:\.env(?:\..*)?|config\.json|\.git|tests?)(?:\/|$)/i.test(name)
    || /(?:playlist|private-key|personal|media-url)/i.test(name));
  if (forbidden.length) throw new Error("Service package includes a private or non-allowlisted path.");
  for (const [name, data] of Object.entries(files).filter(([file]) => !file.startsWith("node_modules/"))) {
    if (/\.(?:ts|js|json|txt)$/i.test(name)) {
      const text = data.toString("utf8");
      if (/-----BEGIN (?:OPENSSH|RSA|EC) PRIVATE KEY-----/.test(text)) throw new Error("Service package contains private key material.");
      if (/authorized\.synthetic@example\.invalid/.test(text) && !name.endsWith("package-lock.json")) {
        throw new Error("Synthetic allowlist example must not enter a service release.");
      }
    }
  }
  return [];
}

function auditArchive(archivePath, expectedFiles) {
  const listing = execFileSync("tar", ["-tzf", archivePath], { encoding: "utf8", maxBuffer: 12 * 1024 * 1024 });
  const actual = new Set();
  for (const rawName of listing.split("\n").filter(Boolean)) {
    const isDirectory = rawName.endsWith("/") || rawName === "." || rawName === "./";
    const name = rawName.replace(/^\.\//, "").replace(/\/+$/, "") || ".";
    const parts = name.split("/");
    if (name.startsWith("/") || parts.includes("..") || actual.has(`${isDirectory ? "d" : "f"}:${name}`)) {
      throw new Error("Service archive contains an unsafe or duplicate member.");
    }
    actual.add(`${isDirectory ? "d" : "f"}:${name}`);
  }
  const expected = new Set(["d:."]);
  for (const file of expectedFiles) {
    const parts = file.split("/");
    let parent = ".";
    for (const part of parts.slice(0, -1)) {
      parent = parent === "." ? part : `${parent}/${part}`;
      expected.add(`d:${parent}`);
    }
    expected.add(`f:${file}`);
  }
  if ([...expected].some((name) => !actual.has(name)) || [...actual].some((name) => !expected.has(name))) {
    throw new Error("Service archive members do not match the audited file list.");
  }
}

function dependencyClosure(lock, rootLocator) {
  const packages = lock.packages ?? {};
  const found = new Set();
  const queue = [rootLocator];
  const resolve = (from, name) => {
    const parts = from.split("/");
    for (let size = parts.length; size >= 0; size -= 1) {
      const candidate = [...parts.slice(0, size), "node_modules", name].filter(Boolean).join("/");
      if (packages[candidate]) return candidate;
    }
    return undefined;
  };
  while (queue.length) {
    const locator = queue.shift();
    if (!locator || found.has(locator)) continue;
    const metadata = packages[locator];
    if (!metadata) throw new Error("Locked production dependency metadata is incomplete.");
    found.add(locator);
    const optional = metadata.optionalDependencies ?? {};
    for (const name of Object.keys(metadata.dependencies ?? {})) {
      const child = resolve(locator, name);
      if (!child && !Object.hasOwn(optional, name)) throw new Error("A locked production dependency is not installed.");
      if (child) queue.push(child);
    }
    for (const name of Object.keys(optional)) {
      const child = resolve(locator, name);
      if (child) queue.push(child);
    }
    for (const name of Object.keys(metadata.peerDependencies ?? {})) {
      const child = resolve(locator, name);
      if (child) queue.push(child);
    }
  }
  return [...found].sort();
}

function createArchive(stagingDirectory, archivePath, expectedFiles) {
  execFileSync("tar", ["-czf", archivePath, "-C", stagingDirectory, "."], {
    env: { ...process.env, COPYFILE_DISABLE: "1" },
  });
  auditArchive(archivePath, expectedFiles);
}

async function sourceSnapshot() {
  const aggregate = createHash("sha256");
  for (const name of serviceFiles) {
    aggregate.update(name).update("\0").update(await fs.readFile(path.join(projectRoot, name))).update("\n");
  }
  return aggregate.digest("hex");
}

async function packageService(outputArg) {
  const rootPackage = JSON.parse(await fs.readFile(path.join(projectRoot, "package.json"), "utf8"));
  const rootLock = JSON.parse(await fs.readFile(path.join(projectRoot, "package-lock.json"), "utf8"));
  const locked = rootLock.packages?.["node_modules/google-auth-library"]?.version;
  if (!locked || !rootPackage.dependencies?.["google-auth-library"]) {
    throw new Error("google-auth-library must be a locked production dependency before packaging.");
  }

  const temporary = await fs.mkdtemp(path.join("/tmp", "substream-access-package-"));
  const staging = path.join(temporary, "content");
  try {
    await fs.mkdir(staging, { recursive: true });
    for (const name of serviceFiles) {
      const destination = path.join(staging, name);
      await fs.mkdir(path.dirname(destination), { recursive: true });
      await fs.copyFile(path.join(projectRoot, name), destination);
      await fs.chmod(destination, 0o644);
    }
    const releasePackage = {
      name: "substream-access-service",
      private: true,
      type: "module",
      engines: { node: ">=24.21.0" },
      dependencies: { "google-auth-library": locked },
    };
    await fs.writeFile(path.join(staging, "package.json"), `${JSON.stringify(releasePackage, null, 2)}\n`, { mode: 0o644 });
    const dependencyPaths = dependencyClosure(rootLock, "node_modules/google-auth-library");
    for (const locator of dependencyPaths) {
      const source = path.join(projectRoot, locator);
      const destination = path.join(staging, locator);
      await fs.access(path.join(source, "package.json")).catch(() => {
        throw new Error("A locked production dependency is not installed in node_modules.");
      });
      await fs.mkdir(path.dirname(destination), { recursive: true });
      await fs.cp(source, destination, { recursive: true, dereference: true, filter: (src) => !src.split(path.sep).includes(".bin") });
    }
    const serviceLock = {
      name: releasePackage.name,
      version: "1.0.0",
      lockfileVersion: 3,
      requires: true,
      packages: {
        "": { name: releasePackage.name, version: "1.0.0", engines: releasePackage.engines, dependencies: releasePackage.dependencies },
        ...Object.fromEntries(dependencyPaths.map((locator) => [locator, rootLock.packages[locator]])),
      },
    };
    await fs.writeFile(path.join(staging, "package-lock.json"), `${JSON.stringify(serviceLock, null, 2)}\n`, { mode: 0o644 });

    const revision = execFileSync("git", ["rev-parse", "--verify", "HEAD"], { cwd: projectRoot, encoding: "utf8" }).trim();
    const treeHash = await sourceSnapshot();
    const manifest = {
      schemaVersion: 1,
      sourceRevision: revision,
      sourceSnapshotSha256: treeHash,
      dependency: { name: "google-auth-library", version: locked },
      files: {},
    };
    const files = await collectFiles(staging);
    auditFiles({ ...files, "manifest.json": Buffer.alloc(0) });
    manifest.files = Object.fromEntries(Object.keys(files).sort().map((name) => [name, sha256(files[name])]));
    await fs.writeFile(path.join(staging, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o644 });

    const time = new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 14);
    const release = `${time}-${treeHash.slice(0, 12)}`;
    const output = path.resolve(outputArg || path.join("/tmp", `${archivePrefix}${release}.tar.gz`));
    await fs.mkdir(path.dirname(output), { recursive: true });
    createArchive(staging, output, [...Object.keys(files), "manifest.json"]);
    process.stdout.write(`Package: ${output}\nRelease: ${release}\nArchive SHA-256: ${sha256(await fs.readFile(output))}\nFiles: ${Object.keys(files).length}\n`);
  } finally {
    await fs.rm(temporary, { recursive: true, force: true });
  }
}

async function deploy(host, archiveArg) {
  if (!host || !archiveArg) throw new Error("Usage: package:access or deploy:access -- <ssh-host> <package.tar.gz>");
  if (!isSshHost(host)) throw new Error("SSH host must be a simple host or user@host value.");
  const archive = path.resolve(archiveArg);
  const match = path.basename(archive).match(/^substream-access-(\d{14}-[a-f0-9]{12})\.tar\.gz$/);
  if (!match) throw new Error("Package filename does not contain a valid immutable release id.");
  const release = match[1];
  const digest = sha256(await fs.readFile(archive));
  const remoteArchive = `/tmp/${archivePrefix}${release}.tar.gz`;
  const remoteInstaller = `/tmp/substream-access-install-${release}.sh`;
  const remoteRollback = `/tmp/substream-access-rollback-${release}.sh`;
  const identity = sshIdentityArgs();
  execFileSync("scp", [...identity, archive, `${host}:${remoteArchive}`], { stdio: "inherit" });
  execFileSync("scp", [...identity, path.join(deployRoot, "install-release.sh"), `${host}:${remoteInstaller}`], { stdio: "inherit" });
  execFileSync("scp", [...identity, path.join(deployRoot, "rollback-release.sh"), `${host}:${remoteRollback}`], { stdio: "inherit" });
  const command = `sudo sh ${quoteShell(remoteInstaller)} ${quoteShell(release)} ${quoteShell(digest)} < ${quoteShell(remoteArchive)} && sudo install -D -o root -g root -m 0555 ${quoteShell(remoteRollback)} /opt/substream-access/rollback-release.sh && sudo systemctl restart substream-access && sudo systemctl is-active --quiet substream-access; result=$?; rm -f ${quoteShell(remoteInstaller)} ${quoteShell(remoteRollback)} ${quoteShell(remoteArchive)}; exit $result`;
  execFileSync("ssh", [...identity, host, command], { stdio: "inherit" });
}

async function rollback(host, release) {
  if (!host || !release) throw new Error("Usage: npm run rollback:access -- <ssh-host> <release-id>");
  if (!isSshHost(host) || !/^\d{14}-[a-f0-9]{12}$/.test(release)) throw new Error("Invalid SSH host or release id.");
  const identity = sshIdentityArgs();
  const remoteScript = `/tmp/substream-access-rollback-${release}.sh`;
  execFileSync("scp", [...identity, path.join(deployRoot, "rollback-release.sh"), `${host}:${remoteScript}`], { stdio: "inherit" });
  const command = `sudo sh ${quoteShell(remoteScript)} ${quoteShell(release)} && sudo systemctl restart substream-access && sudo systemctl is-active --quiet substream-access; result=$?; rm -f ${quoteShell(remoteScript)}; exit $result`;
  execFileSync("ssh", [...identity, host, command], { stdio: "inherit" });
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (command === "package") return packageService(args[0]);
  if (command === "deploy") return deploy(args[0], args[1]);
  if (command === "rollback") return rollback(args[0], args[1]);
  throw new Error("Usage: package:access | deploy:access -- <ssh-host> <package.tar.gz> | rollback:access -- <ssh-host> <release-id>");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error.message || "Access service packaging failed."}\n`);
    process.exitCode = 1;
  });
}

export { auditArchive, auditFiles, collectFiles, createArchive };
