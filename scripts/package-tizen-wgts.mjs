import { existsSync, readFileSync, renameSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";

const repositoryRoot = resolve(import.meta.dirname, "..");
const tizenProject = resolve(repositoryRoot, "tizen");
const viteCli = resolve(repositoryRoot, "node_modules", "vite", "bin", "vite.js");
const localCliConfiguration = resolve(repositoryRoot, ".tizen-cli.local");

function localTizenCli() {
  if (!existsSync(localCliConfiguration)) return undefined;
  const line = readFileSync(localCliConfiguration, "utf8")
    .split(/\r?\n/)
    .find((candidate) => candidate.startsWith("TIZEN_CLI="));
  const value = line?.slice("TIZEN_CLI=".length).trim();
  return value || undefined;
}

const tizenCli = process.env.TIZEN_CLI || localTizenCli() || process.env.TZ;

if (!tizenCli) {
  console.error("Set TIZEN_CLI, TZ, or .tizen-cli.local to the Samsung Tizen CLI before packaging.");
  process.exit(1);
}

function run(command, arguments_, environment) {
  const childEnvironment = { ...process.env, ...environment };
  for (const [key, value] of Object.entries(childEnvironment)) {
    if (value === undefined) delete childEnvironment[key];
  }
  const result = spawnSync(command, arguments_, {
    cwd: repositoryRoot,
    env: childEnvironment,
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

function buildAndPackage(name, environment) {
  run(process.execPath, [viteCli, "build", "--outDir", "tizen/dist"], environment);
  run(tizenCli, ["pack", `--proj-dir=${tizenProject}`], {});

  const generatedPackage = resolve(tizenProject, "Debug", "tizen.wgt");
  const outputPackage = resolve(tizenProject, "Debug", `${name}.wgt`);
  if (!existsSync(generatedPackage)) {
    throw new Error(`Tizen packaging succeeded but did not produce ${generatedPackage}`);
  }
  // Keep exactly the two requested artifacts. Rename rather than copy so an
  // old, ambiguous Debug/tizen.wgt cannot accidentally be installed.
  renameSync(generatedPackage, outputPackage);
  console.log(`Created ${outputPackage}`);
}

// tizen3 deliberately has no compatibility override: it is the same Vite
// configuration previously used to create Debug/tizen.wgt.
buildAndPackage("tizen3", { TIZEN_COMPAT_TARGET: undefined });
buildAndPackage("tizen6", { TIZEN_COMPAT_TARGET: "tizen6" });
