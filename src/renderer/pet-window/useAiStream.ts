import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { Dispatch, MutableRefObject, SetStateAction } from "react";
import type { AiChatStreamEvent } from "../../shared/types/ai";
import type {
  PetDefinition,
  PetExpressionKey,
  PetExpressionSourceItem,
  PetLineEvent
} from "../../shared/types/pet";
import type { PetExpressionEvent } from "../live2d/Live2DCanvas";
import type { SpeechFrontendSettings } from "../services/speech/speechSettings";
import type { useSubtitle } from "../services/subtitle/subtitleStore";
import {
  inferExpressionFromAiReply,
  resolveMappedExpression
} from "./aiReplyUtils";
import { isCurrentAiStreamEvent } from "./aiStreamGuard";
import type { ChatMessage } from "./petWindowChatTypes";
import { buildAiMessages } from "./promptBuilder";
import type { UseVoiceReplyQueueResult } from "./useVoiceReplyQueue";

interface UseAiStreamOptions {
  petId: string;
  petDefinition?: PetDefinition;
  settings: SpeechFrontendSettings;
  draftRef: MutableRefObject<string>;
  setDraft: Dispatch<SetStateAction<string>>;
  subtitle: Pick<
    ReturnType<typeof useSubtitle>,
    "show" | "showTypewriterProgress" | "finishTypewriterProgress"
  >;
  voiceReply: UseVoiceReplyQueueResult;
  clearVoiceTypewriter: () => void;
  triggerExpression: (
    expression: PetExpressionKey,
    priority?: PetExpressionEvent["priority"],
    durationMs?: number,
    hold?: boolean
  ) => void;
  triggerExpressionSource: (
    source: PetExpressionSourceItem,
    priority?: PetExpressionEvent["priority"],
    durationMs?: number
  ) => void;
  pickRandomExpressionSource: () => PetExpressionSourceItem | undefined;
  speakLine: (eventName: PetLineEvent, fallbackText: string) => void;
  resetIdleTimer: () => void;
  scheduleVoiceRestart: (isVoiceTriggered: boolean) => void;
}

interface AiStreamContext {
  requestId: string;
  petId: string;
  pendingMessageId: number;
  isVoiceTriggered: boolean;
  voiceReplyRequestId: number;
  voiceReplyEnabled: boolean;
  syncTextWithVoice: boolean;
  useReplyAsVoiceText: boolean;
  latestSafeReply: string;
}

interface TypewriterPresentation {
  messageId: number;
  fullText: string;
  displayedCharacters: number;
  voiceText?: string;
  aiStructuredContent?: string;
  finalized: boolean;
  holdMs?: number;
}

export interface AiStreamSettingsSnapshot {
  voiceReplyEnabled: boolean;
  syncTextWithVoice: boolean;
  useReplyAsVoiceText: boolean;
}

export interface SafeAiStreamPresentation {
  replyText: string;
}

export interface UseAiStreamResult {
  cancel: (options?: { updateUi?: boolean }) => void;
  messages: ChatMessage[];
  sendMessageText: (text: string, isVoiceTriggered?: boolean) => Promise<void>;
  sending: boolean;
  showStreamingReply: (pendingMessageId: number, replyText: string) => boolean;
}

const chatReplyTypewriterDelayMs = 34;

function getTextDisplayDurationMs(text: string): number {
  const textLength = text.trim().length;
  return textLength * 42 + Math.min(Math.max(textLength * 110, 2200), 6200);
}

export function createAiStreamSettingsSnapshot(
  settings: SpeechFrontendSettings,
  petDefinition?: PetDefinition
): AiStreamSettingsSnapshot {
  const voiceReplyEnabled = settings.voiceReplyEnabled;
  return {
    voiceReplyEnabled,
    syncTextWithVoice: voiceReplyEnabled && settings.syncTextWithVoice,
    useReplyAsVoiceText:
      voiceReplyEnabled &&
      (petDefinition?.personaSettings?.chatLanguage ?? "zh") ===
        (petDefinition?.voiceModelSettings?.language ?? "zh")
  };
}

export function selectSafeAiStreamPresentation(
  event: Pick<AiChatStreamEvent, "content">
): SafeAiStreamPresentation {
  return {
    replyText: event.content ?? ""
  };
}

export function selectFinalVoiceText(
  replyText: string,
  voiceText: string | undefined,
  useReplyAsVoiceText: boolean,
  protocolTier: "full" | "text" = "full"
): string | undefined {
  if (protocolTier === "text" && !useReplyAsVoiceText) return undefined;
  const selected = (useReplyAsVoiceText ? replyText : voiceText?.trim() ?? "").trim();

  if (
    !selected ||
    /<\/?(?:think|analysis|reasoning)\b/i.test(selected) ||
    /```/.test(selected) ||
    /^\s*[{[]/.test(selected) ||
    /"(?:reply|emotion|voiceText|moodDelta)"\s*:/.test(selected)
  ) {
    return undefined;
  }

  return selected;
}

export function selectStreamingVoiceText(
  event: Pick<AiChatStreamEvent, "content" | "voiceText" | "protocolTier">,
  useReplyAsVoiceText: boolean
): string {
  if (event.protocolTier === "text" && !useReplyAsVoiceText) return "";
  return (useReplyAsVoiceText ? event.content : event.voiceText) ?? "";
}

export function enqueueSafeStreamingVoiceChunk(
  event: Pick<AiChatStreamEvent, "content" | "voiceText" | "protocolTier">,
  options: {
    enabled: boolean;
    useReplyAsVoiceText: boolean;
    requestId: number;
  },
  voiceReply: Pick<UseVoiceReplyQueueResult, "enqueueStreamingText">
): void {
  if (!options.enabled) {
    return;
  }

  voiceReply.enqueueStreamingText(
    selectStreamingVoiceText(event, options.useReplyAsVoiceText),
    options.requestId
  );
}

export function reconcileTypewriterText(
  currentFullText: string,
  displayedCharacters: number,
  nextFullText: string
): string {
  const displayedPrefix = Array.from(currentFullText)
    .slice(0, displayedCharacters)
    .join("");

  return nextFullText.startsWith(displayedPrefix) ? nextFullText : currentFullText;
}

export function buildInterruptedReplyText(
  safeReply: string,
  interruptionLabel: "回复生成中断" | "回复已取消"
): string {
  const normalizedReply = safeReply.trim();
  return normalizedReply
    ? `${normalizedReply}\n（${interruptionLabel}）`
    : `${interruptionLabel}。`;
}

export function useAiStream(options: UseAiStreamOptions): UseAiStreamResult {
  const optionsRef = useRef(options);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [sending, setSending] = useState(false);
  const messagesRef = useRef<ChatMessage[]>([]);
  const sendingRef = useRef(false);
  const requestSequenceRef = useRef(0);
  const streamIdRef = useRef<string | undefined>();
  const streamRequestIdRef = useRef<string | undefined>();
  const streamContextRef = useRef<AiStreamContext | undefined>();
  const streamEventHandlerRef = useRef<(event: AiChatStreamEvent) => void>(() => undefined);
  const typewriterTimerRef = useRef<number | undefined>();
  const typewriterSequenceRef = useRef(0);
  const typewriterPresentationRef = useRef<TypewriterPresentation | undefined>();
  const cancelRef = useRef<(options?: { updateUi?: boolean }) => void>(() => undefined);

  useLayoutEffect(() => {
    optionsRef.current = options;
  }, [options]);

  useLayoutEffect(() => {
    messagesRef.current = messages;
  }, [messages]);

  const setSendingState = (nextSending: boolean): void => {
    sendingRef.current = nextSending;
    setSending(nextSending);
  };

  const clearTypewriter = (): void => {
    typewriterSequenceRef.current += 1;
    window.clearTimeout(typewriterTimerRef.current);
    typewriterTimerRef.current = undefined;
    typewriterPresentationRef.current = undefined;
  };

  const renderTypewriterProgress = (presentation: TypewriterPresentation): void => {
    const visibleText = Array.from(presentation.fullText)
      .slice(0, presentation.displayedCharacters)
      .join("");
    const currentDefinition = optionsRef.current.petDefinition;
    setMessages((current) =>
      current.map((message) =>
        message.id === presentation.messageId
          ? {
              ...message,
              text: visibleText,
              status: undefined,
              voiceText: presentation.finalized ? presentation.voiceText : message.voiceText,
              aiStructuredContent: presentation.finalized
                ? presentation.aiStructuredContent
                : message.aiStructuredContent
            }
          : message
      )
    );
    optionsRef.current.subtitle.showTypewriterProgress({
      text: visibleText,
      fullText: presentation.fullText,
      tone: currentDefinition?.subtitleStyle?.tone,
      maxWidth: currentDefinition?.subtitleStyle?.maxWidth
    });
  };

  const advanceTypewriter = (sequenceId: number): void => {
    if (sequenceId !== typewriterSequenceRef.current) return;
    const presentation = typewriterPresentationRef.current;
    if (!presentation) return;
    const characterCount = Array.from(presentation.fullText).length;

    if (presentation.displayedCharacters >= characterCount) {
      typewriterTimerRef.current = undefined;
      if (presentation.finalized) {
        renderTypewriterProgress(presentation);
        optionsRef.current.subtitle.finishTypewriterProgress(presentation.holdMs);
      }
      return;
    }

    presentation.displayedCharacters += 1;
    renderTypewriterProgress(presentation);
    typewriterTimerRef.current = window.setTimeout(
      () => advanceTypewriter(sequenceId),
      chatReplyTypewriterDelayMs
    );
  };

  const queuePetMessageWithTypewriter = (
    messageId: number,
    fullText: string,
    messageOptions?: { voiceText?: string; aiStructuredContent?: string },
    completionOptions?: { finalized?: boolean; holdMs?: number }
  ): void => {
    const normalizedText = fullText.trim();
    if (!normalizedText) return;
    let presentation = typewriterPresentationRef.current;

    if (!presentation || presentation.messageId !== messageId) {
      clearTypewriter();
      presentation = {
        messageId,
        fullText: normalizedText,
        displayedCharacters: 0,
        voiceText: messageOptions?.voiceText,
        aiStructuredContent: messageOptions?.aiStructuredContent,
        finalized: Boolean(completionOptions?.finalized),
        holdMs: completionOptions?.holdMs
      };
      typewriterPresentationRef.current = presentation;
    } else {
      presentation.fullText = reconcileTypewriterText(
        presentation.fullText,
        presentation.displayedCharacters,
        normalizedText
      );
      presentation.voiceText = messageOptions?.voiceText ?? presentation.voiceText;
      presentation.aiStructuredContent =
        messageOptions?.aiStructuredContent ?? presentation.aiStructuredContent;
      presentation.finalized ||= Boolean(completionOptions?.finalized);
      presentation.holdMs = completionOptions?.holdMs ?? presentation.holdMs;
      presentation.displayedCharacters = Math.min(
        presentation.displayedCharacters,
        Array.from(presentation.fullText).length
      );
    }

    if (typewriterTimerRef.current === undefined) {
      advanceTypewriter(typewriterSequenceRef.current);
    }
  };

  const showStreamingReply = (pendingMessageId: number, replyText: string): boolean => {
    if (!replyText) {
      return false;
    }

    queuePetMessageWithTypewriter(pendingMessageId, replyText);
    return true;
  };

  const finishReply = async (context: AiStreamContext, event: AiChatStreamEvent): Promise<void> => {
    const currentOptions = optionsRef.current;
    const definition = currentOptions.petDefinition;
    const replyText = event.content ?? "";
    const voiceText = event.voiceText;
    const effectiveVoiceText = context.voiceReplyEnabled
      ? selectFinalVoiceText(
          replyText,
          voiceText,
          context.useReplyAsVoiceText,
          event.protocolTier
        )
      : undefined;
    const inferredExpression = inferExpressionFromAiReply(replyText);
    const randomExpressionMode = definition?.expressionSelectionMode === "random";
    const randomReplySource = randomExpressionMode
      ? currentOptions.pickRandomExpressionSource()
      : undefined;
    const replyExpression = randomExpressionMode
      ? undefined
      : resolveMappedExpression(event.emotion, definition?.expressions, inferredExpression);
    const shouldHoldSubtitleForVoice =
      context.voiceReplyEnabled && Boolean(effectiveVoiceText?.trim());
    const requestId = context.voiceReplyRequestId;
    const syncTextWithVoice =
      shouldHoldSubtitleForVoice && context.syncTextWithVoice;

    if (syncTextWithVoice) {
      currentOptions.voiceReply.updateSynchronizedContent(replyText);
      currentOptions.voiceReply.enqueueFinalText(
        effectiveVoiceText ?? "",
        requestId
      );
      if (currentOptions.voiceReply.isPlaybackBlocked()) {
        setMessages((current) =>
          current.map((message) =>
            message.id === context.pendingMessageId
              ? { ...message, text: "首句语音生成中..." }
              : message
          )
        );
        if (!(await currentOptions.voiceReply.awaitSynchronizedPlaybackStart(requestId))) {
          return;
        }
      }
    }

    queuePetMessageWithTypewriter(
      context.pendingMessageId,
      replyText,
      {
        voiceText: effectiveVoiceText,
        aiStructuredContent: JSON.stringify({
          ...(effectiveVoiceText ? { voiceText: effectiveVoiceText } : {}),
          reply: replyText,
          ...(event.emotion ? { emotion: event.emotion } : {})
        })
      },
      { finalized: true, holdMs: shouldHoldSubtitleForVoice ? Number.POSITIVE_INFINITY : undefined }
    );

    if (randomReplySource) {
      currentOptions.triggerExpressionSource(
        randomReplySource,
        "normal",
        randomReplySource.sourceKind === "expression"
          ? getTextDisplayDurationMs(replyText)
          : undefined
      );
    } else if (shouldHoldSubtitleForVoice && replyExpression) {
      currentOptions.voiceReply.setPendingExpression(replyExpression);
      if (currentOptions.voiceReply.holdExpression(requestId, replyExpression)) {
        currentOptions.voiceReply.clearPendingExpression();
      }
    } else if (replyExpression) {
      currentOptions.triggerExpression(
        replyExpression,
        "normal",
        replyExpression === "focus" ? 3600 : 2600
      );
    }

    if (shouldHoldSubtitleForVoice) {
      currentOptions.voiceReply.holdSubtitle(requestId);
    }

    if (!syncTextWithVoice && shouldHoldSubtitleForVoice) {
      currentOptions.voiceReply.enqueueFinalText(
        effectiveVoiceText ?? "",
        requestId
      );
    }
    if (syncTextWithVoice) {
      currentOptions.voiceReply.completeSynchronizedReveal();
    }
    currentOptions.voiceReply.finalizeReply(
      requestId,
      shouldHoldSubtitleForVoice && context.isVoiceTriggered
    );

    setSendingState(false);
    currentOptions.resetIdleTimer();
    if (!shouldHoldSubtitleForVoice) {
      currentOptions.scheduleVoiceRestart(context.isVoiceTriggered);
    }
  };

  const failReply = (context: AiStreamContext, errorText: string): void => {
    const currentOptions = optionsRef.current;
    const preserveCommittedReply =
      currentOptions.voiceReply.hasCommittedSpeech() && Boolean(context.latestSafeReply.trim());
    const presentationText = preserveCommittedReply
      ? buildInterruptedReplyText(context.latestSafeReply, "回复生成中断")
      : errorText;
    currentOptions.voiceReply.stop();
    clearTypewriter();
    setMessages((current) =>
      current.map((message) =>
        message.id === context.pendingMessageId
          ? { id: context.pendingMessageId, role: "pet", text: presentationText, status: "error" }
          : message
      )
    );
    currentOptions.triggerExpression("panic", "high", 3600);
    currentOptions.subtitle.show({
      text: preserveCommittedReply ? "回复生成中断。" : errorText,
      mode: "typewriter",
      tone: currentOptions.petDefinition?.subtitleStyle?.tone,
      maxWidth: currentOptions.petDefinition?.subtitleStyle?.maxWidth
    });
    setSendingState(false);
    currentOptions.resetIdleTimer();
    currentOptions.scheduleVoiceRestart(context.isVoiceTriggered);
  };

  const cancel = (cancelOptions?: { updateUi?: boolean }): void => {
    const requestId = streamRequestIdRef.current;
    const streamId = streamIdRef.current;
    const context = streamContextRef.current;
    const preserveCommittedReply = Boolean(
      context &&
        optionsRef.current.voiceReply.hasCommittedSpeech() &&
        context.latestSafeReply.trim()
    );
    streamRequestIdRef.current = undefined;
    streamIdRef.current = undefined;
    streamContextRef.current = undefined;
    optionsRef.current.voiceReply.cancelSynchronizedReveal();

    if (requestId || streamId) {
      void window.desktopPet?.aiChat
        .cancel({
          petId: context?.petId ?? optionsRef.current.petId,
          requestId,
          streamId
        })
        .catch(() => undefined);
    }
    if (context) {
      optionsRef.current.voiceReply.stop({
        clearPresentation: cancelOptions?.updateUi ?? true
      });
    }
    if (cancelOptions?.updateUi ?? true) {
      if (context) {
        clearTypewriter();
        setMessages((current) =>
          current.map((message) =>
            message.id === context.pendingMessageId
              ? {
                  ...message,
                  text: preserveCommittedReply
                    ? buildInterruptedReplyText(context.latestSafeReply, "回复已取消")
                    : "回复已取消。",
                  status: "error"
                }
              : message
          )
        );
      }
      setSendingState(false);
    }
  };

  useLayoutEffect(() => {
    cancelRef.current = cancel;
  });

  useLayoutEffect(() => {
    streamEventHandlerRef.current = (event: AiChatStreamEvent): void => {
      const context = streamContextRef.current;
      if (
        !context ||
        !isCurrentAiStreamEvent(event, {
          requestId: streamRequestIdRef.current,
          streamId: streamIdRef.current,
          petId: context.petId
        })
      ) {
        return;
      }

      if (event.type === "chunk") {
        const { replyText } = selectSafeAiStreamPresentation(event);
        context.latestSafeReply = replyText;
        if (context.syncTextWithVoice) {
          optionsRef.current.voiceReply.updateSynchronizedContent(replyText);
        } else {
          showStreamingReply(context.pendingMessageId, replyText);
        }
        enqueueSafeStreamingVoiceChunk(
          event,
          {
            enabled: context.voiceReplyEnabled,
            useReplyAsVoiceText: context.useReplyAsVoiceText,
            requestId: context.voiceReplyRequestId
          },
          optionsRef.current.voiceReply
        );
        return;
      }

      streamRequestIdRef.current = undefined;
      streamIdRef.current = undefined;
      streamContextRef.current = undefined;
      if (event.type === "done" && event.ok && event.content) {
        void finishReply(context, event);
      } else {
        failReply(
          context,
          event.message ??
            (event.type === "canceled" ? "回复已取消。" : "AI 暂时没有回应，请稍后再试。")
        );
      }
    };
  });

  useEffect(() => {
    return window.desktopPet?.aiChat.onStreamEvent((event) => {
      streamEventHandlerRef.current(event);
    });
  }, []);

  useEffect(() => {
    const cancelWhenHidden = (): void => {
      if (document.hidden) {
        cancelRef.current();
      }
    };
    const cancelOnPageHide = (): void => cancelRef.current({ updateUi: false });
    document.addEventListener("visibilitychange", cancelWhenHidden);
    window.addEventListener("pagehide", cancelOnPageHide);
    return () => {
      document.removeEventListener("visibilitychange", cancelWhenHidden);
      window.removeEventListener("pagehide", cancelOnPageHide);
    };
  }, []);

  useEffect(() => {
    return () => {
      clearTypewriter();
      cancelRef.current({ updateUi: false });
    };
  }, []);

  const sendMessageText = async (text: string, isVoiceTriggered = false): Promise<void> => {
    const nextText = text.trim();
    if (!nextText || sendingRef.current) {
      return;
    }

    cancel({ updateUi: false });
    clearTypewriter();
    const currentOptions = optionsRef.current;
    const settingsSnapshot = createAiStreamSettingsSnapshot(
      currentOptions.settings,
      currentOptions.petDefinition
    );
    const userMessageId = Date.now();
    const pendingMessageId = userMessageId + 1;
    const requestId = `chat-${Date.now()}-${++requestSequenceRef.current}`;
    const shouldSynchronize = settingsSnapshot.syncTextWithVoice;
    const voiceReplyRequestId = currentOptions.voiceReply.beginReply(
      pendingMessageId,
      shouldSynchronize,
      settingsSnapshot.voiceReplyEnabled,
      requestId
    );
    const context: AiStreamContext = {
      requestId,
      petId: currentOptions.petId,
      pendingMessageId,
      isVoiceTriggered,
      voiceReplyRequestId,
      latestSafeReply: "",
      ...settingsSnapshot
    };
    streamRequestIdRef.current = requestId;
    streamIdRef.current = undefined;
    streamContextRef.current = context;
    const aiMessages = buildAiMessages({
      messages: messagesRef.current,
      nextUserText: nextText
    });

    setSendingState(true);
    setMessages((current) => [
      ...current,
      { id: userMessageId, role: "user", text: nextText },
      { id: pendingMessageId, role: "pet", text: "思考中...", status: "thinking" }
    ]);
    currentOptions.draftRef.current = "";
    currentOptions.setDraft("");
    currentOptions.clearVoiceTypewriter();
    currentOptions.triggerExpression("focus", "normal", 1800);
    currentOptions.speakLine("userMessage", "嗯，我听见了。");
    currentOptions.resetIdleTimer();

    try {
      const streamResult = await window.desktopPet?.aiChat.stream({
        petId: context.petId,
        requestId,
        messages: aiMessages
      });

      if (
        streamRequestIdRef.current !== requestId ||
        streamContextRef.current?.requestId !== requestId
      ) {
        if (streamResult?.streamId) {
          void window.desktopPet?.aiChat
            .cancel({
              petId: context.petId,
              requestId,
              streamId: streamResult.streamId
            })
            .catch(() => undefined);
        }
        return;
      }

      if (!streamResult?.ok || !streamResult.streamId) {
        streamRequestIdRef.current = undefined;
        streamContextRef.current = undefined;
        failReply(context, streamResult?.message ?? "AI 暂时没有回应，请稍后再试。");
      } else if (streamResult.requestId && streamResult.requestId !== requestId) {
        streamRequestIdRef.current = undefined;
        streamContextRef.current = undefined;
        void window.desktopPet?.aiChat
          .cancel({
            petId: context.petId,
            requestId: streamResult.requestId,
            streamId: streamResult.streamId
          })
          .catch(() => undefined);
        failReply(context, "AI 请求标识不一致，请稍后再试。");
      } else {
        streamIdRef.current = streamResult.streamId;
      }
    } catch {
      if (streamRequestIdRef.current !== requestId) {
        return;
      }
      streamRequestIdRef.current = undefined;
      streamIdRef.current = undefined;
      streamContextRef.current = undefined;
      failReply(context, "无法连接 AI 服务，请检查网络或本地服务状态。");
    }
  };

  return {
    cancel,
    messages,
    sendMessageText,
    sending,
    showStreamingReply
  };
}
