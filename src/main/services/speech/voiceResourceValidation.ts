import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

export type VoiceFileKind = "sovits" | "gpt" | "referenceAudio";

const voiceFileRules: Record<VoiceFileKind, { label: string; extensions: ReadonlySet<string> }> = {
  sovits: { label: "SoVITS 模型", extensions: new Set([".pth"]) },
  gpt: { label: "GPT 模型", extensions: new Set([".ckpt"]) },
  referenceAudio: {
    label: "参考音频",
    extensions: new Set([".wav", ".mp3", ".flac", ".ogg", ".m4a"])
  }
};

const ansiEscapePattern = /\u001b(?:[@-_]|\[[0-?]*[ -/]*[@-~])/g;
const noisyProgressPattern = /(?:\b\d+\s*\/\s*\d+\b|\b\d+(?:\.\d+)?\s*it\/s\b|\b\d+%\b|Decoding EOS|前端处理|预测语义|推理中|合成音频)/i;

export class VoiceResourceValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VoiceResourceValidationError";
  }
}

function displayName(filePath: string, fallback: string): string {
  const name = path.basename(filePath.trim());
  return name && name !== "." ? `“${name}”` : fallback;
}

export async function validateReadableVoiceFile(filePath: string, kind: VoiceFileKind): Promise<void> {
  const rule = voiceFileRules[kind];
  const normalized = filePath.trim();
  if (!normalized) {
    throw new VoiceResourceValidationError(`请先选择${rule.label}。`);
  }
  if (!rule.extensions.has(path.extname(normalized).toLowerCase())) {
    throw new VoiceResourceValidationError(`${rule.label}${displayName(normalized, "")}的文件类型不受支持，请重新选择。`);
  }
  try {
    const stat = await fs.stat(normalized);
    if (!stat.isFile()) {
      throw new VoiceResourceValidationError(`${rule.label}${displayName(normalized, "")}不是可用文件，请重新选择。`);
    }
    await fs.access(normalized, fsSync.constants.R_OK);
  } catch (error) {
    if (error instanceof VoiceResourceValidationError) throw error;
    const missing = (error as NodeJS.ErrnoException).code === "ENOENT";
    throw new VoiceResourceValidationError(
      missing
        ? `找不到${rule.label}${displayName(normalized, "")}，文件可能已被移动或删除，请重新选择。`
        : `无法读取${rule.label}${displayName(normalized, "")}，请检查文件权限后重新选择。`
    );
  }
}

export async function validateGptSoVitsRoot(rootPath: string | undefined): Promise<void> {
  const normalized = rootPath?.trim() ?? "";
  if (!normalized) {
    throw new VoiceResourceValidationError("请先选择 GPT-SoVITS 本地目录。");
  }
  try {
    const stat = await fs.stat(normalized);
    if (!stat.isDirectory()) {
      throw new VoiceResourceValidationError("GPT-SoVITS 本地路径不是文件夹，请重新选择。");
    }
    await fs.access(normalized, fsSync.constants.R_OK);
  } catch (error) {
    if (error instanceof VoiceResourceValidationError) throw error;
    throw new VoiceResourceValidationError(
      (error as NodeJS.ErrnoException).code === "ENOENT"
        ? "找不到 GPT-SoVITS 本地目录，目录可能已被移动或删除，请重新选择。"
        : "无法读取 GPT-SoVITS 本地目录，请检查权限后重试。"
    );
  }
}

export async function validateVoiceModelResources(value: {
  gptSoVitsRootPath?: string;
  sovitsModelPath?: string;
  gptModelPath?: string;
  referenceAudioPath?: string;
}): Promise<void> {
  await validateGptSoVitsRoot(value.gptSoVitsRootPath);
  await validateReadableVoiceFile(value.sovitsModelPath ?? "", "sovits");
  await validateReadableVoiceFile(value.gptModelPath ?? "", "gpt");
  await validateReadableVoiceFile(value.referenceAudioPath ?? "", "referenceAudio");
}

export function sanitizeVoiceDiagnosticText(raw: string, maximumChars = 1_200): string {
  const lines = raw
    .replace(ansiEscapePattern, "")
    .split(/[\r\n]+/)
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter((line) => line && !noisyProgressPattern.test(line))
    .slice(-12)
    .map((line) => line.length > 240 ? `${line.slice(0, 239)}…` : line);
  const result = lines.join("\n");
  if (result.length <= maximumChars) return result;
  return `…${result.slice(-(maximumChars - 1))}`;
}

export function toUserFacingGptSoVitsError(raw: string, status: number): string {
  const normalized = raw.replace(ansiEscapePattern, "").trim();
  if (/ENOENT|no such file or directory|FileNotFoundError/i.test(normalized)) {
    return "GPT-SoVITS 找不到参考音频或模型文件，请回到声音模型页重新选择文件并重新连接。";
  }
  if (/CUDA out of memory|out of memory/i.test(normalized)) {
    return "GPT-SoVITS 显存不足，请缩短文本、关闭其它占用显存的程序，或在声音模型页改用 CPU。";
  }
  const detail = sanitizeVoiceDiagnosticText(normalized, 600);
  return detail || `GPT-SoVITS 请求失败，状态码 ${status}。`;
}
