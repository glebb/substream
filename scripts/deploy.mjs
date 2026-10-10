import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { deployPersonalWebos } from "./webos.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Target names come from the command or ignored .env, never a production inventory. */
export function resolveDeployment(args, environment = process.env) {
  const [target = environment.LG_WEBOS_DEVICE, ...rest] = args;
  if (target === "tizen3" || target === "tizen6") {
    if (rest.length > 1) throw new Error("Tizen deployment accepts at most one explicit TV address.");
    return { platform: "tizen", args: [target, ...rest] };
  }
  if (rest.length || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(target ?? "")) {
    throw new Error("Usage: npm run deploy <tizen3|tizen6|registered-LG-device>. Set LG_WEBOS_DEVICE in .env for a default LG target.");
  }
  return { platform: "webos", device: target };
}

export function main(args = process.argv.slice(2)) {
  let deployment;
  try { deployment = resolveDeployment(args); }
  catch (error) {
    console.error(error.message);
    process.exitCode = 2;
    return;
  }
  if (deployment.platform === "webos") {
    deployPersonalWebos(deployment.device);
    return;
  }
  // Preserve the existing interactive VS Code build/sign flow for Samsung.
  const result = spawnSync(process.execPath, [path.join(root, "scripts/deploy-tizen-vscode-package.mjs"), ...deployment.args], {
    cwd: root,
    env: process.env,
    stdio: "inherit",
  });
  if (result.error) {
    console.error("Could not start Tizen deployment.");
    process.exitCode = 1;
  } else process.exitCode = result.status ?? 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
