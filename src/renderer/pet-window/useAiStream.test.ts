import { describe, expect, it } from "vitest";
import type { PetDefinition } from "../../shared/types/pet";
import type { SpeechFrontendSettings } from "../services/speech/speechSettings";
import {
  buildInterruptedReplyText,
  createAiStreamSettingsSnapshot,
  enqueueSafeStreamingVoiceChunk,
  reconcileTypewriterText,
  selectFinalVoiceText,
  selectSafeAiStreamPresentation,
  selectStreamingVoiceText
} from "./useAiStream";

const voiceSettings: SpeechFrontendSettings = {
  autoEndEnabled: true,
  continuousConversationEnabled: true,
  voiceReplyEnabled: true,
  voiceReplyMode: "sentence",
  syncTextWithVoice: true,
  silenceSeconds: 1,
  volumeThreshold: 0.18
};

describe("AI stream settings snapshot", () => {
  it("freezes voice and synchronization behavior for the active request", () => {
    const mutableSettings = { ...voiceSettings };
    const snapshot = createAiStreamSettingsSnapshot(mutableSettings);

    mutableSettings.voiceReplyEnabled = false;
    mutableSettings.syncTextWithVoice = false;

    expect(snapshot).toEqual({
      voiceReplyEnabled: true,
      syncTextWithVoice: true,
      useReplyAsVoiceText: true
    });
  });

  it("selects the finalized voiceText field when chat and voice languages differ", () => {
    const petDefinition = {
      personaSettings: { chatLanguage: "zh" },
      voiceModelSettings: { language: "ja" }
    } as unknown as PetDefinition;

    expect(createAiStreamSettingsSnapshot(voiceSettings, petDefinition)).toMatchObject({
      voiceReplyEnabled: true,
      syncTextWithVoice: true,
      useReplyAsVoiceText: false
    });
  });

  it("never enables synchronization for a request without voice reply", () => {
    expect(
      createAiStreamSettingsSnapshot({ ...voiceSettings, voiceReplyEnabled: false })
    ).toMatchObject({
      voiceReplyEnabled: false,
      syncTextWithVoice: false,
      useReplyAsVoiceText: false
    });
  });
});

describe("safe AI stream presentation", () => {
  it("uses only normalized IPC content for streaming chat and subtitles", () => {
    expect(selectSafeAiStreamPresentation({ content: "安全聊天正文" })).toEqual({
      replyText: "安全聊天正文"
    });
  });

  it("allows updates only when they preserve the already displayed prefix", () => {
    expect(reconcileTypewriterText("已经显示旧尾巴", 4, "已经显示新尾巴")).toBe(
      "已经显示新尾巴"
    );
    expect(reconcileTypewriterText("已经显示旧尾巴", 5, "完全不同的回复")).toBe(
      "已经显示旧尾巴"
    );
  });

  it("selects voice only from the finalized normalized fields", () => {
    expect(selectFinalVoiceText("聊天正文", "语音正文", false)).toBe("语音正文");
    expect(selectFinalVoiceText("直接朗读正文", "不应采用", true)).toBe("直接朗读正文");
    expect(selectFinalVoiceText("跨语言正文", undefined, false)).toBeUndefined();
    expect(selectFinalVoiceText("兼容正文", undefined, false, "text")).toBeUndefined();
    expect(selectFinalVoiceText("兼容正文", undefined, true, "text")).toBe("兼容正文");
  });

  it("streams reply directly only when chat and voice use the same language", () => {
    const event = { content: "聊天正文。", voiceText: "语音正文。" };

    expect(selectStreamingVoiceText(event, true)).toBe("聊天正文。");
    expect(selectStreamingVoiceText(event, false)).toBe("语音正文。");
    expect(selectStreamingVoiceText({ content: "聊天正文。" }, false)).toBe("");
    expect(selectStreamingVoiceText({ content: "聊天正文。", protocolTier: "text" }, false)).toBe("");
  });

  it("enqueues a safe streaming field during chunk handling before finalization", () => {
    const calls: Array<[string, number | undefined]> = [];

    enqueueSafeStreamingVoiceChunk(
      { content: "第一句。后续仍在生成", voiceText: "第一句。后续仍在生成" },
      { enabled: true, useReplyAsVoiceText: true, requestId: 7 },
      {
        enqueueStreamingText: (text, requestId) => {
          calls.push([text, requestId]);
        }
      }
    );

    expect(calls).toEqual([["第一句。后续仍在生成", 7]]);
  });

  it("refuses to send internal or structured artifacts to TTS", () => {
    expect(selectFinalVoiceText("安全正文", "<think>内部推理</think>", false)).toBeUndefined();
    expect(selectFinalVoiceText("安全正文", "<reasoning>内部推理</reasoning>", false))
      .toBeUndefined();
    expect(selectFinalVoiceText("安全正文", "<analysis>内部推理</analysis>", false))
      .toBeUndefined();
    expect(selectFinalVoiceText("安全正文", '{"reply":"错误外壳"}', false)).toBeUndefined();
    expect(selectFinalVoiceText("```json\n内容\n```", undefined, true)).toBeUndefined();
  });

  it("preserves a committed safe prefix when generation is interrupted", () => {
    expect(buildInterruptedReplyText("已经说出的安全内容。", "回复生成中断")).toBe(
      "已经说出的安全内容。\n（回复生成中断）"
    );
    expect(buildInterruptedReplyText("", "回复已取消")).toBe("回复已取消。");
  });
});
