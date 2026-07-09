import { app, dialog } from "electron";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import type {
  LocalPetAvatarImportResult,
  LocalPetBasicInfoDraft,
  LocalPetDeleteResult,
  LocalPetAvatarCropSaveRequest,
  LocalPetEventSettingsDraft,
  LocalPetExpressionMappingDraft,
  LocalPetPersonaDraft,
  LocalPetUiSettingsDraft,
  LocalPetVoiceInputDraft,
  LocalPetVoiceModelConnectionResult,
  LocalPetVoiceModelDraft,
  LocalPetVoiceModelFilePickResult,
  LocalPetVoiceResourceKind,
  LocalPetSaveResult,
  PetCustomTheme,
  PetCustomThemeImportResult,
  PetCustomThemeListResult,
  PetCustomThemeTokens,
  PetDefinition,
  PetEventSettingsMap,
  PetFeature,
  PetLine,
  PetLineMap
} from "../../../shared/types/pet";
import { petResourceProtocol, toPetResourceUrl } from "./petResourceProtocol";
import { validateLive2DFolder } from "./live2dImportService";
import { warmUpTextToSpeech } from "../speech/textToSpeech";

const localPetsDirectoryName = "pets";
const localThemesDirectoryName = "themes";
const localPetFileName = "pet.local.json";
const localThemeFileName = "theme.json";
const live2dDirectoryName = "live2d";
const themeIdPattern = /^[A-Za-z][A-Za-z0-9_-]{1,39}$/;
const builtInThemeIds = new Set(["soft", "rock", "pixel", "journal", "cyber", "minimal", "custom"]);
const expressionMappingKeyPattern = /^[A-Za-z][A-Za-z0-9_-]*$/;
const allowedAvatarExtensions = new Set([".png", ".jpg", ".jpeg", ".webp"]);
const gptSoVitsBaseUrl = "http://127.0.0.1:9880" as const;
const gptSoVitsLogLineLimit = 40;
const defaultVoiceInferenceDevice = "auto" as const;
const defaultVoiceHalfPrecision = true;
const minVoiceInputSilenceSeconds = 0.4;
const maxVoiceInputSilenceSeconds = 2;
const defaultVoiceInputSilenceSeconds = 1;
let managedGptSoVitsProcess: ChildProcess | undefined;
const avatarMimeTypes: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp"
};

function getPetsRootPath(): string {
  return path.join(app.getPath("userData"), localPetsDirectoryName);
}

function getThemesRootPath(): string {
  return path.join(app.getPath("userData"), localThemesDirectoryName);
}

function getPetDirectoryPath(petId: string): string {
  return path.join(getPetsRootPath(), petId);
}

function getThemeDirectoryPath(themeId: string): string {
  return path.join(getThemesRootPath(), themeId);
}

function getPetConfigPath(petId: string): string {
  return path.join(getPetDirectoryPath(petId), localPetFileName);
}

function getThemeConfigPath(themeId: string): string {
  return path.join(getThemeDirectoryPath(themeId), localThemeFileName);
}

function getGptSoVitsLogPath(petId: string): string {
  return path.resolve(process.cwd(), "logs", `gpt-sovits-${petId}.log`);
}

async function isGptSoVitsApiListening(): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 1200);
    const response = await fetch(gptSoVitsBaseUrl, {
      method: "GET",
      signal: controller.signal
    });
    clearTimeout(timer);

    return response.ok || response.status < 500;
  } catch {
    return false;
  }
}

async function waitForGptSoVitsApi(timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (await isGptSoVitsApiListening()) {
      return true;
    }

    await new Promise((resolve) => setTimeout(resolve, 900));
  }

  return false;
}

async function readRecentGptSoVitsLog(petId: string): Promise<string | undefined> {
  try {
    const log = await fs.readFile(getGptSoVitsLogPath(petId), "utf8");
    const recentLines = log.trim().split(/\r?\n/).slice(-gptSoVitsLogLineLimit);

    return recentLines.join("\n");
  } catch {
    return undefined;
  }
}

function toYamlPath(filePath: string): string {
  return filePath.replace(/\\/g, "/");
}

function normalizeVoiceInputSilenceSeconds(value: number): number {
  if (!Number.isFinite(value)) {
    return defaultVoiceInputSilenceSeconds;
  }

  return Math.min(
    Math.max(Math.round(value * 10) / 10, minVoiceInputSilenceSeconds),
    maxVoiceInputSilenceSeconds
  );
}

interface CudaProbeResult {
  available: boolean;
  deviceName?: string;
  message?: string;
}

interface ResolvedVoiceRuntimeOptions {
  requestedDevice: LocalPetVoiceModelDraft["inferenceDevice"];
  device: "cuda" | "cpu";
  isHalf: boolean;
  cudaProbe?: CudaProbeResult;
}

function normalizeVoiceInferenceDevice(
  value: LocalPetVoiceModelDraft["inferenceDevice"] | undefined
): LocalPetVoiceModelDraft["inferenceDevice"] {
  return value === "cuda" || value === "cpu" || value === "auto"
    ? value
    : defaultVoiceInferenceDevice;
}

async function probeCudaWithPython(pythonExePath: string): Promise<CudaProbeResult> {
  const probeScript = [
    "import json",
    "try:",
    "    import torch",
    "    available = bool(torch.cuda.is_available())",
    "    device_name = torch.cuda.get_device_name(0) if available else ''",
    "    print(json.dumps({'available': available, 'deviceName': device_name}, ensure_ascii=False))",
    "except Exception as exc:",
    "    print(json.dumps({'available': False, 'message': str(exc)}, ensure_ascii=False))"
  ].join("\n");

  return await new Promise<CudaProbeResult>((resolve) => {
    execFile(
      pythonExePath,
      ["-c", probeScript],
      {
        timeout: 15000,
        windowsHide: true
      },
      (_error, stdout) => {
        try {
          const outputLines = stdout.trim().split(/\r?\n/).filter(Boolean);
          const output = outputLines[outputLines.length - 1] ?? "";
          const parsed = JSON.parse(output) as Partial<CudaProbeResult>;

          resolve({
            available: Boolean(parsed.available),
            deviceName: parsed.deviceName,
            message: parsed.message
          });
        } catch {
          resolve({
            available: false,
            message: "无法解析 CUDA 检测结果。"
          });
        }
      }
    );
  });
}

async function resolveVoiceRuntimeOptions(
  draft: LocalPetVoiceModelDraft,
  pythonExePath: string
): Promise<ResolvedVoiceRuntimeOptions> {
  const requestedDevice = normalizeVoiceInferenceDevice(draft.inferenceDevice);
  const wantsCudaProbe = requestedDevice === "auto" || requestedDevice === "cuda";
  const cudaProbe = wantsCudaProbe ? await probeCudaWithPython(pythonExePath) : undefined;
  const device = requestedDevice === "cpu" ? "cpu" : cudaProbe?.available ? "cuda" : "cpu";

  if (requestedDevice === "cuda" && device !== "cuda") {
    throw new Error(
      [
        "当前 GPT-SoVITS Python 环境没有检测到可用 CUDA。",
        cudaProbe?.message ? `检测信息：${cudaProbe.message}` : "",
        "请确认 NVIDIA 驱动和 CUDA 版 PyTorch 已安装到 GPT-SoVITS 的 runtime/python.exe。"
      ]
        .filter(Boolean)
        .join("\n")
    );
  }

  return {
    requestedDevice,
    device,
    isHalf: device === "cuda" && (draft.halfPrecision ?? defaultVoiceHalfPrecision),
    cudaProbe
  };
}

async function writeGptSoVitsRuntimeConfig(
  draft: LocalPetVoiceModelDraft,
  runtimeOptions: ResolvedVoiceRuntimeOptions
): Promise<string> {
  if (!draft.gptSoVitsRootPath || !draft.gptModelPath || !draft.sovitsModelPath) {
    throw new Error("请先填写 GPT-SoVITS 本地路径，并选择 SoVITS / GPT 模型。");
  }

  const configDirectoryPath = path.join(getPetDirectoryPath(draft.petId), "voice");
  const configPath = path.join(configDirectoryPath, "gpt-sovits.generated.yaml");
  const rootPath = toYamlPath(draft.gptSoVitsRootPath);

  const content = [
    "custom:",
    `  bert_base_path: ${rootPath}/GPT_SoVITS/pretrained_models/chinese-roberta-wwm-ext-large`,
    `  cnhuhbert_base_path: ${rootPath}/GPT_SoVITS/pretrained_models/chinese-hubert-base`,
    `  device: ${runtimeOptions.device}`,
    `  is_half: ${runtimeOptions.isHalf ? "true" : "false"}`,
    `  t2s_weights_path: ${toYamlPath(draft.gptModelPath)}`,
    "  version: v2ProPlus",
    `  vits_weights_path: ${toYamlPath(draft.sovitsModelPath)}`,
    ""
  ].join("\n");

  await fs.mkdir(configDirectoryPath, { recursive: true });
  await fs.writeFile(configPath, content, "utf8");

  return configPath;
}

async function launchGptSoVitsApiIfNeeded(draft: LocalPetVoiceModelDraft): Promise<void> {
  if (await isGptSoVitsApiListening()) {
    return;
  }

  if (!draft.gptSoVitsRootPath) {
    throw new Error("请填写 GPT-SoVITS 本地路径。");
  }

  const gptSoVitsRootPath = draft.gptSoVitsRootPath;
  const pythonExePath = path.join(gptSoVitsRootPath, "runtime", "python.exe");
  const apiScriptPath = path.join(gptSoVitsRootPath, "api_v2.py");

  for (const requiredPath of [pythonExePath, apiScriptPath]) {
    try {
      await fs.access(requiredPath);
    } catch {
      throw new Error(`找不到 GPT-SoVITS 必要文件：${requiredPath}`);
    }
  }

  const runtimeOptions = await resolveVoiceRuntimeOptions(draft, pythonExePath);
  const runtimeConfigPath = await writeGptSoVitsRuntimeConfig(draft, runtimeOptions);
  const logPath = getGptSoVitsLogPath(draft.petId);
  const logDirectoryPath = path.dirname(logPath);

  await fs.mkdir(logDirectoryPath, { recursive: true });

  await fs.writeFile(
    logPath,
    [
      `[${new Date().toISOString()}] Starting GPT-SoVITS API`,
      `root=${gptSoVitsRootPath}`,
      `python=${pythonExePath}`,
      `api=${apiScriptPath}`,
      `config=${runtimeConfigPath}`,
      `requestedDevice=${runtimeOptions.requestedDevice}`,
      `resolvedDevice=${runtimeOptions.device}`,
      `isHalf=${runtimeOptions.isHalf}`,
      runtimeOptions.cudaProbe?.deviceName ? `cudaDevice=${runtimeOptions.cudaProbe.deviceName}` : "",
      runtimeOptions.cudaProbe?.message ? `cudaProbe=${runtimeOptions.cudaProbe.message}` : "",
      ""
    ].filter((line) => line !== "").join("\n"),
    "utf8"
  );

  const logFd = fsSync.openSync(logPath, "a");
  const runtimePath = path.join(gptSoVitsRootPath, "runtime");
  const child = spawn(
    pythonExePath,
    [apiScriptPath, "-c", runtimeConfigPath, "-a", "127.0.0.1", "-p", "9880"],
    {
      cwd: gptSoVitsRootPath,
      detached: true,
      env: {
        ...process.env,
        PATH: [gptSoVitsRootPath, runtimePath, process.env.PATH ?? ""].join(path.delimiter)
      },
      windowsHide: true,
      stdio: ["ignore", logFd, logFd]
    }
  );
  managedGptSoVitsProcess = child;
  child.once("exit", () => {
    if (managedGptSoVitsProcess?.pid === child.pid) {
      managedGptSoVitsProcess = undefined;
    }
  });
  child.unref();
  fsSync.closeSync(logFd);
}

export function stopManagedGptSoVitsApi(): void {
  const child = managedGptSoVitsProcess;

  if (!child?.pid) {
    managedGptSoVitsProcess = undefined;
    return;
  }

  try {
    if (process.platform === "win32") {
      spawn("taskkill.exe", ["/pid", String(child.pid), "/t", "/f"], {
        detached: true,
        stdio: "ignore",
        windowsHide: true
      }).unref();
    } else {
      child.kill("SIGTERM");
    }
  } catch {
    // The app may be shutting down while the child process already exited.
  } finally {
    managedGptSoVitsProcess = undefined;
  }
}

export async function resetLocalPetVoiceRuntimeState(): Promise<void> {
  let entries: fsSync.Dirent[];

  try {
    entries = await fs.readdir(getPetsRootPath(), { withFileTypes: true });
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return;
    }

    throw error;
  }

  await Promise.all(
    entries
      .filter((entry) => entry.isDirectory())
      .map(async (entry) => {
        const configPath = getPetConfigPath(entry.name);
        const pet = await readPetConfig(configPath);

        if (!pet?.voiceModelSettings) {
          return;
        }

        const hasRuntimeVoiceState = Boolean(
          pet.voiceModelSettings.connected ||
            pet.voiceModelSettings.enabled ||
            pet.capabilities.voiceOutput
        );

        if (!hasRuntimeVoiceState) {
          return;
        }

        const nextPet: PetDefinition = {
          ...pet,
          capabilities: {
            ...pet.capabilities,
            voiceOutput: false
          },
          voiceModelSettings: {
            ...pet.voiceModelSettings,
            connected: false,
            enabled: false
          }
        };

        await fs.writeFile(configPath, `${JSON.stringify(nextPet, null, 2)}\n`, "utf8");
      })
  );
}

function slugifyName(name: string): string {
  const normalized = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/gi, "-")
    .replace(/^-+|-+$/g, "");

  return normalized || `pet-${Date.now().toString(36)}`;
}

async function ensureUniquePetId(baseId: string, existingId?: string): Promise<string> {
  if (existingId) {
    return existingId;
  }

  let candidate = baseId;
  let index = 2;

  while (true) {
    try {
      await fs.access(getPetConfigPath(candidate));
      candidate = `${baseId}-${index}`;
      index += 1;
    } catch {
      return candidate;
    }
  }
}

function normalizeScenes(scenes: string[]): string[] {
  return Array.from(
    new Set(scenes.map((scene) => scene.trim()).filter(Boolean))
  );
}

function buildPetDefinition(draft: LocalPetBasicInfoDraft, petId: string): PetDefinition {
  const name = draft.name.trim();
  const description = draft.description.trim() || "待设定";
  const role = draft.role.trim() || "待设定";
  const personality = draft.personality.trim() || "待设定";
  const scenes = normalizeScenes(draft.scenes);

  return {
    id: petId,
    name,
    description,
    modelPath: "",
    avatar: name.slice(0, 2).toUpperCase(),
    avatarImage: draft.avatarImage,
    personaPrompt: "",
    capabilities: {
      chat: false,
      voiceOutput: false,
      subtitles: true
    },
    details: {
      role,
      personality,
      scenes,
      features: [
        {
          title: "Live2D 显示",
          description: "等待导入 Live2D 模型文件夹。",
          status: "ready"
        },
        {
          title: "字幕反馈",
          description: "可配置事件台词和字幕。",
          status: "ready"
        }
      ]
    },
    lines: {},
    expressions: {},
    expressionDescriptions: {},
    uiSettings: {
      theme: "soft"
    },
    isLocal: true,
    subtitleStyle: {
      tone: "soft",
      maxWidth: 228
    }
  };
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

function findLocalAvatarPath(petId: string): string | undefined {
  const assetDirectoryPath = path.join(getPetDirectoryPath(petId), "assets");

  for (const extension of [".png", ".jpg", ".jpeg", ".webp"]) {
    const avatarPath = path.join(assetDirectoryPath, `avatar${extension}`);

    if (fsSync.existsSync(avatarPath)) {
      return avatarPath;
    }
  }

  return undefined;
}

function buildDiscoveredPetDefinition(petId: string): PetDefinition {
  const avatarPath = findLocalAvatarPath(petId);

  return {
    id: petId,
    name: petId,
    description: "本地导入的桌宠模型。",
    modelPath: "",
    avatar: petId.slice(0, 2).toUpperCase(),
    avatarImage: avatarPath ? toPetResourceUrl(avatarPath) : undefined,
    personaPrompt: "",
    capabilities: {
      chat: false,
      voiceOutput: false,
      subtitles: true
    },
    details: {
      role: "本地导入的 Live2D 桌宠。",
      personality: "待设定",
      scenes: ["桌面陪伴"],
      features: [
        {
          title: "Live2D 显示",
          description: "已导入 Live2D 模型文件夹。",
          status: "ready"
        },
        {
          title: "字幕反馈",
          description: "可配置事件台词和字幕。",
          status: "ready"
        }
      ]
    },
    lines: {},
    expressions: {},
    expressionDescriptions: {},
    uiSettings: {
      theme: "soft"
    },
    isLocal: true,
    subtitleStyle: {
      tone: "soft",
      maxWidth: 228
    }
  };
}

async function syncImportedLive2DConfig(
  petId: string,
  existingPet: PetDefinition | undefined
): Promise<PetDefinition | undefined> {
  const live2dDirectoryPath = path.join(getPetDirectoryPath(petId), live2dDirectoryName);

  try {
    const scan = await validateLive2DFolder(live2dDirectoryPath);

    if (!scan.ok || !scan.entryFilePath) {
      return existingPet;
    }

    const basePet = existingPet ?? buildDiscoveredPetDefinition(petId);
    const nextPet: PetDefinition = {
      ...basePet,
      id: petId,
      modelPath: toPetResourceUrl(scan.entryFilePath),
      live2dSettings: {
        entryFileName: scan.entryFileName,
        textureCount: scan.textureCount,
        motionCount: scan.motionCount,
        expressionCount: scan.expressionCount
      },
      details: {
        ...basePet.details,
        features: withLive2DFeatureReady(basePet.details.features)
      },
      isLocal: true
    };

    await fs.mkdir(getPetDirectoryPath(petId), { recursive: true });
    await fs.writeFile(getPetConfigPath(petId), `${JSON.stringify(nextPet, null, 2)}\n`, "utf8");

    return nextPet;
  } catch {
    return existingPet;
  }
}

function mergeBasicInfoIntoPet(
  existingPet: PetDefinition | undefined,
  draft: LocalPetBasicInfoDraft,
  petId: string,
  avatarImage: string
): PetDefinition {
  const nextBasicPet = buildPetDefinition(
    {
      ...draft,
      avatarImage
    },
    petId
  );

  if (!existingPet) {
    return nextBasicPet;
  }

  return {
    ...existingPet,
    name: nextBasicPet.name,
    description: nextBasicPet.description,
    avatar: nextBasicPet.avatar,
    avatarImage: nextBasicPet.avatarImage,
    details: {
      ...existingPet.details,
      role: nextBasicPet.details.role,
      personality: nextBasicPet.details.personality,
      scenes: nextBasicPet.details.scenes,
      features: existingPet.details.features?.length
        ? existingPet.details.features
        : nextBasicPet.details.features
    },
    isLocal: true
  };
}

function avatarImageToPath(avatarImage: string): string {
  if (avatarImage.startsWith("file://")) {
    return fileURLToPath(avatarImage);
  }

  if (avatarImage.startsWith(`${petResourceProtocol}://`)) {
    const parsedUrl = new URL(avatarImage);
    const hostParts = parsedUrl.hostname === "local" ? [] : [parsedUrl.hostname];
    const parts = [...hostParts, ...parsedUrl.pathname.split("/")].filter(Boolean);
    return path.join(getPetsRootPath(), ...parts.map((part) => decodeURIComponent(part)));
  }

  return avatarImage;
}

async function copyAvatarIntoPetDirectory(avatarImage: string, petId: string): Promise<string> {
  const sourcePath = avatarImageToPath(avatarImage);
  const extension = path.extname(sourcePath).toLowerCase();

  if (!allowedAvatarExtensions.has(extension)) {
    return avatarImage;
  }

  const targetPath = path.join(getPetDirectoryPath(petId), "assets", `avatar-${Date.now().toString(36)}${extension}`);

  if (path.resolve(sourcePath) !== path.resolve(targetPath)) {
    await fs.mkdir(path.dirname(targetPath), { recursive: true });
    await fs.copyFile(sourcePath, targetPath);
  }

  return toPetResourceUrl(targetPath);
}

async function readPetConfig(filePath: string): Promise<PetDefinition | undefined> {
  const petId = path.basename(path.dirname(filePath));

  try {
    const content = (await fs.readFile(filePath, "utf8")).replace(/^\uFEFF/, "");
    const parsed = JSON.parse(content) as PetDefinition;

    if (!parsed.id || !parsed.name) {
      return syncImportedLive2DConfig(petId, undefined);
    }

    let nextPet = parsed;

    if (!nextPet.modelPath || !nextPet.live2dSettings) {
      const syncedPet = await syncImportedLive2DConfig(nextPet.id, nextPet);

      if (syncedPet) {
        nextPet = syncedPet;
      }
    }

    return {
      ...nextPet,
      avatarImage: nextPet.avatarImage ? toPetResourceUrl(avatarImageToPath(nextPet.avatarImage)) : undefined,
      isLocal: true
    };
  } catch {
    return syncImportedLive2DConfig(petId, undefined);
  }
}

function assertSafePetDirectory(petId: string): string {
  const petsRootPath = path.resolve(getPetsRootPath());
  const petDirectoryPath = path.resolve(getPetDirectoryPath(petId));
  const relativePath = path.relative(petsRootPath, petDirectoryPath);

  if (!relativePath || relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
    throw new Error("Invalid pet directory.");
  }

  return petDirectoryPath;
}

function assertSafeThemeDirectory(themeId: string): string {
  const themesRootPath = path.resolve(getThemesRootPath());
  const themeDirectoryPath = path.resolve(getThemeDirectoryPath(themeId));
  const relativePath = path.relative(themesRootPath, themeDirectoryPath);

  if (!relativePath || relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
    throw new Error("Invalid theme directory.");
  }

  return themeDirectoryPath;
}

const defaultCustomThemeTokens: PetCustomThemeTokens = {
  background: "#eef6ff",
  surface: "rgba(255, 255, 255, 0.92)",
  petSurface: "rgba(255, 255, 255, 0.82)",
  text: "#17202a",
  mutedText: "#607080",
  accent: "#2684ff",
  accentStrong: "#ff7ab8",
  border: "rgba(38, 132, 255, 0.28)",
  danger: "#ef4444",
  shadow: "0 18px 44px rgba(38, 50, 65, 0.18)",
  radius: 14
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function sanitizeThemeId(value: unknown, fallbackName: string): string {
  const raw = typeof value === "string" && value.trim() ? value.trim() : fallbackName;
  const slug = raw
    .normalize("NFKD")
    .replace(/[^A-Za-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);

  if (themeIdPattern.test(slug) && !builtInThemeIds.has(slug)) {
    return slug;
  }

  return `theme-${Date.now().toString(36)}`;
}

function normalizeThemeText(value: unknown, fallback: string, maxLength: number): string {
  if (typeof value !== "string") {
    return fallback;
  }

  const text = value.trim();

  return text ? text.slice(0, maxLength) : fallback;
}

function isSafeCssValue(value: string, maxLength = 180): boolean {
  if (!value || value.length > maxLength) {
    return false;
  }

  return !/[;{}<>@]/.test(value) && !/(?:url|expression|import)\s*\(/i.test(value);
}

function normalizeThemeToken(
  tokens: Record<string, unknown>,
  key: keyof PetCustomThemeTokens,
  fallback: string
): string {
  const value = tokens[key];

  if (typeof value !== "string") {
    return fallback;
  }

  const text = value.trim();

  return isSafeCssValue(text) ? text : fallback;
}

function normalizeThemeRadius(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return defaultCustomThemeTokens.radius ?? 14;
  }

  return Math.min(Math.max(Math.round(value), 0), 24);
}

function normalizeCustomTheme(rawTheme: unknown, fallbackName: string): PetCustomTheme {
  if (!isRecord(rawTheme)) {
    throw new Error("主题文件格式不正确。");
  }

  const rawTokens = isRecord(rawTheme.tokens) ? rawTheme.tokens : undefined;

  if (!rawTokens) {
    throw new Error("主题文件缺少 tokens。");
  }

  const name = normalizeThemeText(rawTheme.name, "自定义主题", 32);

  return {
    id: sanitizeThemeId(rawTheme.id, name || fallbackName),
    name,
    description: normalizeThemeText(rawTheme.description, "用户导入的本地主题。", 72),
    version: typeof rawTheme.version === "number" && Number.isFinite(rawTheme.version)
      ? Math.max(1, Math.round(rawTheme.version))
      : 1,
    author: typeof rawTheme.author === "string" && rawTheme.author.trim()
      ? rawTheme.author.trim().slice(0, 32)
      : undefined,
    importedAt: typeof rawTheme.importedAt === "string" && rawTheme.importedAt.trim()
      ? rawTheme.importedAt.trim()
      : new Date().toISOString(),
    tokens: {
      background: normalizeThemeToken(rawTokens, "background", defaultCustomThemeTokens.background),
      surface: normalizeThemeToken(rawTokens, "surface", defaultCustomThemeTokens.surface),
      petSurface: normalizeThemeToken(rawTokens, "petSurface", defaultCustomThemeTokens.petSurface ?? defaultCustomThemeTokens.surface),
      text: normalizeThemeToken(rawTokens, "text", defaultCustomThemeTokens.text),
      mutedText: normalizeThemeToken(rawTokens, "mutedText", defaultCustomThemeTokens.mutedText),
      accent: normalizeThemeToken(rawTokens, "accent", defaultCustomThemeTokens.accent),
      accentStrong: normalizeThemeToken(rawTokens, "accentStrong", defaultCustomThemeTokens.accentStrong ?? defaultCustomThemeTokens.accent),
      border: normalizeThemeToken(rawTokens, "border", defaultCustomThemeTokens.border),
      danger: normalizeThemeToken(rawTokens, "danger", defaultCustomThemeTokens.danger ?? "#ef4444"),
      shadow: normalizeThemeToken(rawTokens, "shadow", defaultCustomThemeTokens.shadow ?? "none"),
      radius: normalizeThemeRadius(rawTokens.radius)
    }
  };
}

async function readLocalUiTheme(themeId: string): Promise<PetCustomTheme | undefined> {
  try {
    const content = (await fs.readFile(getThemeConfigPath(themeId), "utf8")).replace(/^\uFEFF/, "");
    return normalizeCustomTheme(JSON.parse(content), themeId);
  } catch {
    return undefined;
  }
}

export async function listLocalPets(): Promise<PetDefinition[]> {
  try {
    const entries = await fs.readdir(getPetsRootPath(), { withFileTypes: true });
    const pets = await Promise.all(
      entries
        .filter((entry) => entry.isDirectory())
        .map((entry) => readPetConfig(getPetConfigPath(entry.name)))
    );

    return pets.filter((pet): pet is PetDefinition => Boolean(pet));
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }

    throw error;
  }
}

export async function listLocalUiThemes(): Promise<PetCustomThemeListResult> {
  try {
    const entries = await fs.readdir(getThemesRootPath(), { withFileTypes: true });
    const themes = await Promise.all(
      entries
        .filter((entry) => entry.isDirectory())
        .map((entry) => readLocalUiTheme(entry.name))
    );
    const validThemes = themes
      .filter((theme): theme is PetCustomTheme => Boolean(theme))
      .sort((first, second) => {
        const firstTime = Date.parse(first.importedAt ?? "");
        const secondTime = Date.parse(second.importedAt ?? "");

        return (Number.isFinite(secondTime) ? secondTime : 0) - (Number.isFinite(firstTime) ? firstTime : 0);
      });

    return {
      ok: true,
      message: "已读取本地主题。",
      themes: validThemes
    };
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return {
        ok: true,
        message: "还没有导入本地主题。",
        themes: []
      };
    }

    return {
      ok: false,
      message: "读取本地主题失败。",
      themes: []
    };
  }
}

export async function importLocalUiTheme(): Promise<PetCustomThemeImportResult> {
  const result = await dialog.showOpenDialog({
    title: "导入界面主题",
    properties: ["openFile"],
    filters: [
      {
        name: "主题 JSON",
        extensions: ["json"]
      }
    ]
  });

  if (result.canceled || !result.filePaths[0]) {
    return {
      ok: false,
      canceled: true,
      message: "已取消导入。"
    };
  }

  try {
    const filePath = result.filePaths[0];
    const stat = await fs.stat(filePath);

    if (stat.size > 256 * 1024) {
      return {
        ok: false,
        message: "主题文件过大，请导入 256KB 以内的 JSON 文件。"
      };
    }

    const content = (await fs.readFile(filePath, "utf8")).replace(/^\uFEFF/, "");
    const theme = {
      ...normalizeCustomTheme(JSON.parse(content), path.basename(filePath, path.extname(filePath))),
      importedAt: new Date().toISOString()
    };
    const themeDirectoryPath = assertSafeThemeDirectory(theme.id);

    await fs.mkdir(themeDirectoryPath, { recursive: true });
    await fs.writeFile(getThemeConfigPath(theme.id), `${JSON.stringify(theme, null, 2)}\n`, "utf8");

    return {
      ok: true,
      message: `已导入主题「${theme.name}」。`,
      theme
    };
  } catch (error: unknown) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : "主题导入失败。"
    };
  }
}

export async function saveLocalPetBasicInfo(
  draft: LocalPetBasicInfoDraft
): Promise<LocalPetSaveResult> {
  const name = draft.name.trim();

  if (!name) {
    return {
      ok: false,
      message: "请填写桌宠名称。"
    };
  }

  if (!draft.avatarImage) {
    return {
      ok: false,
      message: "请上传桌宠头像。"
    };
  }

  const petId = await ensureUniquePetId(slugifyName(name), draft.id);
  const petDirectoryPath = getPetDirectoryPath(petId);
  const avatarImage = await copyAvatarIntoPetDirectory(draft.avatarImage, petId);
  const existingPet = await readPetConfig(getPetConfigPath(petId));
  const pet = mergeBasicInfoIntoPet(existingPet, draft, petId, avatarImage);

  await fs.mkdir(petDirectoryPath, { recursive: true });
  await fs.writeFile(getPetConfigPath(petId), `${JSON.stringify(pet, null, 2)}\n`, "utf8");

  return {
    ok: true,
    message: "保存成功。",
    pet
  };
}

export async function saveLocalPetPersona(
  draft: LocalPetPersonaDraft
): Promise<LocalPetSaveResult> {
  const petId = draft.petId.trim();

  if (!petId) {
    return {
      ok: false,
      message: "缺少桌宠 ID。"
    };
  }

  const petDirectoryPath = assertSafePetDirectory(petId);
  const pet = await readPetConfig(getPetConfigPath(petId));

  if (!pet) {
    return {
      ok: false,
      message: "请先保存基础信息，再编辑角色人设。"
    };
  }

  const nextPet: PetDefinition = {
    ...pet,
    personaPrompt: draft.personaPrompt,
    personaSettings: {
      chatLanguage: draft.chatLanguage,
      replyLength: draft.replyLength
    },
    isLocal: true
  };

  await fs.mkdir(petDirectoryPath, { recursive: true });
  await fs.writeFile(getPetConfigPath(petId), `${JSON.stringify(nextPet, null, 2)}\n`, "utf8");

  return {
    ok: true,
    message: "角色人设已保存。",
    pet: nextPet
  };
}

export async function saveLocalPetExpressionMappings(
  draft: LocalPetExpressionMappingDraft
): Promise<LocalPetSaveResult> {
  const petId = draft.petId.trim();

  if (!petId) {
    return {
      ok: false,
      message: "缺少桌宠 ID。"
    };
  }

  const petDirectoryPath = assertSafePetDirectory(petId);
  const pet = await readPetConfig(getPetConfigPath(petId));

  if (!pet) {
    return {
      ok: false,
      message: "请先保存基础信息，再配置表现映射。"
    };
  }

  const expressions: PetDefinition["expressions"] = { ...(pet.expressions ?? {}) };
  const expressionDescriptions: PetDefinition["expressionDescriptions"] = {
    ...(pet.expressionDescriptions ?? {})
  };
  const expressionSourceKinds: PetDefinition["expressionSourceKinds"] = {
    ...(pet.expressionSourceKinds ?? {})
  };
  const expressionSourceFiles: PetDefinition["expressionSourceFiles"] = {
    ...(pet.expressionSourceFiles ?? {})
  };
  const expressionSources = (draft.sources ?? [])
    .map((source) => {
      const sourceFileName = source.sourceFileName.trim();
      const runtimeName =
        typeof source.runtimeName === "number" ? source.runtimeName : source.runtimeName?.trim();

      return sourceFileName
        ? {
            sourceFileName,
            runtimeName,
            sourceKind: source.sourceKind
          }
        : undefined;
    })
    .filter((source): source is NonNullable<typeof source> => Boolean(source));
  const mappingKeyCounts = new Map<string, number>();

  for (const item of draft.mappings) {
    const key = item.mappingKey.trim();

    if (!key) {
      continue;
    }

    mappingKeyCounts.set(key, (mappingKeyCounts.get(key) ?? 0) + 1);
  }

  const invalidKeys = [...mappingKeyCounts.keys()].filter((key) => !expressionMappingKeyPattern.test(key));
  const duplicateKeys = [...mappingKeyCounts.entries()]
    .filter(([, count]) => count > 1)
    .map(([key]) => key);

  if (invalidKeys.length || duplicateKeys.length) {
    return {
      ok: false,
      message: [
        invalidKeys.length ? `映射 key 只能填写英文开头的英文、数字、下划线或短横线：${invalidKeys.join("、")}。` : "",
        duplicateKeys.length ? `映射 key 不能重复：${duplicateKeys.join("、")}。` : ""
      ].filter(Boolean).join(" ")
    };
  }

  for (const item of draft.mappings) {
    const key = item.mappingKey.trim();
    const sourceFileName = item.sourceFileName.trim();
    const description = item.description.trim();
    const runtimeName =
      typeof item.runtimeName === "number" ? item.runtimeName : item.runtimeName?.trim();

    if (!key || !sourceFileName || !description) {
      continue;
    }

    expressions[key] = runtimeName || expressions[key] || sourceFileName;
    expressionSourceKinds[key] = item.sourceKind;
    expressionSourceFiles[key] = sourceFileName;
    expressionDescriptions[key] = description;
  }

  const nextPet: PetDefinition = {
    ...pet,
    expressions,
    expressionDescriptions,
    expressionSelectionMode: draft.expressionSelectionMode ?? "semantic",
    expressionRandomScope: draft.expressionRandomScope ?? "all",
    expressionSourceKinds,
    expressionSourceFiles,
    expressionSources: expressionSources.length ? expressionSources : pet.expressionSources,
    isLocal: true
  };

  await fs.mkdir(petDirectoryPath, { recursive: true });
  await fs.writeFile(getPetConfigPath(petId), `${JSON.stringify(nextPet, null, 2)}\n`, "utf8");

  return {
    ok: true,
    message: "表现映射已保存，AI 会使用这些 key 和描述。",
    pet: nextPet
  };
}

function normalizeDurationMs(value: number | undefined, fallback: number): number {
  if (!Number.isFinite(value)) {
    return fallback;
  }

  return Math.round(Math.min(Math.max(value ?? fallback, 500), 12000));
}

function getPetLineText(line: PetLine): string {
  return typeof line === "string" ? line : line.text;
}

function normalizePetLine(line: PetLine): PetLine | undefined {
  const text = getPetLineText(line).trim();

  if (!text) {
    return undefined;
  }

  return typeof line === "string" ? text : { ...line, text };
}

function normalizeExpressionSource(
  source: LocalPetEventSettingsDraft["events"][number]["source"] | undefined
): NonNullable<LocalPetEventSettingsDraft["events"][number]["source"]> | undefined {
  const sourceFileName = source?.sourceFileName.trim();

  if (!source || !sourceFileName) {
    return undefined;
  }

  const runtimeName =
    typeof source.runtimeName === "number" ? source.runtimeName : source.runtimeName?.trim();

  return {
    sourceFileName,
    runtimeName,
    sourceKind: source.sourceKind,
    description: source.description?.trim() || undefined,
    effects: source.effects
  };
}

export async function saveLocalPetEventSettings(
  draft: LocalPetEventSettingsDraft
): Promise<LocalPetSaveResult> {
  const petId = draft.petId.trim();

  if (!petId) {
    return {
      ok: false,
      message: "缺少桌宠 ID。"
    };
  }

  const petDirectoryPath = assertSafePetDirectory(petId);
  const pet = await readPetConfig(getPetConfigPath(petId));

  if (!pet) {
    return {
      ok: false,
      message: "请先保存基础信息，再配置事件。"
    };
  }

  const mappedExpressionKeys = new Set(Object.keys(pet.expressions ?? {}));
  const lines: PetLineMap = { ...(pet.lines ?? {}) };
  const eventSettings: PetEventSettingsMap = { ...(pet.eventSettings ?? {}) };

  for (const item of draft.events) {
    const eventName = item.event.trim();

    if (!eventName) {
      continue;
    }

    const nextLines = item.lines
      .map(normalizePetLine)
      .filter((line): line is PetLine => Boolean(line));
    const source = normalizeExpressionSource(item.source);
    const expression = item.expression?.trim();
    const hasMappedExpression = Boolean(expression && mappedExpressionKeys.has(expression));
    const hasEventOverride = Boolean(source) || hasMappedExpression || nextLines.length > 0;
    const previousEventSettings = eventSettings[eventName] ?? {};
    const preservedEventSettings = { ...previousEventSettings };

    delete preservedEventSettings.expression;
    delete preservedEventSettings.expressionDurationMs;
    delete preservedEventSettings.source;
    delete preservedEventSettings.sourceDurationMs;
    delete preservedEventSettings.subtitleHoldMs;

    delete lines[eventName];

    if (!hasEventOverride) {
      if (Object.keys(preservedEventSettings).length) {
        eventSettings[eventName] = preservedEventSettings;
      } else {
        delete eventSettings[eventName];
      }
      continue;
    }

    if (nextLines.length) {
      lines[eventName] = nextLines;
    }

    eventSettings[eventName] = {
      ...preservedEventSettings,
      ...(source
        ? {
            source,
            sourceDurationMs: normalizeDurationMs(
              item.sourceDurationMs ?? item.expressionDurationMs,
              2600
            )
          }
        : {
            expression: hasMappedExpression ? expression : undefined,
            expressionDurationMs: normalizeDurationMs(item.expressionDurationMs, 2600)
          })
    };
  }

  const nextPet: PetDefinition = {
    ...pet,
    lines,
    eventSettings,
    isLocal: true
  };

  await fs.mkdir(petDirectoryPath, { recursive: true });
  await fs.writeFile(getPetConfigPath(petId), `${JSON.stringify(nextPet, null, 2)}\n`, "utf8");

  return {
    ok: true,
    message: "事件配置已保存。",
    pet: nextPet
  };
}

export async function saveLocalPetUiSettings(
  draft: LocalPetUiSettingsDraft
): Promise<LocalPetSaveResult> {
  const petId = draft.petId.trim();

  if (!petId) {
    return {
      ok: false,
      message: "缺少桌宠 ID。"
    };
  }

  const petDirectoryPath = assertSafePetDirectory(petId);
  const pet = await readPetConfig(getPetConfigPath(petId));

  if (!pet) {
    return {
      ok: false,
      message: "请先保存基础信息，再配置界面主题。"
    };
  }

  const customTheme =
    draft.theme === "custom" && draft.customThemeId
      ? await readLocalUiTheme(draft.customThemeId)
      : undefined;

  if (draft.theme === "custom" && !customTheme) {
    return {
      ok: false,
      message: "没有找到这个本地主题，请重新导入。"
    };
  }

  const nextPet: PetDefinition = {
    ...pet,
    uiSettings:
      draft.theme === "custom" && customTheme
        ? {
            theme: "custom",
            customThemeId: customTheme.id,
            customTheme
          }
        : {
            theme: draft.theme
          },
    isLocal: true
  };

  await fs.mkdir(petDirectoryPath, { recursive: true });
  await fs.writeFile(getPetConfigPath(petId), `${JSON.stringify(nextPet, null, 2)}\n`, "utf8");

  return {
    ok: true,
    message: "界面主题已保存。",
    pet: nextPet
  };
}

export async function saveLocalPetVoiceInput(
  draft: LocalPetVoiceInputDraft
): Promise<LocalPetSaveResult> {
  const petId = draft.petId.trim();

  if (!petId) {
    return {
      ok: false,
      message: "缺少桌宠 ID。"
    };
  }

  if (!draft.appId.trim() || !draft.secretId.trim() || !draft.secretKey.trim()) {
    return {
      ok: false,
      message: "请先填写 AppID、SecretId 和 SecretKey。"
    };
  }

  const petDirectoryPath = assertSafePetDirectory(petId);
  const pet = await readPetConfig(getPetConfigPath(petId));

  if (!pet) {
    return {
      ok: false,
      message: "请先保存基础信息，再配置语音输入。"
    };
  }

  const nextPet: PetDefinition = {
    ...pet,
    capabilities: {
      ...pet.capabilities,
      voiceInput: draft.connected
    },
    voiceInputSettings: {
      provider: "tencent-asr",
      appId: draft.appId.trim(),
      secretId: draft.secretId.trim(),
      secretKey: draft.secretKey.trim(),
      connected: draft.connected,
      autoEndEnabled: draft.autoEndEnabled,
      silenceSeconds: normalizeVoiceInputSilenceSeconds(draft.silenceSeconds),
      volumeThreshold: draft.volumeThreshold,
      continuousConversationEnabled: draft.continuousConversationEnabled
    },
    isLocal: true
  };

  await fs.mkdir(petDirectoryPath, { recursive: true });
  await fs.writeFile(getPetConfigPath(petId), `${JSON.stringify(nextPet, null, 2)}\n`, "utf8");

  return {
    ok: true,
    message: "语音输入配置已保存。",
    pet: nextPet
  };
}

export async function pickLocalPetVoiceModelFile(
  kind: LocalPetVoiceResourceKind
): Promise<LocalPetVoiceModelFilePickResult> {
  const filters: Record<LocalPetVoiceResourceKind, Electron.FileFilter[]> = {
    sovits: [{ name: "SoVITS 模型", extensions: ["pth"] }],
    gpt: [{ name: "GPT 模型", extensions: ["ckpt"] }],
    referenceAudio: [{ name: "参考音频", extensions: ["wav", "mp3", "flac", "ogg", "m4a"] }]
  };

  const result = await dialog.showOpenDialog({
    title: "选择声音资源",
    filters: filters[kind],
    properties: ["openFile"]
  });

  if (result.canceled || !result.filePaths[0]) {
    return {
      ok: false,
      message: "未选择文件。"
    };
  }

  return {
    ok: true,
    message: "已选择文件。",
    filePath: result.filePaths[0],
    fileName: path.basename(result.filePaths[0])
  };
}

export async function testLocalPetVoiceModelConnection(
  draft: LocalPetVoiceModelDraft
): Promise<LocalPetVoiceModelConnectionResult> {
  if (!draft.sovitsModelPath || !draft.gptModelPath || !draft.referenceAudioPath || !draft.referenceText.trim()) {
    return {
      ok: false,
      message: "请先选择 SoVITS 模型、GPT 模型、参考音频，并填写参考文本。"
    };
  }

  try {
    await launchGptSoVitsApiIfNeeded(draft);
    const connected = await waitForGptSoVitsApi(120_000);

    if (connected) {
      return {
        ok: true,
        message: "成功连接。"
      };
    }

    return {
      ok: false,
      message: [
        "已尝试启动 GPT-SoVITS，但 120 秒内没有检测到 API 服务。",
        await readRecentGptSoVitsLog(draft.petId)
      ]
        .filter(Boolean)
        .join("\n\n最近日志：\n")
    };
  } catch (error) {
    const recentLog = await readRecentGptSoVitsLog(draft.petId);

    return {
      ok: false,
      message: [
        error instanceof Error ? error.message : "无法启动或连接本机 GPT-SoVITS。",
        recentLog
      ]
        .filter(Boolean)
        .join("\n\n最近日志：\n")
    };
  }
}

export async function saveLocalPetVoiceModel(
  draft: LocalPetVoiceModelDraft
): Promise<LocalPetSaveResult> {
  const petId = draft.petId.trim();

  if (!petId) {
    return {
      ok: false,
      message: "缺少桌宠 ID。"
    };
  }

  const petDirectoryPath = assertSafePetDirectory(petId);
  const pet = await readPetConfig(getPetConfigPath(petId));

  if (!pet) {
    return {
      ok: false,
      message: "请先保存基础信息，再配置声音模型。"
    };
  }

  const nextPet: PetDefinition = {
    ...pet,
    capabilities: {
      ...pet.capabilities,
      voiceOutput: draft.enabled
    },
    voiceModelSettings: {
      enabled: draft.enabled,
      connected: draft.connected,
      gptSoVitsRootPath: draft.gptSoVitsRootPath,
      sovitsModelPath: draft.sovitsModelPath,
      gptModelPath: draft.gptModelPath,
      referenceAudioPath: draft.referenceAudioPath,
      referenceText: draft.referenceText,
      language: draft.language,
      playMode: "sentence",
      inferenceDevice: normalizeVoiceInferenceDevice(draft.inferenceDevice),
      halfPrecision: draft.halfPrecision ?? defaultVoiceHalfPrecision,
      syncTextWithVoice: draft.syncTextWithVoice
    },
    isLocal: true
  };

  await fs.mkdir(petDirectoryPath, { recursive: true });
  await fs.writeFile(getPetConfigPath(petId), `${JSON.stringify(nextPet, null, 2)}\n`, "utf8");

  if (nextPet.voiceModelSettings?.enabled && nextPet.voiceModelSettings.connected) {
    void warmUpTextToSpeech(petId);
  }

  return {
    ok: true,
    message: "声音模型配置已保存。",
    pet: nextPet
  };
}

export async function importLocalPetAvatar(petId?: string): Promise<LocalPetAvatarImportResult> {
  const result = await dialog.showOpenDialog({
    title: "选择桌宠头像",
    filters: [
      {
        name: "图片",
        extensions: ["png", "jpg", "jpeg", "webp"]
      }
    ],
    properties: ["openFile"]
  });

  if (result.canceled || !result.filePaths[0]) {
    return {
      ok: false,
      message: "未选择头像。"
    };
  }

  const sourcePath = result.filePaths[0];
  const extension = path.extname(sourcePath).toLowerCase();

  if (!allowedAvatarExtensions.has(extension)) {
    return {
      ok: false,
      message: "请选择 PNG、JPG 或 WebP 图片。"
    };
  }

  const imageBytes = await fs.readFile(sourcePath);

  return {
    ok: true,
    message: "请选择头像裁剪区域。",
    sourceImage: `data:${avatarMimeTypes[extension]};base64,${imageBytes.toString("base64")}`
  };
}

export async function saveLocalPetAvatarCrop(
  request: LocalPetAvatarCropSaveRequest
): Promise<LocalPetAvatarImportResult> {
  const targetPetId = request.petId || `draft-${Date.now().toString(36)}`;
  const dataUrlMatch = /^data:image\/(png|jpeg|jpg|webp);base64,(.+)$/i.exec(request.dataUrl);

  if (!dataUrlMatch) {
    return {
      ok: false,
      message: "裁剪图片格式无效。"
    };
  }

  const extension = dataUrlMatch[1].toLowerCase() === "jpeg" ? ".jpg" : `.${dataUrlMatch[1].toLowerCase()}`;
  const avatarDirectoryPath = path.join(getPetDirectoryPath(targetPetId), "assets");
  const targetPath = path.join(avatarDirectoryPath, `avatar-${Date.now().toString(36)}${extension}`);

  await fs.mkdir(avatarDirectoryPath, { recursive: true });
  await fs.writeFile(targetPath, Buffer.from(dataUrlMatch[2], "base64"));

  return {
    ok: true,
    message: "头像已裁剪并保存。",
    avatarImage: toPetResourceUrl(targetPath)
  };
}

export async function deleteLocalPet(petId: string): Promise<LocalPetDeleteResult> {
  const targetPetId = petId.trim();

  if (!targetPetId) {
    return {
      ok: false,
      message: "缺少要删除的桌宠 ID。",
      petId
    };
  }

  const petDirectoryPath = assertSafePetDirectory(targetPetId);

  try {
    await fs.access(getPetConfigPath(targetPetId));
  } catch {
    return {
      ok: false,
      message: "只能删除本地创建的桌宠。",
      petId: targetPetId
    };
  }

  await fs.rm(petDirectoryPath, { recursive: true, force: true });

  return {
    ok: true,
    message: "桌宠已删除。",
    petId: targetPetId
  };
}
