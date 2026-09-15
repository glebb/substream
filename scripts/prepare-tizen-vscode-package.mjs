import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";

const variant = process.argv[2];
if (variant !== "tizen3" && variant !== "tizen6") {
  throw new Error("Usage: node scripts/prepare-tizen-vscode-package.mjs <tizen3|tizen6>");
}

const repositoryRoot = resolve(import.meta.dirname, "..");
const viteCli = resolve(repositoryRoot, "node_modules", "vite", "bin", "vite.js");
const buildEnvironment = {
  ...process.env,
  TIZEN_COMPAT_TARGET: variant === "tizen6" ? "tizen6" : undefined,
};
if (buildEnvironment.TIZEN_COMPAT_TARGET === undefined) delete buildEnvironment.TIZEN_COMPAT_TARGET;

const result = spawnSync(process.execPath, [viteCli, "build", "--outDir", "tizen/dist"], {
  cwd: repositoryRoot,
  env: buildEnvironment,
  stdio: "inherit",
});
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);

writeFileSync(resolve(repositoryRoot, "tizen", ".package-variant"), `${variant}\n`, "utf8");
console.log(`Prepared ${variant}. In VS Code, run your usual Tizen signed-package action, then run: npm run collect:${variant}`);
