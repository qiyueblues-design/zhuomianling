import fs from "node:fs/promises";
import path from "node:path";
import type { PetDefinition } from "../../../shared/types/pet";

async function isReadableFile(filePath: string): Promise<boolean> {
  try {
    const stat = await fs.stat(filePath);
    await fs.access(filePath);
    return stat.isFile();
  } catch {
    return false;
  }
}

function isContained(rootPath: string, targetPath: string): boolean {
  const relative = path.relative(path.resolve(rootPath), path.resolve(targetPath));
  return Boolean(relative) && !relative.startsWith("..") && !path.isAbsolute(relative);
}

export interface LegacyVoiceModelPathResolution {
  pet: PetDefinition;
  changed: boolean;
}

/**
 * 只兼容能够相对 GPT-SoVITS 根目录精确解析的旧路径。
 * 已保存的绝对路径始终代表用户导入时选择的文件；即使失效，也不得按文件名猜测替换。
 */
export async function resolveLegacyVoiceModelPaths(
  pet: PetDefinition
): Promise<LegacyVoiceModelPathResolution> {
  const settings = pet.voiceModelSettings;
  const rootPath = settings?.gptSoVitsRootPath?.trim();

  if (!settings || !rootPath) {
    return { pet, changed: false };
  }

  const nextSettings = { ...settings };
  let changed = false;

  for (const field of ["sovitsModelPath", "gptModelPath"] as const) {
    const savedPath = settings[field]?.trim();

    if (!savedPath || path.isAbsolute(savedPath) || await isReadableFile(savedPath)) {
      continue;
    }

    const exactCandidate = path.resolve(rootPath, savedPath);
    if (!isContained(rootPath, exactCandidate) || !(await isReadableFile(exactCandidate))) {
      continue;
    }

    nextSettings[field] = exactCandidate;
    changed = true;
  }

  return changed
    ? { pet: { ...pet, voiceModelSettings: nextSettings }, changed: true }
    : { pet, changed: false };
}
