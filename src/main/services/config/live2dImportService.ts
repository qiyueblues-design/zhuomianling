import { dialog } from "electron";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { Live2DFolderScanResult, Live2DFolderSelectResult, Live2DGeneratedEntryResult, Live2DImportedSource, Live2DImportedSourceScanResult, Live2DModelFormat, Live2DModelImportRequest, Live2DModelImportResult, Live2DPreviewModelResult, Live2DResourceCheck } from "../../../shared/types/live2dImport";
import type { PetDefinition, PetExpressionSourceItem, PetFeature } from "../../../shared/types/pet";
import { assertValidPetId } from "../../../shared/validation/petId";
import { writeTextFileAtomically } from "./durableJsonFile";
import {
  getLocalPetConfigPath,
  getLocalPetDirectoryPath,
  getLocalPetsRootPath,
  writePetConfigFileAtomically
} from "./petConfigPersistence";
import { withPetConfigWriteLock } from "./petConfigWriteQueue";
import { registerPetResourcePreviewRoot, toPetPreviewResourceUrl, toPetResourceUrl } from "./petResourceProtocol";

const live2dDirectoryName = "live2d";
const maxModelSearchDepth = 4;
const generatedModelFileName = "desktop-pet.generated.model3.json";
const live2dStagingDirectoryPrefix = ".live2d-staging-";
const live2dBackupDirectoryPrefix = ".live2d-backup-";
const live2dTransactionMarkerFileName = ".desktop-pet-import-transaction.json";
const transactionDirectoryPattern = /^\.live2d-(staging|backup)-([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i;

interface Model3Json {
  FileReferences?: Live2DFileReferences;
}

interface ModelJsonV2 {
  model?: string;
  textures?: string[];
  motions?: Record<string, Array<{ file?: string; File?: string }> | undefined>;
  expressions?: Array<{ name?: string; Name?: string; file?: string; File?: string }>;
  physics?: string;
  pose?: string;
}

interface Live2DFileReferences {
  Moc?: string;
  Textures?: string[];
  Motions?: Record<string, Array<{ File?: string }> | undefined>;
  Expressions?: Array<{ Name?: string; File?: string }>;
}

interface Live2DScanMetadata {
  parsed: Model3Json;
  modelDirectoryPath: string;
  motionReferences: string[];
  expressionReferences: string[];
  fallbackMotionFiles: string[];
  fallbackExpressionFiles: string[];
}

interface Live2DTransactionPaths {
  transactionId: string;
  petDirectoryPath: string;
  targetDirectoryPath: string;
  stagingDirectoryPath: string;
  backupDirectoryPath: string;
}

interface Live2DTransactionMarker {
  version: 1;
  transactionId: string;
}

function getPetsRootPath(): string {
  return getLocalPetsRootPath();
}

function getPetDirectoryPath(petId: string): string {
  return getLocalPetDirectoryPath(petId);
}

function getPetConfigPath(petId: string): string {
  return getLocalPetConfigPath(petId);
}

function isPathInsideOrEqual(parentPath: string, targetPath: string): boolean {
  const relativePath = path.relative(path.resolve(parentPath), path.resolve(targetPath));

  return !relativePath || (!relativePath.startsWith("..") && !path.isAbsolute(relativePath));
}

function emptyScanResult(message: string, folderPath?: string): Live2DFolderScanResult {
  return {
    ok: false,
    message,
    folderPath,
    checks: [
      buildCheck("entry", "模型入口", "missing", [], [], "未找到 .model3.json 或 model.json 文件。"),
      buildCheck("moc", "Moc 文件", "missing", [], [], "等待检查。"),
      buildCheck("textures", "贴图", "empty", [], [], "等待检查。"),
      buildCheck("motions", "动作", "empty", [], [], "等待检查。"),
      buildCheck("expressions", "表情", "empty", [], [], "等待检查。")
    ],
    missingFiles: [],
    textureCount: 0,
    motionCount: 0,
    expressionCount: 0
  };
}

function buildCheck(
  id: Live2DResourceCheck["id"],
  label: string,
  status: Live2DResourceCheck["status"],
  files: string[],
  missingFiles: string[],
  message: string
): Live2DResourceCheck {
  return {
    id,
    label,
    status,
    count: files.length,
    message,
    files,
    missingFiles
  };
}

function normalizeReferencePath(referencePath: string): string {
  return referencePath.replace(/\\/g, "/");
}

function isInsideDirectory(parentPath: string, targetPath: string): boolean {
  const relativePath = path.relative(path.resolve(parentPath), path.resolve(targetPath));

  return Boolean(relativePath) && !relativePath.startsWith("..") && !path.isAbsolute(relativePath);
}

function assertSafePetSubdirectory(petId: string, subdirectoryName: string): string {
  const validatedPetId = assertValidPetId(petId);
  const petsRootPath = path.resolve(getPetsRootPath());
  const petDirectoryPath = path.resolve(getPetDirectoryPath(validatedPetId));
  const targetDirectoryPath = path.resolve(path.join(petDirectoryPath, subdirectoryName));

  if (
    !isInsideDirectory(petsRootPath, petDirectoryPath) ||
    !isInsideDirectory(petDirectoryPath, targetDirectoryPath)
  ) {
    throw new Error("Invalid pet resource directory.");
  }

  return targetDirectoryPath;
}

async function findModel3Files(directoryPath: string, depth = 0): Promise<string[]> {
  if (depth > maxModelSearchDepth) {
    return [];
  }

  const entries = await fs.readdir(directoryPath, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    const entryPath = path.join(directoryPath, entry.name);

    if (entry.isFile() && entry.name.toLowerCase().endsWith(".model3.json")) {
      files.push(entryPath);
    }
  }

  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) {
      continue;
    }

    files.push(...await findModel3Files(path.join(directoryPath, entry.name), depth + 1));
  }

  return files;
}

async function findModelJsonV2Files(directoryPath: string, depth = 0): Promise<string[]> {
  if (depth > maxModelSearchDepth) {
    return [];
  }

  const entries = await fs.readdir(directoryPath, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    const entryPath = path.join(directoryPath, entry.name);

    if (entry.isFile() && entry.name.toLowerCase() === "model.json") {
      files.push(entryPath);
    }
  }

  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) {
      continue;
    }

    files.push(...await findModelJsonV2Files(path.join(directoryPath, entry.name), depth + 1));
  }

  return files;
}

async function findFilesBySuffixes(
  directoryPath: string,
  suffixes: string[],
  depth = 0
): Promise<string[]> {
  if (depth > maxModelSearchDepth) {
    return [];
  }

  const entries = await fs.readdir(directoryPath, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    const entryPath = path.join(directoryPath, entry.name);
    const lowerName = entry.name.toLowerCase();

    if (entry.isFile() && suffixes.some((suffix) => lowerName.endsWith(suffix))) {
      files.push(entryPath);
    }
  }

  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) {
      continue;
    }

    files.push(...await findFilesBySuffixes(path.join(directoryPath, entry.name), suffixes, depth + 1));
  }

  return files;
}

async function isSafeReferencedFile(
  containmentRootPath: string,
  modelDirectoryPath: string,
  referencePath: string
): Promise<boolean> {
  const normalizedReferencePath = normalizeReferencePath(referencePath);

  if (
    !normalizedReferencePath ||
    normalizedReferencePath.includes("\0") ||
    /^(?:[a-z]:)?\//i.test(normalizedReferencePath)
  ) {
    return false;
  }

  const resolvedReferencePath = path.resolve(modelDirectoryPath, normalizedReferencePath);

  if (!isPathInsideOrEqual(containmentRootPath, resolvedReferencePath)) {
    return false;
  }

  try {
    const [realContainmentRootPath, realReferencePath, stat] = await Promise.all([
      fs.realpath(containmentRootPath),
      fs.realpath(resolvedReferencePath),
      fs.stat(resolvedReferencePath)
    ]);

    return stat.isFile() && isInsideDirectory(realContainmentRootPath, realReferencePath);
  } catch {
    return false;
  }
}

function flattenMotionFiles(motions?: Live2DFileReferences["Motions"]): string[] {
  if (!motions) {
    return [];
  }

  return Object.values(motions).flatMap((motionGroup) =>
    (motionGroup ?? [])
      .map((motion) => motion.File)
      .filter((file): file is string => Boolean(file))
  );
}

function flattenMotionSources(motions?: Live2DFileReferences["Motions"]): Live2DImportedSource[] {
  if (!motions) {
    return [];
  }

  return Object.entries(motions).flatMap(([groupName, motionGroup]) =>
    (motionGroup ?? [])
      .map((motion) => motion.File)
      .filter((file): file is string => Boolean(file))
      .map((file) => ({
        kind: "motion" as const,
        name: groupName,
        file,
        fileName: path.basename(file)
      }))
  );
}

function flattenExpressionSources(expressions?: Live2DFileReferences["Expressions"]): Live2DImportedSource[] {
  return (expressions ?? [])
    .filter((expression): expression is { Name: string; File: string } =>
      Boolean(expression.Name && expression.File)
    )
    .map((expression) => ({
      kind: "expression" as const,
      name: expression.Name,
      file: expression.File,
      fileName: path.basename(expression.File)
    }));
}

function flattenV2MotionFiles(motions?: ModelJsonV2["motions"]): string[] {
  if (!motions) {
    return [];
  }

  return Object.values(motions).flatMap((motionGroup) =>
    (motionGroup ?? [])
      .map((motion) => motion.file ?? motion.File)
      .filter((file): file is string => Boolean(file))
  );
}

function flattenV2MotionSources(motions?: ModelJsonV2["motions"]): Live2DImportedSource[] {
  if (!motions) {
    return [];
  }

  return Object.entries(motions).flatMap(([groupName, motionGroup]) =>
    (motionGroup ?? [])
      .map((motion) => motion.file ?? motion.File)
      .filter((file): file is string => Boolean(file))
      .map((file) => ({
        kind: "motion" as const,
        name: groupName,
        file,
        fileName: path.basename(file)
      }))
  );
}

function flattenV2ExpressionSources(expressions?: ModelJsonV2["expressions"]): Live2DImportedSource[] {
  return (expressions ?? [])
    .map((expression) => ({
      name: expression.name ?? expression.Name,
      file: expression.file ?? expression.File
    }))
    .filter((expression): expression is { name: string; file: string } =>
      Boolean(expression.name && expression.file)
    )
    .map((expression) => ({
      kind: "expression" as const,
      name: expression.name,
      file: expression.file,
      fileName: path.basename(expression.file)
    }));
}

function toMotionGroupName(relativePath: string): string {
  const baseName = path.basename(relativePath, path.extname(relativePath)).toLowerCase();

  if (baseName.includes("idle") || baseName.includes("scene")) {
    return "Idle";
  }

  if (
    baseName.includes("tap") ||
    baseName.includes("touch") ||
    baseName.includes("click") ||
    baseName.includes("boom")
  ) {
    return "Tap";
  }

  const normalized = baseName.replace(/[^a-z0-9]+/gi, "-").replace(/^-+|-+$/g, "");

  return normalized || "Extra";
}

function toExpressionName(relativePath: string): string {
  return path
    .basename(relativePath, path.extname(relativePath))
    .replace(/\.exp3$/i, "")
    .replace(/[^a-z0-9_\-\u4e00-\u9fa5]+/gi, "-")
    .replace(/^-+|-+$/g, "") || "expression";
}

async function writeGeneratedModelEntry(
  targetEntryPath: string,
  scan: Live2DFolderScanResult,
  metadata: Live2DScanMetadata
): Promise<string> {
  const targetModelDirectoryPath = path.dirname(targetEntryPath);
  const generatedEntryPath = path.join(targetModelDirectoryPath, generatedModelFileName);
  const nextModel: Model3Json = {
    ...metadata.parsed,
    FileReferences: {
      ...(metadata.parsed.FileReferences ?? {})
    }
  };
  const fileReferences = nextModel.FileReferences ?? {};

  if (!metadata.motionReferences.length && metadata.fallbackMotionFiles.length) {
    const motionGroups: NonNullable<Live2DFileReferences["Motions"]> = {};

    for (const file of metadata.fallbackMotionFiles) {
      const groupName = toMotionGroupName(file);
      motionGroups[groupName] = [...(motionGroups[groupName] ?? []), { File: file }];
    }

    fileReferences.Motions = motionGroups;
  }

  if (!metadata.expressionReferences.length && metadata.fallbackExpressionFiles.length) {
    fileReferences.Expressions = metadata.fallbackExpressionFiles.map((file) => ({
      Name: toExpressionName(file),
      File: file
    }));
  }

  nextModel.FileReferences = fileReferences;
  await fs.writeFile(generatedEntryPath, `${JSON.stringify(nextModel, null, 2)}\n`, "utf8");

  return generatedEntryPath;
}

async function checkReferencedFiles(
  modelDirectoryPath: string,
  references: string[],
  containmentRootPath: string
): Promise<{ files: string[]; missingFiles: string[] }> {
  const files = references.map(normalizeReferencePath);
  const missingFiles: string[] = [];

  for (let index = 0; index < references.length; index += 1) {
    if (!await isSafeReferencedFile(containmentRootPath, modelDirectoryPath, references[index])) {
      const file = files[index];
      missingFiles.push(file);
    }
  }

  return {
    files,
    missingFiles
  };
}

async function findFallbackRelativeFiles(
  modelDirectoryPath: string,
  suffixes: string[]
): Promise<string[]> {
  const files = await findFilesBySuffixes(modelDirectoryPath, suffixes);

  return files
    .map((filePath) => normalizeReferencePath(path.relative(modelDirectoryPath, filePath)))
    .sort((left, right) => left.localeCompare(right));
}

async function readPetConfig(petId: string): Promise<PetDefinition | undefined> {
  try {
    const content = await fs.readFile(getPetConfigPath(petId), "utf8");
    const parsed = JSON.parse(content) as PetDefinition;

    return parsed.id === petId && parsed.name ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function withLive2DFeatureReady(features: PetFeature[] = []): PetFeature[] {
  const nextFeatures = [...features];
  const index = nextFeatures.findIndex((feature) => feature.title === "Live2D 显示");
  const live2dFeature: PetFeature = {
    title: "Live2D 显示",
    description: "已导入 Live2D 模型文件夹。",
    status: "ready"
  };

  if (index >= 0) {
    nextFeatures[index] = live2dFeature;
  } else {
    nextFeatures.unshift(live2dFeature);
  }

  return nextFeatures;
}

function hasImportedLive2DModel(pet: PetDefinition): boolean {
  return Boolean(pet.modelPath || pet.live2dSettings);
}

function clearLive2DDependentConfig(pet: PetDefinition): PetDefinition {
  const nextPet: PetDefinition = { ...pet };

  delete nextPet.expressions;
  delete nextPet.expressionDescriptions;
  delete nextPet.expressionSourceKinds;
  delete nextPet.expressionSourceFiles;
  delete nextPet.expressionSources;
  delete nextPet.expressionEffects;
  delete nextPet.eventSettings;

  return nextPet;
}

function toPetExpressionSourceItems(sources: Live2DImportedSource[]): PetExpressionSourceItem[] {
  return sources
    .map((source) => ({
      sourceFileName: source.fileName.trim(),
      runtimeName: source.name,
      sourceKind: source.kind
    }))
    .filter((source) => Boolean(source.sourceFileName));
}

async function writePetConfig(
  petId: string,
  pet: PetDefinition,
  backupSource: "current-or-replacement" | "replacement" = "current-or-replacement"
): Promise<void> {
  await writePetConfigFileAtomically(petId, pet, backupSource);
}

export async function validateLive2DFolder(folderPath: string): Promise<Live2DFolderScanResult> {
  const sourceFolderPath = folderPath.trim();

  if (!sourceFolderPath) {
    return emptyScanResult("请选择 Live2D 模型文件夹。");
  }

  let folderStat;

  try {
    folderStat = await fs.stat(sourceFolderPath);
  } catch {
    return emptyScanResult("选择的文件夹不存在。", sourceFolderPath);
  }

  if (!folderStat.isDirectory()) {
    return emptyScanResult("请选择文件夹，而不是单个文件。", sourceFolderPath);
  }

  const modelFiles = await findModel3Files(sourceFolderPath);

  if (!modelFiles.length) {
    return validateLive2DFolderV2(sourceFolderPath);
  }

  const sortedModelFiles = modelFiles.sort((left, right) => {
    const leftIsGenerated = path.basename(left) === generatedModelFileName;
    const rightIsGenerated = path.basename(right) === generatedModelFileName;

    if (leftIsGenerated !== rightIsGenerated) {
      return leftIsGenerated ? -1 : 1;
    }

    const leftDepth = path.relative(sourceFolderPath, left).split(path.sep).length;
    const rightDepth = path.relative(sourceFolderPath, right).split(path.sep).length;

    return leftDepth - rightDepth || left.localeCompare(right);
  });
  const entryFilePath = sortedModelFiles[0];
  const entryRelativePath = normalizeReferencePath(path.relative(sourceFolderPath, entryFilePath));
  const modelDirectoryPath = path.dirname(entryFilePath);

  let parsed: Model3Json;

  try {
    parsed = JSON.parse(await fs.readFile(entryFilePath, "utf8")) as Model3Json;
  } catch {
    return {
      ...emptyScanResult("模型入口 JSON 无法解析。", sourceFolderPath),
      entryFilePath,
      entryFileName: path.basename(entryFilePath),
      entryRelativePath
    };
  }

  const fileReferences = parsed.FileReferences ?? {};
  const mocReferences = fileReferences.Moc ? [fileReferences.Moc] : [];
  const textureReferences = fileReferences.Textures ?? [];
  const motionReferences = flattenMotionFiles(fileReferences.Motions);
  const expressionReferences = (fileReferences.Expressions ?? [])
    .map((expression) => expression.File)
    .filter((file): file is string => Boolean(file));
  const mocFiles = await checkReferencedFiles(modelDirectoryPath, mocReferences, sourceFolderPath);
  const textureFiles = await checkReferencedFiles(modelDirectoryPath, textureReferences, sourceFolderPath);
  const declaredMotionFiles = await checkReferencedFiles(
    modelDirectoryPath,
    motionReferences,
    sourceFolderPath
  );
  const declaredExpressionFiles = await checkReferencedFiles(
    modelDirectoryPath,
    expressionReferences,
    sourceFolderPath
  );
  const fallbackMotionFiles = motionReferences.length
    ? []
    : await findFallbackRelativeFiles(modelDirectoryPath, [".motion3.json"]);
  const fallbackExpressionFiles = expressionReferences.length
    ? []
    : await findFallbackRelativeFiles(modelDirectoryPath, [".exp3.json"]);
  const needsGeneratedEntry = Boolean(
    (!motionReferences.length && fallbackMotionFiles.length) ||
    (!expressionReferences.length && fallbackExpressionFiles.length)
  );
  const motionFiles = motionReferences.length
    ? declaredMotionFiles
    : {
        files: fallbackMotionFiles,
        missingFiles: []
      };
  const expressionFiles = expressionReferences.length
    ? declaredExpressionFiles
    : {
        files: fallbackExpressionFiles,
        missingFiles: []
      };
  const missingFiles = [
    ...mocFiles.missingFiles,
    ...textureFiles.missingFiles,
    ...motionFiles.missingFiles,
    ...expressionFiles.missingFiles
  ];
  const checks = [
    buildCheck("entry", "模型入口", "ready", [entryRelativePath], [], path.basename(entryFilePath)),
    buildCheck(
      "moc",
      "Moc 文件",
      mocFiles.files.length && !mocFiles.missingFiles.length ? "ready" : "missing",
      mocFiles.files,
      mocFiles.missingFiles,
      mocFiles.files.length ? `${mocFiles.files.length} 个` : "未在入口文件中声明 Moc。"
    ),
    buildCheck(
      "textures",
      "贴图",
      textureFiles.missingFiles.length ? "missing" : textureFiles.files.length ? "ready" : "empty",
      textureFiles.files,
      textureFiles.missingFiles,
      textureFiles.files.length ? `${textureFiles.files.length} 个` : "未在入口文件中声明贴图。"
    ),
    buildCheck(
      "motions",
      "动作",
      motionFiles.missingFiles.length
        ? "missing"
        : motionFiles.files.length
          ? motionReferences.length
            ? "ready"
            : "warning"
          : "empty",
      motionFiles.files,
      motionFiles.missingFiles,
      motionFiles.files.length
        ? motionReferences.length
          ? `${motionFiles.files.length} 个`
          : `${motionFiles.files.length} 个（文件夹中找到，入口未声明）`
        : "未在入口文件中声明动作。"
    ),
    buildCheck(
      "expressions",
      "表情",
      expressionFiles.missingFiles.length
        ? "missing"
        : expressionFiles.files.length
          ? expressionReferences.length
            ? "ready"
            : "warning"
          : "empty",
      expressionFiles.files,
      expressionFiles.missingFiles,
      expressionFiles.files.length
        ? expressionReferences.length
          ? `${expressionFiles.files.length} 个`
          : `${expressionFiles.files.length} 个（文件夹中找到，入口未声明）`
        : "未在入口文件中声明表情。"
    )
  ];
  const ok = !missingFiles.length && Boolean(mocFiles.files.length);

  return {
    ok,
    message: ok ? "Live2D 资源检查通过。" : "Live2D 资源不完整，请检查缺失文件。",
    modelFormat: "cubism4-5",
    folderPath: sourceFolderPath,
    entryFilePath,
    entryFileName: path.basename(entryFilePath),
    entryRelativePath,
    generatedEntryFileName: needsGeneratedEntry ? generatedModelFileName : undefined,
    needsGeneratedEntry,
    checks,
    missingFiles,
    textureCount: textureFiles.files.length,
    motionCount: motionFiles.files.length,
    expressionCount: expressionFiles.files.length
  };
}

async function validateLive2DFolderV2(sourceFolderPath: string): Promise<Live2DFolderScanResult> {
  const modelFiles = await findModelJsonV2Files(sourceFolderPath);

  if (!modelFiles.length) {
    return emptyScanResult("未找到 .model3.json 或 Cubism 2 model.json 模型入口。", sourceFolderPath);
  }

  const sortedModelFiles = modelFiles.sort((left, right) => {
    const leftDepth = path.relative(sourceFolderPath, left).split(path.sep).length;
    const rightDepth = path.relative(sourceFolderPath, right).split(path.sep).length;

    return leftDepth - rightDepth || left.localeCompare(right);
  });
  const entryFilePath = sortedModelFiles[0];
  const entryRelativePath = normalizeReferencePath(path.relative(sourceFolderPath, entryFilePath));
  const modelDirectoryPath = path.dirname(entryFilePath);

  let parsed: ModelJsonV2;

  try {
    parsed = JSON.parse(await fs.readFile(entryFilePath, "utf8")) as ModelJsonV2;
  } catch {
    return {
      ...emptyScanResult("Cubism 2 模型入口 JSON 无法解析。", sourceFolderPath),
      modelFormat: "cubism2",
      entryFilePath,
      entryFileName: path.basename(entryFilePath),
      entryRelativePath
    };
  }

  const mocReferences = parsed.model ? [parsed.model] : [];
  const textureReferences = parsed.textures ?? [];
  const motionReferences = flattenV2MotionFiles(parsed.motions);
  const expressionReferences = (parsed.expressions ?? [])
    .map((expression) => expression.file ?? expression.File)
    .filter((file): file is string => Boolean(file));
  const mocFiles = await checkReferencedFiles(modelDirectoryPath, mocReferences, sourceFolderPath);
  const textureFiles = await checkReferencedFiles(modelDirectoryPath, textureReferences, sourceFolderPath);
  const motionFiles = motionReferences.length
    ? await checkReferencedFiles(modelDirectoryPath, motionReferences, sourceFolderPath)
    : {
        files: await findFallbackRelativeFiles(modelDirectoryPath, [".mtn"]),
        missingFiles: []
      };
  const expressionFiles = expressionReferences.length
    ? await checkReferencedFiles(modelDirectoryPath, expressionReferences, sourceFolderPath)
    : {
        files: await findFallbackRelativeFiles(modelDirectoryPath, [".exp.json"]),
        missingFiles: []
      };
  const missingFiles = [
    ...mocFiles.missingFiles,
    ...textureFiles.missingFiles,
    ...motionFiles.missingFiles,
    ...expressionFiles.missingFiles
  ];
  const checks = [
    buildCheck("entry", "模型入口", "ready", [entryRelativePath], [], path.basename(entryFilePath)),
    buildCheck(
      "moc",
      "Moc 文件",
      mocFiles.files.length && !mocFiles.missingFiles.length ? "ready" : "missing",
      mocFiles.files,
      mocFiles.missingFiles,
      mocFiles.files.length ? `${mocFiles.files.length} 个` : "未在入口文件中声明 .moc。"
    ),
    buildCheck(
      "textures",
      "贴图",
      textureFiles.missingFiles.length ? "missing" : textureFiles.files.length ? "ready" : "empty",
      textureFiles.files,
      textureFiles.missingFiles,
      textureFiles.files.length ? `${textureFiles.files.length} 个` : "未在入口文件中声明贴图。"
    ),
    buildCheck(
      "motions",
      "动作",
      motionFiles.missingFiles.length ? "missing" : motionFiles.files.length ? "ready" : "empty",
      motionFiles.files,
      motionFiles.missingFiles,
      motionFiles.files.length ? `${motionFiles.files.length} 个` : "未在入口文件中声明动作。"
    ),
    buildCheck(
      "expressions",
      "表情",
      expressionFiles.missingFiles.length ? "missing" : expressionFiles.files.length ? "ready" : "empty",
      expressionFiles.files,
      expressionFiles.missingFiles,
      expressionFiles.files.length ? `${expressionFiles.files.length} 个` : "未在入口文件中声明表情。"
    )
  ];
  const ok = !missingFiles.length && Boolean(mocFiles.files.length);

  return {
    ok,
    message: ok ? "Cubism 2 Live2D 资源检查通过。" : "Cubism 2 Live2D 资源不完整，请检查缺失文件。",
    modelFormat: "cubism2",
    folderPath: sourceFolderPath,
    entryFilePath,
    entryFileName: path.basename(entryFilePath),
    entryRelativePath,
    checks,
    missingFiles,
    textureCount: textureFiles.files.length,
    motionCount: motionFiles.files.length,
    expressionCount: expressionFiles.files.length
  };
}

export async function selectLive2DFolder(): Promise<Live2DFolderSelectResult> {
  const result = await dialog.showOpenDialog({
    title: "选择 Live2D 模型文件夹",
    properties: ["openDirectory"]
  });

  if (result.canceled || !result.filePaths[0]) {
    return {
      ...emptyScanResult("未选择 Live2D 模型文件夹。"),
      canceled: true
    };
  }

  return validateLive2DFolder(result.filePaths[0]);
}

export async function generateLive2DEntry(folderPath: string): Promise<Live2DGeneratedEntryResult> {
  const scan = await validateLive2DFolder(folderPath);

  if (!scan.ok || !scan.entryFilePath || !scan.needsGeneratedEntry) {
    return {
      ok: false,
      message: scan.needsGeneratedEntry ? scan.message : "当前模型入口已经声明动作和表情。",
      scan
    };
  }

  const parsed = JSON.parse(await fs.readFile(scan.entryFilePath, "utf8")) as Model3Json;
  const fileReferences = parsed.FileReferences ?? {};
  const motionReferences = flattenMotionFiles(fileReferences.Motions);
  const expressionReferences = (fileReferences.Expressions ?? [])
    .map((expression) => expression.File)
    .filter((file): file is string => Boolean(file));
  const modelDirectoryPath = path.dirname(scan.entryFilePath);
  const fallbackMotionFiles = motionReferences.length
    ? []
    : await findFallbackRelativeFiles(modelDirectoryPath, [".motion3.json"]);
  const fallbackExpressionFiles = expressionReferences.length
    ? []
    : await findFallbackRelativeFiles(modelDirectoryPath, [".exp3.json"]);
  const generatedEntryPath = await writeGeneratedModelEntry(scan.entryFilePath, scan, {
    parsed,
    modelDirectoryPath,
    motionReferences,
    expressionReferences,
    fallbackMotionFiles,
    fallbackExpressionFiles
  });
  const nextScan = await validateLive2DFolder(folderPath);

  return {
    ok: true,
    message: "已生成补完入口，动作和表情已自动声明。",
    generatedEntryPath,
    scan: nextScan
  };
}

async function scanLive2DSourcesFromDirectory(
  live2dDirectoryPath: string
): Promise<{ ok: boolean; message: string; sources: Live2DImportedSource[] }> {
  const modelFiles = await findModel3Files(live2dDirectoryPath);

  if (!modelFiles.length) {
    const modelJsonV2Files = await findModelJsonV2Files(live2dDirectoryPath);

    if (!modelJsonV2Files.length) {
      return {
        ok: false,
        message: "Live2D 文件夹中没有模型入口。",
        sources: []
      };
    }

    try {
      const parsed = JSON.parse(await fs.readFile(modelJsonV2Files[0], "utf8")) as ModelJsonV2;
      const sources = [
        ...flattenV2ExpressionSources(parsed.expressions),
        ...flattenV2MotionSources(parsed.motions)
      ];

      return {
        ok: true,
        message: sources.length
          ? `已扫描到 ${sources.length} 个 Cubism 2 动作 / 表情源文件。`
          : "Cubism 2 模型入口没有声明动作或表情源文件。",
        sources
      };
    } catch {
      return {
        ok: false,
        message: "Cubism 2 模型入口无法解析。",
        sources: []
      };
    }
  }

  const entryFilePath =
    modelFiles.find((filePath) => path.basename(filePath) === generatedModelFileName) ??
    modelFiles[0];

  try {
    const parsed = JSON.parse(await fs.readFile(entryFilePath, "utf8")) as Model3Json;
    const fileReferences = parsed.FileReferences ?? {};
    const sources = [
      ...flattenExpressionSources(fileReferences.Expressions),
      ...flattenMotionSources(fileReferences.Motions)
    ];

    return {
      ok: true,
      message: sources.length
        ? `已扫描到 ${sources.length} 个动作 / 表情源文件。`
        : "模型入口没有声明动作或表情源文件。",
      sources
    };
  } catch {
    return {
      ok: false,
      message: "Live2D 模型入口无法解析。",
      sources: []
    };
  }
}

export async function createLive2DPreviewModel(folderPath: string): Promise<Live2DPreviewModelResult> {
  const scan = await validateLive2DFolder(folderPath);

  if (!scan.ok || !scan.entryFilePath) {
    return {
      ok: false,
      message: scan.message,
      scan
    };
  }

  const previewRootPath = path.resolve(scan.folderPath ?? folderPath);
  const token = registerPetResourcePreviewRoot(previewRootPath);

  return {
    ok: true,
    message: "可预览当前选择的 Live2D 模型。",
    modelPath: toPetPreviewResourceUrl(token, previewRootPath, scan.entryFilePath),
    scan
  };
}

export async function scanLive2DPreviewSources(
  folderPath: string
): Promise<Live2DImportedSourceScanResult> {
  const scan = await validateLive2DFolder(folderPath);

  if (!scan.ok || !scan.folderPath) {
    return {
      ok: false,
      message: scan.message,
      sources: []
    };
  }

  return scanLive2DSourcesFromDirectory(scan.folderPath);
}

export async function scanImportedLive2DSources(
  petId: string
): Promise<Live2DImportedSourceScanResult> {
  let targetPetId: string;

  try {
    targetPetId = assertValidPetId(petId);
  } catch {
    return {
      ok: false,
      message: "请先保存桌宠并导入 Live2D 模型。",
      sources: []
    };
  }

  if (targetPetId === "new-pet") {
    return {
      ok: false,
      message: "请先保存桌宠并导入 Live2D 模型。",
      sources: []
    };
  }

  const live2dDirectoryPath = assertSafePetSubdirectory(targetPetId, live2dDirectoryName);

  try {
    const stat = await fs.stat(live2dDirectoryPath);

    if (!stat.isDirectory()) {
      throw new Error("Imported Live2D path is not a directory.");
    }
  } catch {
    return {
      ok: false,
      message: "当前桌宠还没有导入 Live2D 文件夹。",
      petId: targetPetId,
      sources: []
    };
  }

  const result = await scanLive2DSourcesFromDirectory(live2dDirectoryPath);

  return {
    ...result,
    petId: targetPetId
  };
}

function createLive2DTransactionPaths(petId: string): Live2DTransactionPaths {
  const transactionId = randomUUID();
  const targetDirectoryPath = assertSafePetSubdirectory(petId, live2dDirectoryName);
  const petDirectoryPath = path.dirname(targetDirectoryPath);

  return {
    transactionId,
    petDirectoryPath,
    targetDirectoryPath,
    stagingDirectoryPath: path.join(
      petDirectoryPath,
      `${live2dStagingDirectoryPrefix}${transactionId}`
    ),
    backupDirectoryPath: path.join(
      petDirectoryPath,
      `${live2dBackupDirectoryPrefix}${transactionId}`
    )
  };
}

function parseTransactionDirectoryName(
  directoryName: string
): { kind: "staging" | "backup"; transactionId: string } | undefined {
  const match = transactionDirectoryPattern.exec(directoryName);

  if (!match) {
    return undefined;
  }

  return {
    kind: match[1].toLowerCase() as "staging" | "backup",
    transactionId: match[2].toLowerCase()
  };
}

async function pathIsDirectory(directoryPath: string): Promise<boolean> {
  try {
    const stat = await fs.lstat(directoryPath);

    if (stat.isSymbolicLink()) {
      throw new Error("Live2D 目录不能是符号链接。");
    }

    return stat.isDirectory();
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }

    throw error;
  }
}

async function ensurePetDirectoryIsContained(petDirectoryPath: string): Promise<boolean> {
  const petsRootPath = path.resolve(getPetsRootPath());
  const resolvedPetDirectoryPath = path.resolve(petDirectoryPath);

  if (!isInsideDirectory(petsRootPath, resolvedPetDirectoryPath)) {
    throw new Error("桌宠目录越出本地桌宠根目录。");
  }

  await fs.mkdir(petsRootPath, { recursive: true });

  try {
    const [petsRootStat, petDirectoryStat] = await Promise.all([
      fs.lstat(petsRootPath),
      fs.lstat(resolvedPetDirectoryPath)
    ]);

    if (
      petsRootStat.isSymbolicLink() ||
      petDirectoryStat.isSymbolicLink() ||
      !petsRootStat.isDirectory() ||
      !petDirectoryStat.isDirectory()
    ) {
      throw new Error("桌宠目录必须是本地桌宠根目录内的真实文件夹。");
    }

    const [realPetsRootPath, realPetDirectoryPath] = await Promise.all([
      fs.realpath(petsRootPath),
      fs.realpath(resolvedPetDirectoryPath)
    ]);

    if (!isInsideDirectory(realPetsRootPath, realPetDirectoryPath)) {
      throw new Error("桌宠目录通过符号链接越出了本地桌宠根目录。");
    }

    return true;
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }

    throw error;
  }
}

function assertKnownTransactionDirectory(
  petDirectoryPath: string,
  transactionDirectoryPath: string,
  expectedKind?: "staging" | "backup"
): void {
  const resolvedPetDirectoryPath = path.resolve(petDirectoryPath);
  const resolvedTransactionDirectoryPath = path.resolve(transactionDirectoryPath);
  const parsed = parseTransactionDirectoryName(path.basename(resolvedTransactionDirectoryPath));

  if (
    path.dirname(resolvedTransactionDirectoryPath) !== resolvedPetDirectoryPath ||
    !parsed ||
    (expectedKind && parsed.kind !== expectedKind)
  ) {
    throw new Error("拒绝处理无法识别的 Live2D 事务目录。");
  }
}

async function removeKnownTransactionDirectory(
  petDirectoryPath: string,
  transactionDirectoryPath: string,
  expectedKind?: "staging" | "backup"
): Promise<void> {
  assertKnownTransactionDirectory(
    petDirectoryPath,
    transactionDirectoryPath,
    expectedKind
  );

  if (!await pathIsDirectory(transactionDirectoryPath)) {
    return;
  }

  await fs.rm(transactionDirectoryPath, { recursive: true, force: false });
}

async function listTransactionDirectories(
  petDirectoryPath: string
): Promise<Array<{ path: string; kind: "staging" | "backup"; transactionId: string }>> {
  let entries;

  try {
    entries = await fs.readdir(petDirectoryPath, { withFileTypes: true });
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }

    throw error;
  }

  return entries.flatMap((entry) => {
    const parsed = parseTransactionDirectoryName(entry.name);

    if (!parsed || !entry.isDirectory() || entry.isSymbolicLink()) {
      return [];
    }

    return [{
      path: path.join(petDirectoryPath, entry.name),
      ...parsed
    }];
  });
}

async function readLive2DTransactionMarker(
  targetDirectoryPath: string
): Promise<Live2DTransactionMarker | undefined> {
  const markerPath = path.join(targetDirectoryPath, live2dTransactionMarkerFileName);

  try {
    const parsed = JSON.parse(await fs.readFile(markerPath, "utf8")) as Partial<Live2DTransactionMarker>;

    if (
      parsed.version !== 1 ||
      typeof parsed.transactionId !== "string" ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        parsed.transactionId
      )
    ) {
      throw new Error("Live2D 导入事务标记已损坏，已停止自动恢复。");
    }

    return parsed as Live2DTransactionMarker;
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }

    throw error;
  }
}

async function recoverInterruptedLive2DTransaction(
  petDirectoryPath: string,
  targetDirectoryPath: string
): Promise<void> {
  const transactions = await listTransactionDirectories(petDirectoryPath);
  const stagingDirectories = transactions.filter(({ kind }) => kind === "staging");
  const backupDirectories = transactions.filter(({ kind }) => kind === "backup");
  const targetExists = await pathIsDirectory(targetDirectoryPath);

  if (!targetExists && backupDirectories.length > 1) {
    throw new Error("发现多个 Live2D 恢复备份，无法安全判断最新版本；已保留所有目录。");
  }

  if (!targetExists && backupDirectories.length === 1) {
    await fs.rename(backupDirectories[0].path, targetDirectoryPath);
  } else if (targetExists) {
    const marker = await readLive2DTransactionMarker(targetDirectoryPath);

    if (marker) {
      const matchingBackup = backupDirectories.find(
        ({ transactionId }) => transactionId === marker.transactionId.toLowerCase()
      );

      if (!backupDirectories.length) {
        const recoveredScan = await validateLive2DFolder(targetDirectoryPath);

        if (!recoveredScan.ok) {
          throw new Error("发现未完成的首次 Live2D 导入，正式目录校验失败；已保留现场。");
        }

        await fs.rm(
          path.join(targetDirectoryPath, live2dTransactionMarkerFileName),
          { force: false }
        );
      } else if (!matchingBackup || backupDirectories.length !== 1) {
        throw new Error("Live2D 导入事务与备份不匹配，已保留现场并停止自动恢复。");
      } else {
        const discardDirectoryPath = path.join(
          petDirectoryPath,
          `${live2dStagingDirectoryPrefix}${randomUUID()}`
        );
        await fs.rename(targetDirectoryPath, discardDirectoryPath);

        try {
          await fs.rename(matchingBackup.path, targetDirectoryPath);
        } catch (error) {
          await fs.rename(discardDirectoryPath, targetDirectoryPath);
          throw error;
        }

        await removeKnownTransactionDirectory(
          petDirectoryPath,
          discardDirectoryPath,
          "staging"
        );
      }
    } else {
      for (const backup of backupDirectories) {
        await removeKnownTransactionDirectory(petDirectoryPath, backup.path, "backup");
      }
    }
  }

  for (const staging of stagingDirectories) {
    await removeKnownTransactionDirectory(petDirectoryPath, staging.path, "staging");
  }
}

async function prepareStagedLive2DModel(
  stagingDirectoryPath: string
): Promise<Live2DFolderScanResult> {
  let scan = await validateLive2DFolder(stagingDirectoryPath);

  if (!scan.ok || !scan.entryFilePath || !scan.entryRelativePath) {
    return scan;
  }

  if (scan.needsGeneratedEntry) {
    const parsed = JSON.parse(await fs.readFile(scan.entryFilePath, "utf8")) as Model3Json;
    const fileReferences = parsed.FileReferences ?? {};
    const motionReferences = flattenMotionFiles(fileReferences.Motions);
    const expressionReferences = (fileReferences.Expressions ?? [])
      .map((expression) => expression.File)
      .filter((file): file is string => Boolean(file));
    const modelDirectoryPath = path.dirname(scan.entryFilePath);
    const fallbackMotionFiles = motionReferences.length
      ? []
      : await findFallbackRelativeFiles(modelDirectoryPath, [".motion3.json"]);
    const fallbackExpressionFiles = expressionReferences.length
      ? []
      : await findFallbackRelativeFiles(modelDirectoryPath, [".exp3.json"]);

    await writeGeneratedModelEntry(scan.entryFilePath, scan, {
      parsed,
      modelDirectoryPath,
      motionReferences,
      expressionReferences,
      fallbackMotionFiles,
      fallbackExpressionFiles
    });
    scan = await validateLive2DFolder(stagingDirectoryPath);
  }

  return scan;
}

async function writeLive2DTransactionMarker(paths: Live2DTransactionPaths): Promise<void> {
  const marker: Live2DTransactionMarker = {
    version: 1,
    transactionId: paths.transactionId
  };

  await writeTextFileAtomically(
    path.join(paths.stagingDirectoryPath, live2dTransactionMarkerFileName),
    `${JSON.stringify(marker)}\n`,
    { mode: 0o600 }
  );
}

async function rollbackLive2DSwitch(
  paths: Live2DTransactionPaths,
  oldDirectoryMoved: boolean,
  stagedDirectoryInstalled: boolean
): Promise<void> {
  let displacedDirectoryPath: string | undefined;

  if (stagedDirectoryInstalled && await pathIsDirectory(paths.targetDirectoryPath)) {
    displacedDirectoryPath = path.join(
      paths.petDirectoryPath,
      `${live2dStagingDirectoryPrefix}${randomUUID()}`
    );
    await fs.rename(paths.targetDirectoryPath, displacedDirectoryPath);
  }

  try {
    if (oldDirectoryMoved && await pathIsDirectory(paths.backupDirectoryPath)) {
      await fs.rename(paths.backupDirectoryPath, paths.targetDirectoryPath);
    }
  } catch (error) {
    if (
      displacedDirectoryPath &&
      !await pathIsDirectory(paths.targetDirectoryPath) &&
      await pathIsDirectory(displacedDirectoryPath)
    ) {
      await fs.rename(displacedDirectoryPath, paths.targetDirectoryPath);
      displacedDirectoryPath = undefined;
    }

    throw error;
  } finally {
    if (displacedDirectoryPath) {
      await removeKnownTransactionDirectory(
        paths.petDirectoryPath,
        displacedDirectoryPath,
        "staging"
      );
    }
  }
}

export async function importLive2DModel(
  request: Live2DModelImportRequest
): Promise<Live2DModelImportResult> {
  if (
    !request ||
    typeof request.petId !== "string" ||
    typeof request.sourceFolderPath !== "string"
  ) {
    return {
      ok: false,
      message: "Live2D 导入参数无效。"
    };
  }

  let petId: string;

  try {
    petId = assertValidPetId(request.petId);
  } catch (error: unknown) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : "桌宠 ID 无效。"
    };
  }

  if (petId === "new-pet") {
    return {
      ok: false,
      message: "请先保存桌宠基础信息，再导入 Live2D 模型。"
    };
  }

  return withPetConfigWriteLock(petId, async () => {
    const paths = createLive2DTransactionPaths(petId);
    let scan: Live2DFolderScanResult | undefined;
    let oldDirectoryMoved = false;
    let stagedDirectoryInstalled = false;
    let configWriteAttempted = false;
    let originalPet: PetDefinition | undefined;
    let operationCommitted = false;

    try {
      if (!await ensurePetDirectoryIsContained(paths.petDirectoryPath)) {
        return {
          ok: false,
          message: "只能给本地创建的桌宠导入 Live2D 模型。",
          petId
        };
      }

      await recoverInterruptedLive2DTransaction(
        paths.petDirectoryPath,
        paths.targetDirectoryPath
      );

      const pet = await readPetConfig(petId);

      if (!pet) {
        return {
          ok: false,
          message: "只能给本地创建的桌宠导入 Live2D 模型。",
          petId
        };
      }

      originalPet = pet;

      const sourceFolderInput = request.sourceFolderPath.trim();

      if (!sourceFolderInput || sourceFolderInput.length > 32_767) {
        throw new Error("Live2D 模型文件夹路径为空或过长。");
      }

      const sourceFolderPath = path.resolve(sourceFolderInput);
      const sourceStat = await fs.lstat(sourceFolderPath);

      if (!sourceStat.isDirectory() || sourceStat.isSymbolicLink()) {
        throw new Error("请选择有效的 Live2D 模型文件夹，且文件夹不能是符号链接。");
      }

      if (isPathInsideOrEqual(sourceFolderPath, paths.petDirectoryPath)) {
        throw new Error("不能从包含当前桌宠数据目录的上级目录导入 Live2D 模型。");
      }

      const sourceRelativeToPet = path.relative(paths.petDirectoryPath, sourceFolderPath);
      const sourceTopLevelName = sourceRelativeToPet.split(path.sep)[0];

      if (
        isPathInsideOrEqual(paths.petDirectoryPath, sourceFolderPath) &&
        parseTransactionDirectoryName(sourceTopLevelName)
      ) {
        throw new Error("不能从 Live2D 导入事务的临时目录再次导入模型。");
      }

      const sourceIsTarget = sourceFolderPath === path.resolve(paths.targetDirectoryPath);
      const sourceInsideTarget = isInsideDirectory(paths.targetDirectoryPath, sourceFolderPath);
      const replacingLive2DModel = hasImportedLive2DModel(pet) &&
        !sourceIsTarget &&
        !sourceInsideTarget;

      await fs.cp(sourceFolderPath, paths.stagingDirectoryPath, {
        recursive: true,
        errorOnExist: true,
        force: false
      });

      if (!await pathIsDirectory(paths.stagingDirectoryPath)) {
        throw new Error("Live2D 模型未能复制到安全暂存目录。");
      }

      scan = await prepareStagedLive2DModel(paths.stagingDirectoryPath);

      if (!scan.ok || !scan.entryRelativePath) {
        throw new Error(scan.message);
      }

      const stagedSourcesScan = await scanLive2DSourcesFromDirectory(
        paths.stagingDirectoryPath
      );
      const importedSources = toPetExpressionSourceItems(stagedSourcesScan.sources);
      await writeLive2DTransactionMarker(paths);

      if (await pathIsDirectory(paths.targetDirectoryPath)) {
        await fs.rename(paths.targetDirectoryPath, paths.backupDirectoryPath);
        oldDirectoryMoved = true;
      }

      await fs.rename(paths.stagingDirectoryPath, paths.targetDirectoryPath);
      stagedDirectoryInstalled = true;

      scan = await validateLive2DFolder(paths.targetDirectoryPath);

      if (!scan.ok || !scan.entryFilePath || !scan.entryRelativePath) {
        throw new Error("Live2D 模型切换后的完整性复验失败。");
      }

      const resolvedModelEntryPath = path.resolve(scan.entryFilePath);

      if (!isInsideDirectory(paths.targetDirectoryPath, resolvedModelEntryPath)) {
        throw new Error("导入后的 Live2D 模型入口越出正式资源目录。");
      }

      const modelPath = toPetResourceUrl(resolvedModelEntryPath);
      const basePet = replacingLive2DModel ? clearLive2DDependentConfig(pet) : pet;
      const nextPet: PetDefinition = {
        ...basePet,
        modelPath,
        live2dSettings: {
          format: scan.modelFormat ?? "cubism4-5",
          entryFileName: path.basename(resolvedModelEntryPath),
          textureCount: scan.textureCount,
          motionCount: scan.motionCount,
          expressionCount: scan.expressionCount
        },
        details: {
          ...basePet.details,
          features: withLive2DFeatureReady(basePet.details.features)
        },
        expressionSources: importedSources
      };

      configWriteAttempted = true;
      await writePetConfig(petId, nextPet);
      await fs.rm(
        path.join(paths.targetDirectoryPath, live2dTransactionMarkerFileName),
        { force: false }
      );

      operationCommitted = true;
      let backupCleanupWarning = "";

      if (oldDirectoryMoved) {
        try {
          await removeKnownTransactionDirectory(
            paths.petDirectoryPath,
            paths.backupDirectoryPath,
            "backup"
          );
        } catch (cleanupError) {
          console.error("Failed to clean Live2D backup directory.", cleanupError);
          backupCleanupWarning = " 旧模型备份暂未清理，将在下次导入前重试。";
        }
      }

      return {
        ok: true,
        message: [
          replacingLive2DModel
            ? "Live2D 模型已替换。人设、事件文案和语音设置已保留；旧模型绑定的动作、表情与事件映射已清空，请重新绑定。"
            : "Live2D 模型已导入。",
          importedSources.length
            ? `已自动扫描到 ${importedSources.length} 个动作 / 表情源。`
            : stagedSourcesScan.ok
              ? "没有扫描到可绑定的动作 / 表情源。"
              : stagedSourcesScan.message
        ].join(" ") + backupCleanupWarning,
        petId,
        pet: nextPet,
        modelPath,
        scan
      };
    } catch (error: unknown) {
      let recoveryError: unknown;

      if (oldDirectoryMoved || stagedDirectoryInstalled) {
        try {
          await rollbackLive2DSwitch(
            paths,
            oldDirectoryMoved,
            stagedDirectoryInstalled
          );
        } catch (rollbackError) {
          recoveryError = rollbackError;
        }
      }

      if (configWriteAttempted && originalPet) {
        try {
          await writePetConfig(petId, originalPet, "replacement");
        } catch (configRecoveryError) {
          recoveryError = recoveryError ?? configRecoveryError;
        }
      }

      const errorMessage = error instanceof Error ? error.message : "未知错误";
      const recoveryMessage = recoveryError
        ? " 自动回滚未完全成功，事务目录已保留，请勿手动覆盖。"
        : " 旧模型已保留。";

      return {
        ok: false,
        message: `Live2D 模型导入失败：${errorMessage}${recoveryMessage}`,
        petId,
        scan
      };
    } finally {
      if (!operationCommitted) {
        try {
          await removeKnownTransactionDirectory(
            paths.petDirectoryPath,
            paths.stagingDirectoryPath,
            "staging"
          );
        } catch (cleanupError) {
          console.error("Failed to clean Live2D staging directory.", cleanupError);
        }
      }
    }
  });
}
