import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { createInterface } from "node:readline/promises";

const ipv4Pattern = /^(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)$/;

export function readDeviceIp({ variant, environment = process.env, configurationPath }) {
  const variable = variant === "tizen3" ? "TIZEN3_TV_IP" : "TIZEN6_TV_IP";
  if (environment[variable]) return environment[variable].trim();
  if (!existsSync(configurationPath)) return undefined;

  const line = readFileSync(configurationPath, "utf8")
    .split(/\r?\n/)
    .find((candidate) => candidate.trimStart().startsWith(`${variable}=`));
  return line?.slice(line.indexOf("=") + 1).trim() || undefined;
}

export function validateDeviceIp(value) {
  return Boolean(value && ipv4Pattern.test(value));
}

export function runStep(command, arguments_, options = {}) {
  const result = spawnSync(command, arguments_, { stdio: "inherit", ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

async function main() {
  const [variant, explicitIp] = process.argv.slice(2);
  if (variant !== "tizen3" && variant !== "tizen6") {
    throw new Error("Usage: node scripts/deploy-tizen-vscode-package.mjs <tizen3|tizen6> [TV_IP]");
  }

  const repositoryRoot = resolve(import.meta.dirname, "..");
  const configurationPath = resolve(repositoryRoot, ".tizen-devices.local");
  const targetIp = explicitIp || readDeviceIp({ variant, configurationPath });
  if (!validateDeviceIp(targetIp)) {
    throw new Error(
      `Set ${variant.toUpperCase()}_TV_IP in .tizen-devices.local or pass a valid IPv4 address after --.`,
    );
  }

  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  runStep(npm, ["run", `prepare:${variant}:personal`], { cwd: repositoryRoot });

  if (!process.stdin.isTTY) {
    throw new Error("Interactive terminal required: the VS Code signed-package action must run before deployment.");
  }
  const prompt = createInterface({ input: process.stdin, output: process.stdout });
  try {
    await prompt.question(
      `\nIn VS Code, build/sign the Tizen project so tizen/Debug/tizen.wgt is created.\nPress Enter when it is ready (Ctrl+C to cancel): `,
    );
  } finally {
    prompt.close();
  }

  runStep(npm, ["run", `collect:${variant}`], { cwd: repositoryRoot });
  runStep(npm, ["run", `launch:${variant}`, "--", targetIp], { cwd: repositoryRoot });
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
