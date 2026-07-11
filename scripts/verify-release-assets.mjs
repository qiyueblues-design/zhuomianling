import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isForbiddenReleasePath } from "./release-asset-policy.mjs";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDirectory, "..");
const distRoot = path.join(projectRoot, "dist");
const rendererLive2DRoot = path.join(distRoot, "renderer", "live2d");
const requiredReleaseFiles = [
  path.join(distRoot, "main", "index.js"),
  path.join(distRoot, "preload", "index.js"),
  path.join(distRoot, "preload", "pet.js"),
  path.join(distRoot, "renderer", "index.html"),
  path.join(distRoot, "renderer", "pet.html")
];

async function pathExists(targetPath) {
  try {
    await stat(targetPath);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") {
      return false;
    }

    throw error;
  }
}

async function collectFiles(directoryPath) {
  const entries = await readdir(directoryPath, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const entryPath = path.join(directoryPath, entry.name);

    if (entry.isDirectory()) {
      files.push(...await collectFiles(entryPath));
    } else if (entry.isFile()) {
      files.push(entryPath);
    }
  }

  return files;
}

if (!await pathExists(distRoot)) {
  console.error("Release asset audit failed: dist does not exist. Run the build first.");
  process.exit(1);
}

const distFiles = await collectFiles(distRoot);
const violations = new Set();

for (const requiredFile of requiredReleaseFiles) {
  if (!await pathExists(requiredFile)) {
    violations.add(`${path.relative(projectRoot, requiredFile)} (required file missing)`);
  }
}

if (await pathExists(rendererLive2DRoot)) {
  for (const filePath of await collectFiles(rendererLive2DRoot)) {
    violations.add(path.relative(projectRoot, filePath));
  }
}

for (const filePath of distFiles) {
  const relativePath = path.relative(projectRoot, filePath);

  if (isForbiddenReleasePath(relativePath)) {
    violations.add(relativePath);
  }
}

if (violations.size > 0) {
  console.error("Release asset audit failed. Remove these local/private resources from the build output:");

  for (const violation of [...violations].sort()) {
    console.error(`- ${violation}`);
  }

  process.exit(1);
}

console.log(`Release asset audit passed (${distFiles.length} files checked).`);
