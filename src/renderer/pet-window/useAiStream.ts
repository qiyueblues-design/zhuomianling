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
  extractStreamingReplyText,
  extractStreamingVoiceText,
  inferExpressionFromAiReply,
  parseStructuredReplyFallback,
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
  subtitle: Pick<ReturnType<typeof useSubtitle>, "show">;
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
  showAiReplySubtitle: (
    text: string,
    options?: { holdMs?: number; mode?: "instant" | "typewriter" }
  ) => void;
  resetIdleTimer: () => void;
  scheduleVoiceRestart: (isVoiceTriggered: boolean) => void;
}

interface AiStreamContext {
  requestId: string;
  petId: string;
  pendingMessageId: number;
  isVoiceTriggered: boolean;
  streamedTextShown: boolean;
  voiceReplyRequestId: number;
  voiceReplyEnabled: boolean;
  syncTextWithVoice: boolean;
  useReplyAsVoiceText: boolean;
}

export interface AiStreamSettingsSnapshot {
  voiceReplyEnabled: boolean;
  syncTextWithVoice: boolean;
  useReplyAsVoiceText: boolean;
}

export interface UseAiStreamResult {
  cancel: (options?: { updateUi?: boolean }) => void;
  messages: ChatMessage[];
  sendMessageText: (text: string, isVoiceTriggered?: boolean) => Promise<void>;
  sending: boolean;
  showStreamingReply: (pendingMessageId: number, rawContent: string) => boolean;
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
  };

  const showPetMessageWithTypewriter = (
    messageId: number,
    fullText: string,
    messageOptions?: { voiceText?: string; aiRawContent?: string }
  ): void => {
    clearTypewriter();
    const characters = Array.from(fullText);
    const sequenceId = typewriterSequenceRef.current;
    let nextIndex = Math.min(1, characters.length);

    setMessages((current) =>
      current.map((message) =>
        message.id === messageId
          ? {
              id: messageId,
              role: "pet",
              text: characters.slice(0, nextIndex).join(""),
              voiceText: messageOptions?.voiceText,
              aiRawContent: messageOptions?.aiRawContent
            }
          : message
      )
    );

    const typeNext = (): void => {
      if (sequenceId !== typewriterSequenceRef.current) {
        return;
      }
      nextIndex += 1;
      const nextText = characters.slice(0, nextIndex).join("");
      setMessages((current) =>
        current.map((message) =>
          message.id === messageId ? { ...message, text: nextText } : message
        )
      );
      if (nextIndex < characters.length) {
        typewriterTimerRef.current = window.setTimeout(typeNext, chatReplyTypewriterDelayMs);
      }
    };

    if (nextIndex < characters.length) {
      typewriterTimerRef.current = window.setTimeout(typeNext, chatReplyTypewriterDelayMs);
    }
  };

  const showStreamingReply = (pendingMessageId: number, rawContent: string): boolean => {
    const replyText = extractStreamingReplyText(rawContent);
    if (!replyText) {
      return false;
    }

    clearTypewriter();
    setMessages((current) =>
      current.map((message) =>
        message.id === pendingMessageId
          ? { ...message, text: replyText, status: undefined }
          : message
      )
    );
    const currentDefinition = optionsRef.current.petDefinition;
    optionsRef.current.subtitle.show({
      text: replyText,
      mode: "instant",
      holdMs: Number.POSITIVE_INFINITY,
      tone: currentDefinition?.subtitleStyle?.tone,
      maxWidth: currentDefinition?.subtitleStyle?.maxWidth
    });
    const context = streamContextRef.current;
    if (context?.pendingMessageId === pendingMessageId) {
      context.streamedTextShown = true;
    }
    return true;
  };

  const getStreamingVoiceSourceText = (
    content: string,
    useReplyAsVoiceText: boolean
  ): string => {
    return useReplyAsVoiceText
      ? extractStreamingReplyText(content)
      : extractStreamingVoiceText(content);
  };

  const finishReply = async (context: AiStreamContext, rawContent: string): Promise<void> => {
    const currentOptions = optionsRef.current;
    const definition = currentOptions.petDefinition;
    const parsedResponse = parseStructuredReplyFallback(rawContent);
    const replyText = parsedResponse.reply;
    const voiceText = parsedResponse.voiceText;
    const effectiveVoiceText = context.voiceReplyEnabled
      ? context.useReplyAsVoiceText || !voiceText?.trim()
        ? replyText
        : voiceText
      : voiceText;
    const inferredExpression = inferExpressionFromAiReply(replyText);
    const randomExpressionMode = definition?.expressionSelectionMode === "random";
    const randomReplySource = randomExpressionMode
      ? currentOptions.pickRandomExpressionSource()
      : undefined;
    const replyExpression = randomExpressionMode
      ? undefined
      : resolveMappedExpression(parsedResponse.emotion, definition?.expressions, inferredExpression);
    const shouldHoldSubtitleForVoice =
      context.voiceReplyEnabled && Boolean(effectiveVoiceText?.trim());
    const requestId = context.voiceReplyRequestId;
    const syncTextWithVoice =
      shouldHoldSubtitleForVoice && context.syncTextWithVoice;

    if (syncTextWithVoice) {
      currentOptions.voiceReply.updateSynchronizedContent(rawContent);
      currentOptions.voiceReply.enqueueFinalText(
        effectiveVoiceText || currentOptions.voiceReply.getStreamedVoiceText(),
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

    if (context.streamedTextShown) {
      clearTypewriter();
      setMessages((current) =>
        current.map((message) =>
          message.id === context.pendingMessageId
            ? {
                ...message,
                text: replyText,
                status: undefined,
                voiceText: effectiveVoiceText,
                aiRawContent: rawContent
              }
            : message
        )
      );
    } else {
      showPetMessageWithTypewriter(context.pendingMessageId, replyText, {
        voiceText: effectiveVoiceText,
        aiRawContent: rawContent
      });
    }

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
    currentOptions.showAiReplySubtitle(replyText, {
      mode: context.streamedTextShown ? "instant" : "typewriter",
      holdMs: shouldHoldSubtitleForVoice ? Number.POSITIVE_INFINITY : undefined
    });

    if (!syncTextWithVoice && shouldHoldSubtitleForVoice) {
      currentOptions.voiceReply.enqueueFinalText(
        effectiveVoiceText || currentOptions.voiceReply.getStreamedVoiceText(),
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
    currentOptions.voiceReply.stop();
    clearTypewriter();
    setMessages((current) =>
      current.map((message) =>
        message.id === context.pendingMessageId
          ? { id: context.pendingMessageId, role: "pet", text: errorText, status: "error" }
          : message
      )
    );
    currentOptions.triggerExpression("panic", "high", 3600);
    currentOptions.subtitle.show({
      text: errorText,
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
              ? { ...message, text: "回复已取消。", status: "error" }
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
        const content = event.content ?? "";
        if (context.syncTextWithVoice) {
          optionsRef.current.voiceReply.updateSynchronizedContent(content);
          optionsRef.current.voiceReply.enqueueStreamingText(
            getStreamingVoiceSourceText(content, context.useReplyAsVoiceText),
            context.voiceReplyRequestId
          );
          optionsRef.current.voiceReply.revealSynchronizedOutput(context.voiceReplyRequestId);
          if (optionsRef.current.voiceReply.isSynchronizedRevealVisible()) {
            showStreamingReply(context.pendingMessageId, content);
          }
        } else {
          optionsRef.current.voiceReply.enqueueStreamingText(
            extractStreamingVoiceText(content),
            context.voiceReplyRequestId
          );
          showStreamingReply(context.pendingMessageId, content);
        }
        return;
      }

      streamRequestIdRef.current = undefined;
      streamIdRef.current = undefined;
      streamContextRef.current = undefined;
      if (event.type === "done" && event.ok && event.content) {
        void finishReply(context, event.content);
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
      settingsSnapshot.voiceReplyEnabled
    );
    const context: AiStreamContext = {
      requestId,
      petId: currentOptions.petId,
      pendingMessageId,
      isVoiceTriggered,
      streamedTextShown: false,
      voiceReplyRequestId,
      ...settingsSnapshot
    };
    streamRequestIdRef.current = requestId;
    streamIdRef.current = undefined;
    streamContextRef.current = context;
    const aiMessages = buildAiMessages({
      petDefinition: currentOptions.petDefinition,
      messages: messagesRef.current,
      nextUserText: nextText,
      voiceReplyEnabled: settingsSnapshot.voiceReplyEnabled
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
