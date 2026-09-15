import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";

const [variant, targetIp] = process.argv.slice(2);
if (variant !== "tizen3" && variant !== "tizen6") {
  throw new Error("Usage: node scripts/launch-tizen-wgt.mjs <tizen3|tizen6> <TV_IP>");
}

const ipv4Pattern = /^(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)$/;
if (!targetIp || !ipv4Pattern.test(targetIp)) {
  throw new Error("TV_IP must be a valid IPv4 address, for example 192.168.1.50.");
}

const repositoryRoot = resolve(import.meta.dirname, "..");
const tizenProject = resolve(repositoryRoot, "tizen");
const packagePath = resolve(tizenProject, "Debug", `${variant}.wgt`);
const defaultSdbPath = resolve(homedir(), "tizentv-tools", "sdb", "sdb");
const sdbPath = process.env.SDB || defaultSdbPath;
const serial = `${targetIp}:26101`;
const remoteDirectory = "/home/owner/share/tmp/sdk_tools/tmp/";

if (!existsSync(packagePath)) {
  throw new Error(`Missing ${packagePath}. Prepare, sign, and collect the ${variant} package first.`);
}
if (!existsSync(sdbPath)) {
  throw new Error(
    "Samsung's sdb tool is missing. Launch any app from the VS Code Tizen extension once to let it provision ~/tizentv-tools/sdb/sdb.",
  );
}

function appId() {
  const manifest = readFileSync(resolve(tizenProject, "config.xml"), "utf8");
  const match = manifest.match(/<tizen:application\b[^>]*\bid=["']([^"']+)["']/);
  const value = match?.[1];
  if (!value || !/^[A-Za-z0-9_.-]+$/.test(value)) {
    throw new Error("Could not read a safe Tizen application ID from tizen/config.xml.");
  }
  return value;
}

function run(arguments_, { allowFailure = false } = {}) {
  const result = spawnSync(sdbPath, arguments_, { cwd: repositoryRoot, stdio: "inherit" });
  if (result.error) throw result.error;
  if (!allowFailure && result.status !== 0) process.exit(result.status ?? 1);
  return result;
}

const packageName = packagePath.split("/").at(-1);
const installedAppId = appId();

run(["connect", serial]);
run(["-s", serial, "push", packagePath, remoteDirectory]);
// A first installation has nothing to remove. In all other cases, replacing
// the app preserves the extension's normal launch behaviour.
run(["-s", serial, "shell", "0", "vd_appuninstall", installedAppId], { allowFailure: true });
run(["-s", serial, "shell", "0", "vd_appinstall", installedAppId, remoteDirectory + packageName]);
const execution = run(["-s", serial, "shell", "0", "execute", installedAppId], { allowFailure: true });

if (execution.status === 0) console.log(`Installed and launched ${variant}.wgt on ${serial}.`);
else console.log(`Installed ${variant}.wgt on ${serial}. This TV rejected remote launch; open Substream from the TV Apps screen.`);
