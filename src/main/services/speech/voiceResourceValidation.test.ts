import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  sanitizeVoiceDiagnosticText,
  toUserFacingGptSoVitsError,
  validateReadableVoiceFile
} from "./voiceResourceValidation";

let temporaryDirectory = "";

beforeEach(async () => {
  temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "zhuomianling-voice-resource-"));
});

afterEach(async () => {
  await fs.rm(temporaryDirectory, { recursive: true, force: true });
});

describe("voice resource validation", () => {
  it("reports a moved reference audio without exposing a raw filesystem error", async () => {
    await expect(
      validateReadableVoiceFile(path.join(temporaryDirectory, "moved.wav"), "referenceAudio")
    ).rejects.toThrow("找不到参考音频“moved.wav”，文件可能已被移动或删除，请重新选择。");
  });

  it("rejects a model with the wrong file type", async () => {
    const modelPath = path.join(temporaryDirectory, "model.txt");
    await fs.writeFile(modelPath, "fixture", "utf8");

    await expect(validateReadableVoiceFile(modelPath, "sovits")).rejects.toThrow(
      "SoVITS 模型“model.txt”的文件类型不受支持，请重新选择。"
    );
  });
});

describe("voice diagnostics", () => {
  it("splits carriage-return progress updates and keeps diagnostics bounded", () => {
    const raw = [
      "服务启动失败",
      ...Array.from({ length: 200 }, (_, index) => `${index}/1500 ${index}% 42.8it/s 推理中`),
      "最终原因：模型版本不匹配"
    ].join("\r");
    const diagnostic = sanitizeVoiceDiagnosticText(raw, 120);

    expect(diagnostic).toContain("服务启动失败");
    expect(diagnostic).toContain("最终原因：模型版本不匹配");
    expect(diagnostic.length).toBeLessThanOrEqual(120);
    expect(diagnostic).not.toContain("1500");
    expect(diagnostic).not.toContain("it/s");
  });

  it("maps missing-file and out-of-memory failures to actionable Chinese messages", () => {
    expect(toUserFacingGptSoVitsError("FileNotFoundError: old.wav", 500)).toContain(
      "重新选择文件并重新连接"
    );
    expect(toUserFacingGptSoVitsError("CUDA out of memory", 500)).toContain("显存不足");
  });
});
