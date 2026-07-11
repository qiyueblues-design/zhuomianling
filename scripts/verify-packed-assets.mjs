import { listPackage } from "@electron/asar";
import { stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  isForbiddenReleasePath,
  isProductionNodeModulePath
} from "./release-asset-policy.mjs";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDirectory, "..");
const asarPath = path.join(projectRoot, "release", "win-unpacked", "resources", "app.asar");

let asarStat;

try {
  asarStat = await stat(asarPath);
} catch (error) {
  console.error(
    error?.code === "ENOENT"
      ? "Packed asset audit failed: app.asar does not exist. Run the package command first."
      : `Packed asset audit failed: ${error instanceof Error ? error.message : String(error)}`
  );
  process.exit(1);
}

const entries = await listPackage(asarPath);
const forbiddenEntries = entries.filter(isForbiddenReleasePath);
const productionModuleEntries = entries.filter(isProductionNodeModulePath);

if (forbiddenEntries.length || productionModuleEntries.length) {
  console.error("Packed asset audit failed. The generated app.asar contains forbidden entries:");

  for (const entry of [...forbiddenEntries, ...productionModuleEntries].sort()) {
    console.error(`- ${entry}`);
  }

  process.exit(1);
}

console.log(
  `Packed asset audit passed (${entries.length} entries, ${asarStat.size} bytes, no production node_modules).`
);
