import { createHash } from "node:crypto";
import {
  cp,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  writeFile
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDirectory, "..");
const cacheRoot = path.join(projectRoot, ".cache", "memory-sidecar-python-3.13");
const targetRoot = path.join(projectRoot, ".cache", "memory-sidecar-release");
const stagingRoot = path.join(projectRoot, ".cache", "memory-sidecar-release-staging");
const sourceRuntime = path.join(cacheRoot, "runtime");
const sourcePythonArchive = path.join(cacheRoot, "python-3.13.7-embed-amd64.zip");
const sourceMemu = path.join(cacheRoot, "memu-1.5.1-site-packages");
const sourceOnnx = path.join(cacheRoot, "bge-onnx-site-packages");
const sourceModel = path.join(cacheRoot, "production-bge-int8");
const sourceSidecar = path.join(projectRoot, "sidecar", "memory");

const requiredModelHash = "848c2ccd9277d9b36e830d1cc6c27644b78764b210d7409078d7db6f06b6ed20";
const requiredPythonVersion = "3.13.7";
const requiredPythonArchiveHash = "f6cca216a359be84797cabb54149ce5e062afb16cc7567eb7fc51cacb2d86b65";
const requiredRuntimeFileHashes = {
  "python.exe": "d932e5e2f324d57f392e8fd063dcf6d0185be8a664c57c6d24e7762ed02c28ca",
  "python313.dll": "41ec4fc4e5bc8b207258590238f7f050b13fdfee84c4a7b1ecff6e945d031a10",
  "python313.zip": "56ac04066d302e9ffe247af4f3333cfe55044fba163e5bcc5ef8698d9c54f9d5"
};
const requiredLockHashes = {
  "pylock.toml": "43ca1aa7b76dcbbec8e34909ec93afd043e0fd9e0121ea386525edb4ba607f2c",
  "requirements.lock": "0861967341ab42848179c1f1eb1b65354785a6a71e2b41ac10f63aca8e17e511",
  "pyproject.toml": "255f0e8996507a6f1c238e56a8ef1db1b7fc3ae205932147491d7cb3f9917347"
};
const requiredPackages = new Map([
  ["memu-py", "1.5.1"],
  ["numpy", "2.5.1"],
  ["onnxruntime", "1.27.0"],
  ["tokenizers", "0.23.1"],
  ["flatbuffers", "25.12.19"]
]);
const licenseFallbacks = new Map([
  ["memu-py", "Apache-2.0"],
  ["langchain-core", "MIT"],
  ["langsmith", "MIT"],
  ["loguru", "MIT"],
  ["orderly-set", "MIT"],
  ["tqdm", "MPL-2.0 AND MIT"],
  ["flatbuffers", "Apache-2.0"],
  ["onnxruntime", "MIT"],
  ["tokenizers", "Apache-2.0"]
]);

function normalizedRelative(root, target) {
  return path.relative(root, target).replaceAll(path.sep, "/");
}

function assertGeneratedPath(target) {
  const relative = path.relative(projectRoot, target);
  if (relative.startsWith("..") || path.isAbsolute(relative) || !relative.startsWith(`.cache${path.sep}`)) {
    throw new Error("Memory runtime output escaped the project cache directory.");
  }
}

async function requireDirectory(target, label) {
  const details = await stat(target);
  if (!details.isDirectory() || (await realpath(target)) !== path.resolve(target)) {
    throw new Error(`${label} must be an existing non-symlink directory.`);
  }
}

async function requireFile(target, label) {
  const details = await stat(target);
  if (!details.isFile() || (await realpath(target)) !== path.resolve(target)) {
    throw new Error(`${label} must be an existing non-symlink file.`);
  }
}

async function sha256(target) {
  return createHash("sha256").update(await readFile(target)).digest("hex");
}

async function copyTree(source, destination, filter = () => true, relativeRoot = "") {
  await mkdir(destination, { recursive: true });
  for (const entry of await readdir(source, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) throw new Error("Memory runtime sources must not contain symbolic links.");
    const relative = relativeRoot ? `${relativeRoot}/${entry.name}` : entry.name;
    if (!filter(relative)) continue;
    const sourcePath = path.join(source, entry.name);
    const destinationPath = path.join(destination, entry.name);
    if (entry.isDirectory()) {
      await copyTree(sourcePath, destinationPath, filter, relative);
    } else if (entry.isFile()) {
      await cp(sourcePath, destinationPath, { force: false, errorOnExist: true });
    }
  }
}

async function walkFiles(root) {
  const files = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const entryPath = path.join(root, entry.name);
    if (entry.isSymbolicLink()) throw new Error("Generated runtime must not contain symbolic links.");
    if (entry.isDirectory()) files.push(...await walkFiles(entryPath));
    else if (entry.isFile()) files.push(entryPath);
  }
  return files;
}

function metadataField(text, name) {
  const match = text.match(new RegExp(`^${name}:\\s*(.+)$`, "mi"));
  return match?.[1]?.trim();
}

function classifierLicense(text) {
  const classifiers = [...text.matchAll(/^Classifier:\s*License\s*::\s*OSI Approved\s*::\s*(.+)$/gmi)]
    .map((match) => match[1].trim());
  if (classifiers.some((value) => value.includes("Apache"))) return "Apache-2.0";
  if (classifiers.some((value) => value.includes("MIT"))) return "MIT";
  if (classifiers.some((value) => value.includes("Mozilla"))) return "MPL-2.0";
  if (classifiers.some((value) => value.includes("BSD"))) return "BSD (see included license)";
  if (classifiers.some((value) => value.includes("Python Software Foundation"))) return "PSF-2.0";
  return undefined;
}

async function createPackageInventory(sitePackagesRoot, licenseRoot) {
  const entries = await readdir(sitePackagesRoot, { withFileTypes: true });
  const inventory = [];
  for (const entry of entries.filter((item) => item.isDirectory() && item.name.endsWith(".dist-info"))) {
    const distRoot = path.join(sitePackagesRoot, entry.name);
    const metadataPath = path.join(distRoot, "METADATA");
    const metadata = await readFile(metadataPath, "utf8");
    const name = metadataField(metadata, "Name");
    const version = metadataField(metadata, "Version");
    if (!name || !version) throw new Error(`Invalid package metadata: ${entry.name}`);
    const copiedLicenses = [];
    for (const file of await walkFiles(distRoot)) {
      if (!/^(license|copying|notice)/i.test(path.basename(file))) continue;
      const relative = normalizedRelative(distRoot, file);
      const destination = path.join(licenseRoot, "packages", entry.name, relative);
      await mkdir(path.dirname(destination), { recursive: true });
      await cp(file, destination, { force: false, errorOnExist: true });
      copiedLicenses.push(normalizedRelative(licenseRoot, destination));
    }
    let license = metadataField(metadata, "License-Expression") ?? metadataField(metadata, "License");
    if (!license) license = licenseFallbacks.get(name.toLowerCase()) ?? classifierLicense(metadata);
    if (!license && copiedLicenses.length > 0) license = "See included upstream license file";
    if (!license) throw new Error(`Package has no auditable license declaration: ${name}`);
    const metadataDestination = path.join(licenseRoot, "metadata", `${entry.name}.METADATA`);
    await mkdir(path.dirname(metadataDestination), { recursive: true });
    await cp(metadataPath, metadataDestination, { force: false, errorOnExist: true });
    inventory.push({ name, version, license, licenseFiles: copiedLicenses.sort() });
  }
  inventory.sort((left, right) => left.name.localeCompare(right.name));
  for (const [name, version] of requiredPackages) {
    if (!inventory.some((entry) => entry.name.toLowerCase() === name && entry.version === version)) {
      throw new Error(`Required locked package is missing: ${name} ${version}`);
    }
  }
  return inventory;
}

async function main() {
  for (const [target, label] of [
    [sourceRuntime, "Python runtime"],
    [sourceMemu, "memU dependencies"],
    [sourceOnnx, "ONNX dependencies"],
    [sourceModel, "production BGE model"],
    [sourceSidecar, "memory sidecar source"]
  ]) await requireDirectory(target, label);
  await requireFile(sourcePythonArchive, "Python embeddable archive");
  if (await sha256(sourcePythonArchive) !== requiredPythonArchiveHash) {
    throw new Error("Python embeddable archive hash does not match the pinned M10 asset.");
  }
  for (const [name, expectedHash] of Object.entries(requiredRuntimeFileHashes)) {
    if (await sha256(path.join(sourceRuntime, name)) !== expectedHash) {
      throw new Error(`Python runtime file hash does not match its official archive: ${name}`);
    }
  }
  for (const [name, expectedHash] of Object.entries(requiredLockHashes)) {
    if (await sha256(path.join(sourceSidecar, name)) !== expectedHash) {
      throw new Error(`Memory dependency lock changed without an M10 baseline update: ${name}`);
    }
  }

  const modelPath = path.join(sourceModel, "onnx", "model_int8.onnx");
  if (await sha256(modelPath) !== requiredModelHash) {
    throw new Error("Production BGE model hash does not match the pinned M10 asset.");
  }
  assertGeneratedPath(stagingRoot);
  assertGeneratedPath(targetRoot);
  await rm(stagingRoot, { recursive: true, force: true });
  await mkdir(stagingRoot, { recursive: true });

  await copyTree(sourceRuntime, path.join(stagingRoot, "runtime"), (relative) => {
    const first = relative.split("/")[0]?.toLowerCase();
    return first !== "lib" && first !== "scripts";
  });
  await mkdir(path.join(stagingRoot, "site-packages"), { recursive: true });
  const packageFilter = (relative) => !relative.split("/").some(
    (part) => part === "__pycache__" || part.endsWith(".pyc") || part.endsWith(".pyo")
  );
  await copyTree(sourceMemu, path.join(stagingRoot, "site-packages"), packageFilter);
  await copyTree(sourceOnnx, path.join(stagingRoot, "site-packages"), packageFilter);
  await copyTree(
    path.join(sourceSidecar, "desktop_pet_memory_sidecar"),
    path.join(stagingRoot, "sidecar", "desktop_pet_memory_sidecar"),
    packageFilter
  );
  for (const name of ["pyproject.toml", "requirements.lock", "pylock.toml"]) {
    await cp(path.join(sourceSidecar, name), path.join(stagingRoot, "sidecar", name));
  }
  await copyTree(sourceModel, path.join(stagingRoot, "model"), packageFilter);

  const licenseRoot = path.join(stagingRoot, "third-party-licenses");
  await mkdir(licenseRoot, { recursive: true });
  await cp(path.join(projectRoot, "NOTICE"), path.join(licenseRoot, "PROJECT-NOTICE.txt"));
  await cp(path.join(stagingRoot, "runtime", "LICENSE.txt"), path.join(licenseRoot, "PYTHON-LICENSE.txt"));
  await cp(
    path.join(projectRoot, "third_party", "memory-sidecar", "ADDITIONAL-NOTICES.md"),
    path.join(licenseRoot, "ADDITIONAL-NOTICES.md")
  );
  const inventory = await createPackageInventory(path.join(stagingRoot, "site-packages"), licenseRoot);
  await mkdir(path.join(licenseRoot, "standards"), { recursive: true });
  const standardSources = {
    "MIT.txt": path.join(stagingRoot, "site-packages", "alembic-1.18.5.dist-info", "licenses", "LICENSE"),
    "Apache-2.0.txt": path.join(stagingRoot, "site-packages", "requests-2.34.2.dist-info", "licenses", "LICENSE"),
    "MPL-2.0.txt": path.join(stagingRoot, "site-packages", "orjson-3.11.9.dist-info", "licenses", "LICENSE-MPL-2.0")
  };
  for (const [name, source] of Object.entries(standardSources)) {
    await cp(source, path.join(licenseRoot, "standards", name));
  }
  await writeFile(
    path.join(licenseRoot, "package-inventory.json"),
    `${JSON.stringify({ schemaVersion: 1, packages: inventory }, null, 2)}\n`,
    "utf8"
  );

  const pythonVersion = await readFile(path.join(stagingRoot, "runtime", "python313._pth"), "utf8");
  if (!pythonVersion.includes("python313.zip")) throw new Error("Python runtime layout is incompatible.");
  const files = await walkFiles(stagingRoot);
  const fileEntries = {};
  let totalBytes = 0;
  for (const file of files.sort()) {
    const relative = normalizedRelative(stagingRoot, file);
    const details = await stat(file);
    totalBytes += details.size;
    fileEntries[relative] = { bytes: details.size, sha256: await sha256(file) };
  }
  const manifest = {
    schemaVersion: 1,
    assetId: "zhuomianling-memory-sidecar-windows-x64-v1",
    platform: "win32",
    architecture: "x64",
    pythonVersion: requiredPythonVersion,
    python: {
      source: "https://www.python.org/ftp/python/3.13.7/python-3.13.7-embed-amd64.zip",
      archiveSha256: requiredPythonArchiveHash,
      runtimeFileSha256: requiredRuntimeFileHashes
    },
    dependencyLockSha256: requiredLockHashes,
    model: {
      id: "BAAI/bge-small-zh-v1.5",
      revision: "7999e1d3359715c523056ef9478215996d62a620",
      int8Sha256: requiredModelHash
    },
    fileCount: files.length,
    totalBytes,
    files: fileEntries
  };
  await writeFile(
    path.join(stagingRoot, "runtime-manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf8"
  );

  await rm(targetRoot, { recursive: true, force: true });
  await rename(stagingRoot, targetRoot);
  console.log(`Prepared memory runtime: ${manifest.fileCount} files, ${manifest.totalBytes} bytes.`);
}

await main();
