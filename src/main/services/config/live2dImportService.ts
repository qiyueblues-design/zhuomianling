import { app, dialog } from "electron";
import fs from "node:fs/promises";
import path from "node:path";
import type { Live2DFolderScanResult, Live2DFolderSelectResult, Live2DGeneratedEntryResult, Live2DImportedSource, Live2DImportedSourceScanResult, Live2DModelFormat, Live2DModelImportRequest, Live2DModelImportResult, Live2DPreviewModelResult, Live2DResourceCheck } from "../../../shared/types/live2dImport";
import type { PetDefinition, PetFeature } from "../../../shared/types/pet";
import { registerPetResourcePreviewRoot, toPetPreviewResourceUrl, toPetResourceUrl } from "./petResourceProtocol";

const localPetsDirectoryName = "pets";
const localPetFileName = "pet.local.json";
const live2dDirectoryName = "live2d";
const maxModelSearchDepth = 4;
const generatedModelFileName = "desktop-pet.generated.model3.json";

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

function getPetsRootPath(): string {
  return path.join(app.getPath("userData"), localPetsDirectoryName);
}

function getPetDirectoryPath(petId: string): string {
  return path.join(getPetsRootPath(), petId);
}

function getPetConfigPath(petId: string): string {
  return path.join(getPetDirectoryPath(petId), localPetFileName);
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
  return referencePath.replace(/\\/g, "/").replace(/^\/+/, "");
}

function isInsideDirectory(parentPath: string, targetPath: string): boolean {
  const relativePath = path.relative(path.resolve(parentPath), path.resolve(targetPath));

  return Boolean(relativePath) && !relativePath.startsWith("..") && !path.isAbsolute(relativePath);
}

function assertSafePetSubdirectory(petId: string, subdirectoryName: string): string {
  const petDirectoryPath = path.resolve(getPetDirectoryPath(petId));
  const targetDirectoryPath = path.resolve(path.join(petDirectoryPath, subdirectoryName));
  const relativePath = path.relative(petDirectoryPath, targetDirectoryPath);

  if (!relativePath || relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
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

async function fileExists(filePath: string): Promise<boolean> {
  try {
    const stat = await fs.stat(filePath);

    return stat.isFile();
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
  references: string[]
): Promise<{ files: string[]; missingFiles: string[] }> {
  const files = references.map(normalizeReferencePath);
  const missingFiles: string[] = [];

  for (const file of files) {
    if (!await fileExists(path.join(modelDirectoryPath, file))) {
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

    return parsed.id && parsed.name ? parsed : undefined;
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
  const nextPet: PetDefinition = {
    ...pet,
    personaPrompt: "",
    capabilities: {
      ...pet.capabilities,
      voiceOutput: false
    }
  };

  delete nextPet.defaultVoice;
  delete nextPet.personaSettings;
  delete nextPet.voiceModelSettings;
  delete nextPet.expressions;
  delete nextPet.expressionDescriptions;
  delete nextPet.expressionSourceKinds;
  delete nextPet.expressionSourceFiles;
  delete nextPet.expressionSources;
  delete nextPet.expressionEffects;
  delete nextPet.eventSettings;
  delete nextPet.lines;

  return nextPet;
}

async function writePetConfig(pet: PetDefinition): Promise<void> {
  await fs.writeFile(getPetConfigPath(pet.id), `${JSON.stringify(pet, null, 2)}\n`, "utf8");
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
  const mocFiles = await checkReferencedFiles(modelDirectoryPath, mocReferences);
  const textureFiles = await checkReferencedFiles(modelDirectoryPath, textureReferences);
  const declaredMotionFiles = await checkReferencedFiles(modelDirectoryPath, motionReferences);
  const declaredExpressionFiles = await checkReferencedFiles(modelDirectoryPath, expressionReferences);
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
  const mocFiles = await checkReferencedFiles(modelDirectoryPath, mocReferences);
  const textureFiles = await checkReferencedFiles(modelDirectoryPath, textureReferences);
  const motionFiles = motionReferences.length
    ? await checkReferencedFiles(modelDirectoryPath, motionReferences)
    : {
        files: await findFallbackRelativeFiles(modelDirectoryPath, [".mtn"]),
        missingFiles: []
      };
  const expressionFiles = expressionReferences.length
    ? await checkReferencedFiles(modelDirectoryPath, expressionReferences)
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
  if (!petId || petId === "new-pet") {
    return {
      ok: false,
      message: "请先保存桌宠并导入 Live2D 模型。",
      sources: []
    };
  }

  const live2dDirectoryPath = assertSafePetSubdirectory(petId, live2dDirectoryName);

  try {
    const stat = await fs.stat(live2dDirectoryPath);

    if (!stat.isDirectory()) {
      throw new Error("Imported Live2D path is not a directory.");
    }
  } catch {
    return {
      ok: false,
      message: "当前桌宠还没有导入 Live2D 文件夹。",
      petId,
      sources: []
    };
  }

  const result = await scanLive2DSourcesFromDirectory(live2dDirectoryPath);

  return {
    ...result,
    petId
  };
}

export async function importLive2DModel(
  request: Live2DModelImportRequest
): Promise<Live2DModelImportResult> {
  const petId = request.petId.trim();

  if (!petId || petId === "new-pet") {
    return {
      ok: false,
      message: "请先保存桌宠基础信息，再导入 Live2D 模型。"
    };
  }

  const pet = await readPetConfig(petId);

  if (!pet) {
    return {
      ok: false,
      message: "只能给本地创建的桌宠导入 Live2D 模型。",
      petId
    };
  }

  const scan = await validateLive2DFolder(request.sourceFolderPath);

  if (!scan.ok || !scan.entryRelativePath) {
    return {
      ok: false,
      message: scan.message,
      petId,
      scan
    };
  }

  const sourceFolderPath = path.resolve(request.sourceFolderPath);
  const targetDirectoryPath = assertSafePetSubdirectory(petId, live2dDirectoryName);
  const sourceIsTarget = sourceFolderPath === path.resolve(targetDirectoryPath);
  const sourceInsideTarget = isInsideDirectory(targetDirectoryPath, sourceFolderPath);
  const replacingLive2DModel = hasImportedLive2DModel(pet) && !sourceIsTarget && !sourceInsideTarget;

  if (!sourceIsTarget && !sourceInsideTarget) {
    await fs.rm(targetDirectoryPath, { recursive: true, force: true });
    await fs.mkdir(path.dirname(targetDirectoryPath), { recursive: true });
    await fs.cp(sourceFolderPath, targetDirectoryPath, { recursive: true });
  }

  const targetEntryPath = sourceIsTarget || sourceInsideTarget
    ? scan.entryFilePath
    : path.join(targetDirectoryPath, scan.entryRelativePath);
  const modelDirectoryPath = scan.entryFilePath ? path.dirname(scan.entryFilePath) : undefined;
  let modelEntryPath = targetEntryPath;

  if (scan.needsGeneratedEntry && targetEntryPath && modelDirectoryPath) {
    const parsed = JSON.parse(await fs.readFile(targetEntryPath, "utf8")) as Model3Json;
    const fileReferences = parsed.FileReferences ?? {};
    const motionReferences = flattenMotionFiles(fileReferences.Motions);
    const expressionReferences = (fileReferences.Expressions ?? [])
      .map((expression) => expression.File)
      .filter((file): file is string => Boolean(file));
    const fallbackMotionFiles = motionReferences.length
      ? []
      : await findFallbackRelativeFiles(path.dirname(targetEntryPath), [".motion3.json"]);
    const fallbackExpressionFiles = expressionReferences.length
      ? []
      : await findFallbackRelativeFiles(path.dirname(targetEntryPath), [".exp3.json"]);

    modelEntryPath = await writeGeneratedModelEntry(targetEntryPath, scan, {
      parsed,
      modelDirectoryPath: path.dirname(targetEntryPath),
      motionReferences,
      expressionReferences,
      fallbackMotionFiles,
      fallbackExpressionFiles
    });
  }

  const resolvedModelEntryPath = modelEntryPath;
  const modelPath = resolvedModelEntryPath ? toPetResourceUrl(resolvedModelEntryPath) : undefined;

  if (!modelPath || !resolvedModelEntryPath) {
    return {
      ok: false,
      message: "导入后未找到模型入口文件。",
      petId,
      scan
    };
  }

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
    }
  };

  await writePetConfig(nextPet);

  return {
    ok: true,
    message: replacingLive2DModel
      ? "Live2D 模型已替换。旧角色相关配置已清空，请重新配置人设、表情/动作、事件和声音回复。"
      : "Live2D 模型已导入。",
    petId,
    pet: nextPet,
    modelPath,
    scan
  };
}
