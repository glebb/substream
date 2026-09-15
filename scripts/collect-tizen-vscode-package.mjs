import { existsSync, readFileSync, renameSync } from "node:fs";
import { resolve } from "node:path";

const variant = process.argv[2];
if (variant !== "tizen3" && variant !== "tizen6") {
  throw new Error("Usage: node scripts/collect-tizen-vscode-package.mjs <tizen3|tizen6>");
}

const repositoryRoot = resolve(import.meta.dirname, "..");
const tizenProject = resolve(repositoryRoot, "tizen");
const marker = resolve(tizenProject, ".package-variant");
const generatedPackage = resolve(tizenProject, "Debug", "tizen.wgt");
const outputPackage = resolve(tizenProject, "Debug", `${variant}.wgt`);

if (!existsSync(marker) || readFileSync(marker, "utf8").trim() !== variant) {
  throw new Error(`Run npm run prepare:${variant} immediately before signing this package.`);
}
if (!existsSync(generatedPackage)) {
  throw new Error("The VS Code Tizen package is missing. Run the Tizen signed-package action first.");
}

renameSync(generatedPackage, outputPackage);
console.log(`Created ${outputPackage}`);
