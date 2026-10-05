import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const deployRoot = path.join(projectRoot, "deploy/substream-web");
const archivePrefix = "substream-web-";

export function auditPublicFiles(files) {
  const findings = [];
  const indexHtml = files["index.html"]?.toString("utf8") ?? "";
  if (!indexHtml) findings.push("missing index.html");
  for (const [, reference] of indexHtml.matchAll(/(?:src|href)=["']([^"']+)["']/g)) {
    if (reference.startsWith("/") && !reference.startsWith("//")) findings.push("root-relative app asset path");
  }
  const names = Object.keys(files);
  const jsBundle = names.filter((name) => /\.js$/i.test(name)).map((name) => files[name].toString("utf8")).join("\n");
  const wasmFiles = names.filter((name) => /\.wasm$/i.test(name));
  const workerFiles = names.filter((name) => /worker[^/]*\.js$/i.test(name));
  if (!wasmFiles.length) findings.push("missing decoder WASM asset");
  if (!workerFiles.length) findings.push("missing emitted worker asset");
  if (wasmFiles.some((name) => !jsBundle.includes(path.posix.basename(name)))) findings.push("decoder WASM is not referenced by a bundle");
  if (workerFiles.some((name) => !jsBundle.includes(path.posix.basename(name)))) findings.push("worker asset is not referenced by a bundle");
  for (const [name, contents] of Object.entries(files)) {
    const text = Buffer.isBuffer(contents) ? contents.toString("utf8") : String(contents);
    const checks = [
      [/"(?:playlistUrl|openSubtitlesApiKey|tmdbApiReadAccessToken|tmdbApiKey)"\s*:\s*"[^"\s]/i, "personal build default"],
      [/(?:companionServerUrl|relayServiceUrl|serviceUrl)\s*[:=]\s*["']https?:\/\/(?:127\.0\.0\.1|localhost|10\.[0-9.]+|192\.168\.[0-9.]+)(?::\d+)?/i, "local service default"],
      [/-----BEGIN (?:OPENSSH|RSA|EC) PRIVATE KEY-----/, "private key material"],
    ];
    for (const [pattern, label] of checks) if (pattern.test(text)) findings.push(`${label} in ${name}`);
  }
  return findings;
}

export async function collectPublicFiles(directory, relative = "") {
  const found = {};
  for (const entry of await fs.readdir(path.join(directory, relative), { withFileTypes: true })) {
    const name = path.posix.join(relative, entry.name);
    const absolute = path.join(directory, name);
    if (entry.isSymbolicLink()) throw new Error(`Public build contains a symbolic link at ${name}.`);
    if (entry.isDirectory()) Object.assign(found, await collectPublicFiles(directory, name));
    else if (entry.isFile()) found[name] = await fs.readFile(absolute);
  }
  return found;
}

function sha256(data) { return createHash("sha256").update(data).digest("hex"); }
function quoteShell(value) { return `'${String(value).replaceAll("'", "'\\''")}'`; }
function isSshHost(value) { return /^(?:[A-Za-z0-9._-]+@)?[A-Za-z0-9._-]+$/.test(value || ""); }
function sshIdentityArgs() {
  const identity = process.env.SUBSTREAM_SSH_IDENTITY;
  return identity ? ["-i", path.resolve(identity)] : [];
}

export async function createManifest(files, revision) {
  return {
    schemaVersion: 1,
    sourceRevision: revision,
    files: Object.fromEntries(Object.keys(files).sort().map((name) => [name, sha256(files[name])])),
  };
}

export function auditTarArchive(archivePath, expectedFiles) {
  const listing = execFileSync("tar", ["-tzf", archivePath], { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 });
  const actual = new Set();
  for (const rawName of listing.split("\n").filter(Boolean)) {
    const isDirectory = rawName.endsWith("/") || rawName === "." || rawName === "./";
    const name = rawName.replace(/^\.\//, "").replace(/\/+$/, "") || ".";
    const segments = name.split("/");
    if (name.startsWith("/") || segments.includes("..") || actual.has(`${isDirectory ? "d" : "f"}:${name}`)) {
      throw new Error("Package archive contains an unsafe or duplicate member.");
    }
    actual.add(`${isDirectory ? "d" : "f"}:${name}`);
  }

  const expected = new Set(["d:."]);
  for (const file of expectedFiles) {
    const parts = file.split("/");
    if (!file || file.startsWith("/") || parts.includes("..")) throw new Error("Expected package file path is unsafe.");
    let parent = ".";
    for (const part of parts.slice(0, -1)) {
      parent = parent === "." ? part : `${parent}/${part}`;
      expected.add(`d:${parent}`);
    }
    expected.add(`f:${file}`);
  }
  const missing = [...expected].filter((member) => !actual.has(member));
  const extra = [...actual].filter((member) => !expected.has(member));
  if (missing.length || extra.length) throw new Error("Package archive members do not match the audited file list.");
}

export function createPublicArchive(stagingDirectory, archivePath, expectedFiles) {
  const env = { ...process.env, COPYFILE_DISABLE: "1" };
  execFileSync("tar", ["-czf", archivePath, "-C", stagingDirectory, "."], { env });
  auditTarArchive(archivePath, expectedFiles);
}

async function createSourceSnapshot() {
  const listed = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], {
    cwd: projectRoot,
    encoding: "buffer",
    maxBuffer: 8 * 1024 * 1024,
  }).toString("utf8");
  const paths = listed.split("\0").filter(Boolean).filter((name) => {
    const segments = name.split(/[\\/]/);
    return !segments.some((segment) => segment === "node_modules" || segment === "dist" || segment === ".git" || segment === "coverage")
      && !segments.some((segment) => segment === ".env" || segment.startsWith(".env."));
  }).sort();
  const aggregate = createHash("sha256");
  let count = 0;
  for (const name of paths) {
    const absolute = path.join(projectRoot, name);
    const stat = await fs.lstat(absolute).catch(() => null);
    if (!stat?.isFile()) continue;
    const digest = sha256(await fs.readFile(absolute));
    aggregate.update(name).update("\0").update(digest).update("\n");
    count += 1;
  }
  return { sha256: aggregate.digest("hex"), fileCount: count };
}

async function packagePublicBuild(outputArg) {
  const env = { ...process.env, PUBLIC_BUILD: "1", CHROMIUM47_PREVIEW: "0" };
  delete env.PERSONAL_BUILD;
  delete env.TIZEN_COMPAT_TARGET;
  for (const key of Object.keys(env)) if (key.startsWith("VITE_")) delete env[key];
  execFileSync("npm", ["run", "build:public"], { cwd: projectRoot, env, stdio: "inherit" });

  const files = await collectPublicFiles(path.join(projectRoot, "dist"));
  if (!Object.keys(files).includes("index.html")) throw new Error("Public build is missing index.html.");
  const findings = auditPublicFiles(files);
  if (findings.length) throw new Error(`Public build audit failed: ${findings.join(", ")}`);

  const revision = execFileSync("git", ["rev-parse", "--verify", "HEAD"], { cwd: projectRoot, encoding: "utf8" }).trim();
  const workingTreeState = execFileSync("git", ["status", "--porcelain", "--untracked-files=all"], { cwd: projectRoot, encoding: "utf8" });
  const sourceSnapshot = await createSourceSnapshot();
  const manifest = await createManifest(files, revision);
  manifest.workingTreeStatusSha256 = sha256(Buffer.from(workingTreeState));
  manifest.includesUncommittedChanges = workingTreeState.trim().length > 0;
  manifest.sourceSnapshotSha256 = sourceSnapshot.sha256;
  manifest.sourceFileCount = sourceSnapshot.fileCount;
  const temporary = await fs.mkdtemp(path.join("/tmp", "substream-web-package-"));
  const staging = path.join(temporary, "content");
  await fs.mkdir(staging);
  for (const [name, contents] of Object.entries(files)) {
    const destination = path.join(staging, name);
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.writeFile(destination, contents, { mode: 0o644 });
  }
  await fs.writeFile(path.join(staging, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o644 });

  const release = `${new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 14)}-${revision.slice(0, 12)}`;
  const output = path.resolve(outputArg || path.join("/tmp", `${archivePrefix}${release}.tar.gz`));
  await fs.mkdir(path.dirname(output), { recursive: true });
  createPublicArchive(staging, output, [...Object.keys(files), "manifest.json"]);
  const digest = sha256(await fs.readFile(output));
  process.stdout.write(`Package: ${output}\nRelease: ${release}\nArchive SHA-256: ${digest}\nFiles: ${Object.keys(files).length}\n`);
  await fs.rm(temporary, { recursive: true, force: true });
}

async function deploy(host, archiveArg) {
  if (!host || !archiveArg) throw new Error("Usage: npm run deploy:web -- <ssh-host> <package.tar.gz>");
  if (!isSshHost(host)) throw new Error("SSH host must be a simple host or user@host value.");
  const archive = path.resolve(archiveArg);
  const parsed = path.basename(archive).match(/^substream-web-(\d{14}-[a-f0-9]{12})\.tar\.gz$/);
  if (!parsed) throw new Error("Package filename does not contain a valid immutable release id.");
  const release = parsed[1];
  const digest = sha256(await fs.readFile(archive));
  const remoteArchive = `/tmp/${archivePrefix}${release}.tar.gz`;
  const remoteInstaller = `/tmp/substream-web-install-${release}.sh`;
  const identityArgs = sshIdentityArgs();
  execFileSync("scp", [...identityArgs, archive, `${host}:${remoteArchive}`], { stdio: "inherit" });
  execFileSync("scp", [...identityArgs, path.join(deployRoot, "install-release.sh"), `${host}:${remoteInstaller}`], { stdio: "inherit" });
  const command = `sudo sh ${quoteShell(remoteInstaller)} ${quoteShell(release)} ${quoteShell(digest)} < ${quoteShell(remoteArchive)} && rm -f ${quoteShell(remoteInstaller)} ${quoteShell(remoteArchive)}`;
  execFileSync("ssh", [...identityArgs, host, command], { stdio: "inherit" });
}

async function rollback(host, release) {
  if (!isSshHost(host) || !/^\d{14}-[a-f0-9]{12}$/.test(release || "")) {
    throw new Error("Usage: npm run rollback:web -- <ssh-host> <release-id>");
  }
  const remoteScript = `/tmp/substream-web-rollback-${release}.sh`;
  const identityArgs = sshIdentityArgs();
  execFileSync("scp", [...identityArgs, path.join(deployRoot, "rollback-release.sh"), `${host}:${remoteScript}`], { stdio: "inherit" });
  execFileSync("ssh", [...identityArgs, host, `sudo sh ${quoteShell(remoteScript)} ${quoteShell(release)}; result=$?; rm -f ${quoteShell(remoteScript)}; exit $result`], { stdio: "inherit" });
}

async function main(args) {
  const [command, ...rest] = args;
  if (command === "package") return packagePublicBuild(rest[0]);
  if (command === "deploy") return deploy(rest[0], rest[1]);
  if (command === "rollback") return rollback(rest[0], rest[1]);
  throw new Error("Usage: node scripts/substream-web.mjs <package|deploy|rollback> [...]");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => {
    // Messages are deliberately generic; never print bundle or configuration values.
    process.stderr.write(`${error?.message || "Substream web operation failed."}\n`);
    process.exitCode = 1;
  });
}
