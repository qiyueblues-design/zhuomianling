import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PetDefinition } from "../../../shared/types/pet";
import { resolveLegacyVoiceModelPaths } from "./legacyVoiceModelPath";

let temporaryDirectory = "";

function createPet(rootPath: string, sovitsPath: string, gptPath: string): PetDefinition {
  return {
    id: "legacy-pet",
    name: "旧桌宠",
    description: "",
    modelPath: "",
    personaPrompt: "",
    capabilities: { chat: false, voiceOutput: true, subtitles: true },
    details: { role: "", personality: "", scenes: [], features: [] },
    voiceModelSettings: {
      enabled: true,
      connected: false,
      gptSoVitsRootPath: rootPath,
      sovitsModelPath: sovitsPath,
      gptModelPath: gptPath,
      referenceAudioPath: "",
      referenceText: "",
      language: "zh",
      playMode: "sentence"
    }
  };
}

beforeEach(async () => {
  temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "zhuomianling-voice-path-"));
});

afterEach(async () => {
  await fs.rm(temporaryDirectory, { recursive: true, force: true });
});

describe("旧版声音模型路径兼容", () => {
  it("按根目录精确恢复旧版相对路径", async () => {
    const modelDirectory = path.join(temporaryDirectory, "GPT_SoVITS", "pretrained_models");
    const sovitsPath = path.join(modelDirectory, "voice.pth");
    const gptPath = path.join(modelDirectory, "voice.ckpt");
    await fs.mkdir(modelDirectory, { recursive: true });
    await Promise.all([fs.writeFile(sovitsPath, "fixture"), fs.writeFile(gptPath, "fixture")]);

    const result = await resolveLegacyVoiceModelPaths(createPet(
      temporaryDirectory,
      "GPT_SoVITS/pretrained_models/voice.pth",
      "GPT_SoVITS/pretrained_models/voice.ckpt"
    ));
    const [realSovitsPath, realGptPath] = await Promise.all([
      fs.realpath(sovitsPath),
      fs.realpath(gptPath)
    ]);

    expect(result.changed).toBe(true);
    await expect(fs.realpath(result.pet.voiceModelSettings?.sovitsModelPath ?? ""))
      .resolves.toBe(realSovitsPath);
    await expect(fs.realpath(result.pet.voiceModelSettings?.gptModelPath ?? ""))
      .resolves.toBe(realGptPath);
  });

  it("绝不把失效的导入绝对路径替换成根目录内的同名文件", async () => {
    const modelDirectory = path.join(temporaryDirectory, "models");
    await fs.mkdir(modelDirectory, { recursive: true });
    await fs.writeFile(path.join(modelDirectory, "voice.pth"), "fixture");
    const pet = createPet(temporaryDirectory, "D:/original/location/voice.pth", "");

    const result = await resolveLegacyVoiceModelPaths(pet);

    expect(result.changed).toBe(false);
    expect(result.pet.voiceModelSettings?.sovitsModelPath).toBe("D:/original/location/voice.pth");
  });
});
