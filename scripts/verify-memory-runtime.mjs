import { createHash } from "node:crypto";
import { lstat, readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const rootArgumentIndex = process.argv.indexOf("--root");
const runtimeRoot = rootArgumentIndex >= 0
  ? path.resolve(process.argv[rootArgumentIndex + 1] ?? "")
  : path.join(projectRoot, ".cache", "memory-sidecar-release");
const manifestPath = path.join(runtimeRoot, "runtime-manifest.json");
const expectedTopLevel = new Set([
  "model",
  "runtime",
  "sidecar",
  "site-packages",
  "third-party-licenses",
  "runtime-manifest.json"
]);
const expectedModelFiles = new Set([
  "asset-manifest.json",
  "config.json",
  "onnx/model_int8.onnx",
  "special_tokens_map.json",
  "tokenizer.json",
  "tokenizer_config.json",
  "vocab.txt"
]);
const forbiddenNames = new Set([
  "pet.local.json",
  "secure-secrets.json",
  "ai-connections.json",
  "speech.local.json",
  "ledger.sqlite3",
  "index.sqlite3",
  "model.safetensors",
  "model.fp32.onnx"
]);
const forbiddenSegments = new Set([
  "pets",
  "pending",
  "dead-letter",
  "wheelhouse",
  "__pycache__",
  ".git"
]);
const requiredPackages = new Map([
  ["memu-py", "1.5.1"],
  ["numpy", "2.5.1"],
  ["onnxruntime", "1.27.0"],
  ["tokenizers", "0.23.1"],
  ["flatbuffers", "25.12.19"]
]);

function relativeName(target) {
  return path.relative(runtimeRoot, target).replaceAll(path.sep, "/");
}

async function sha256(target) {
  return createHash("sha256").update(await readFile(target)).digest("hex");
}

async function walk(root) {
  const files = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const target = path.join(root, entry.name);
    const relative = relativeName(target);
    const segments = relative.toLowerCase().split("/");
    if (entry.isSymbolicLink()) throw new Error(`symlink is forbidden: ${relative}`);
    if (segments.some((part) => forbiddenSegments.has(part))) {
      throw new Error(`private/development directory is forbidden: ${relative}`);
    }
    if (forbiddenNames.has(entry.name.toLowerCase())) {
      throw new Error(`private/development file is forbidden: ${relative}`);
    }
    if (entry.isDirectory()) files.push(...await walk(target));
    else if (entry.isFile()) files.push(target);
  }
  return files;
}

async function main() {
  const rootStat = await lstat(runtimeRoot);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error("Prepared memory runtime is missing or unsafe.");
  }
  const topLevel = new Set((await readdir(runtimeRoot)).map((name) => name));
  if (
    topLevel.size !== expectedTopLevel.size ||
    [...topLevel].some((name) => !expectedTopLevel.has(name))
  ) throw new Error("Prepared memory runtime has unexpected top-level assets.");

  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  if (
    manifest.schemaVersion !== 1 ||
    manifest.assetId !== "zhuomianling-memory-sidecar-windows-x64-v1" ||
    manifest.platform !== "win32" ||
    manifest.architecture !== "x64" ||
    manifest.pythonVersion !== "3.13.7" ||
    manifest.python?.archiveSha256 !== "f6cca216a359be84797cabb54149ce5e062afb16cc7567eb7fc51cacb2d86b65" ||
    manifest.python?.runtimeFileSha256?.["python.exe"] !== "d932e5e2f324d57f392e8fd063dcf6d0185be8a664c57c6d24e7762ed02c28ca" ||
    manifest.python?.runtimeFileSha256?.["python313.dll"] !== "41ec4fc4e5bc8b207258590238f7f050b13fdfee84c4a7b1ecff6e945d031a10" ||
    manifest.python?.runtimeFileSha256?.["python313.zip"] !== "56ac04066d302e9ffe247af4f3333cfe55044fba163e5bcc5ef8698d9c54f9d5" ||
    manifest.dependencyLockSha256?.["pylock.toml"] !== "43ca1aa7b76dcbbec8e34909ec93afd043e0fd9e0121ea386525edb4ba607f2c" ||
    manifest.dependencyLockSha256?.["requirements.lock"] !== "0861967341ab42848179c1f1eb1b65354785a6a71e2b41ac10f63aca8e17e511" ||
    manifest.dependencyLockSha256?.["pyproject.toml"] !== "255f0e8996507a6f1c238e56a8ef1db1b7fc3ae205932147491d7cb3f9917347" ||
    manifest.model?.int8Sha256 !== "848c2ccd9277d9b36e830d1cc6c27644b78764b210d7409078d7db6f06b6ed20"
  ) throw new Error("Prepared memory runtime manifest is incompatible.");

  const modelManifest = JSON.parse(
    await readFile(path.join(runtimeRoot, "model", "asset-manifest.json"), "utf8")
  );
  if (
    modelManifest.source?.modelId !== "BAAI/bge-small-zh-v1.5" ||
    modelManifest.source?.revision !== "7999e1d3359715c523056ef9478215996d62a620" ||
    modelManifest.source?.declaredLicense !== "MIT" ||
    modelManifest.conversion?.producer !== "desktop-pet-memory-sidecar" ||
    modelManifest.output?.sha256 !== manifest.model.int8Sha256
  ) throw new Error("Prepared memory model was not produced from the approved official source.");

  const packageInventory = JSON.parse(
    await readFile(
      path.join(runtimeRoot, "third-party-licenses", "package-inventory.json"),
      "utf8"
    )
  );
  if (packageInventory.schemaVersion !== 1 || !Array.isArray(packageInventory.packages)) {
    throw new Error("Prepared memory package inventory is invalid.");
  }
  for (const [name, version] of requiredPackages) {
    if (!packageInventory.packages.some(
      (entry) => entry?.name?.toLowerCase() === name && entry?.version === version && entry?.license
    )) throw new Error(`Required memory package attribution is missing: ${name} ${version}`);
  }

  const actualFiles = (await walk(runtimeRoot)).filter((file) => file !== manifestPath);
  const allowedFiles = Object.keys(manifest.files ?? {});
  if (
    actualFiles.length !== manifest.fileCount ||
    allowedFiles.length !== manifest.fileCount ||
    actualFiles.length > 8_000
  ) throw new Error("Prepared memory runtime file count does not match its whitelist.");

  let totalBytes = 0;
  for (const file of actualFiles) {
    const relative = relativeName(file);
    if (!manifest.files[relative]) throw new Error(`Unlisted runtime asset: ${relative}`);
    const details = await stat(file);
    const expected = manifest.files[relative];
    totalBytes += details.size;
    if (details.size !== expected.bytes || await sha256(file) !== expected.sha256) {
      throw new Error(`Runtime asset failed hash verification: ${relative}`);
    }
  }
  if (totalBytes !== manifest.totalBytes || totalBytes > 250 * 1024 * 1024) {
    throw new Error("Prepared memory runtime size does not match its whitelist.");
  }

  const modelFiles = new Set(
    actualFiles
      .map(relativeName)
      .filter((name) => name.startsWith("model/"))
      .map((name) => name.slice("model/".length))
  );
  if (
    modelFiles.size !== expectedModelFiles.size ||
    [...modelFiles].some((name) => !expectedModelFiles.has(name))
  ) throw new Error("Prepared memory runtime contains an unapproved model asset.");

  for (const required of [
    "runtime/python.exe",
    "runtime/LICENSE.txt",
    "sidecar/desktop_pet_memory_sidecar/__main__.py",
    "site-packages/memu/__init__.py",
    "site-packages/onnxruntime/__init__.py",
    "site-packages/tokenizers/__init__.py",
    "site-packages/numpy/__init__.py",
    "site-packages/onnxruntime/ThirdPartyNotices.txt",
    "third-party-licenses/package-inventory.json",
    "third-party-licenses/ADDITIONAL-NOTICES.md",
    "third-party-licenses/PROJECT-NOTICE.txt",
    "third-party-licenses/PYTHON-LICENSE.txt",
    "third-party-licenses/standards/MIT.txt",
    "third-party-licenses/standards/Apache-2.0.txt",
    "third-party-licenses/standards/MPL-2.0.txt"
  ]) {
    if (!manifest.files[required]) throw new Error(`Required memory runtime asset is missing: ${required}`);
  }
  console.log(`Memory runtime audit passed (${manifest.fileCount} files, ${manifest.totalBytes} bytes).`);
}

await main().catch((error) => {
  console.error(`Memory runtime audit failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
