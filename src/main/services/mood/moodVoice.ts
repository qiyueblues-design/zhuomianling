import { app } from "electron";
import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { moodVoiceFallbackChains, type PetMoodRangeId } from "../../../shared/mood";
import type { PetDefinition } from "../../../shared/types/pet";
import { normalizeLegacyPetDefinition } from "../../../shared/validation/petDefinition";
import { assertValidPetId } from "../../../shared/validation/petId";
import { validateReadableVoiceFile } from "../speech/voiceResourceValidation";
import { getMoodVoiceRangePath } from "./moodPaths";

function assertContained(root: string, target: string): void {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("心情语音资源越界。");
}

async function probeDuration(filePath: string): Promise<number> {
  const script = "$s=New-Object -ComObject Shell.Application;$p=$env:ZHUOMIANLING_MOOD_AUDIO;$f=$s.Namespace([IO.Path]::GetDirectoryName($p));$i=$f.ParseName([IO.Path]::GetFileName($p));[Console]::Out.WriteLine(([double]$i.ExtendedProperty('System.Media.Duration')/10000000).ToString('R',[Globalization.CultureInfo]::InvariantCulture))";
  return new Promise((resolve, reject) => execFile("powershell.exe", ["-NoProfile","-NonInteractive","-Command",script], { windowsHide: true, timeout: 10_000, env: { ...process.env, ZHUOMIANLING_MOOD_AUDIO: filePath } }, (error, stdout) => {
    const duration = Number.parseFloat(stdout.trim());
    if (error || !Number.isFinite(duration)) reject(new Error("无法读取心情参考音频时长。")); else resolve(duration);
  }));
}

export async function resolveMoodVoiceOverride(petId: string, rangeId: PetMoodRangeId): Promise<{ refAudioPath: string; promptText: string } | undefined> {
  const id = assertValidPetId(petId);
  const configPath = path.join(app.getPath("userData"), "pets", id, "pet.local.json");
  const pet = normalizeLegacyPetDefinition(JSON.parse(await fs.readFile(configPath, "utf8")) as PetDefinition);
  for (const candidate of moodVoiceFallbackChains[rangeId]) {
    const override = pet.moodSettings?.ranges?.[candidate]?.voiceOverride;
    if (!override) continue;
    try {
      const rangeRoot = getMoodVoiceRangePath(id, candidate);
      const [realRoot, realFile] = await Promise.all([fs.realpath(rangeRoot), fs.realpath(path.join(rangeRoot, override.referenceAudio))]);
      assertContained(realRoot, realFile);
      await validateReadableVoiceFile(realFile, "referenceAudio");
      const duration = await probeDuration(realFile);
      if (duration < 3 || duration > 10 || !override.referenceText.trim()) continue;
      return { refAudioPath: realFile, promptText: override.referenceText.trim() };
    } catch { continue; }
  }
  return undefined;
}
