import {
  ChevronDown,
  ChevronUp,
  Mic,
  Send,
  X
} from "lucide-react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties } from "react";
import type {
  PetCustomTheme,
  PetExpressionKey,
  PetExpressionRandomScope,
  PetExpressionSourceItem,
  PetEventSettings,
  PetLine,
  PetLineEvent,
  PetPresetLine
} from "../../shared/types/pet";
import type { PetWindowDragPoint, PetWindowState } from "../../shared/types/window";
import { Subtitle } from "../components/Subtitle/Subtitle";
import type { PetExpressionEvent } from "../live2d/Live2DCanvas";
import { Live2DCanvas } from "../live2d/Live2DCanvas";
import { defaultSpeechFrontendSettings } from "../services/speech/speechSettings";
import { useSubtitle } from "../services/subtitle/subtitleStore";
import {
  extractStreamingReplyPreview,
  extractStreamingVoiceText,
  inferExpressionFromAiReply,
  parseStructuredReplyFallback,
  resolveMappedExpression,
  splitVoiceTextIntoSegments,
  takeCompleteVoiceSegments
} from "./aiReplyUtils";
import {
  arrayBufferToBase64,
  base64ToBlob,
  calculateAudioLevel,
  encodePcm16,
  encodeWav,
  mergeAudioChunks,
  resampleAudio
} from "./audioUtils";
import {
  createPetWindowStateFromPayload,
  fallbackState,
  readSearchParams
} from "./petWindowState";
import { buildAiMessages } from "./promptBuilder";
import { RadialPetMenu } from "./RadialPetMenu";
import { buildSpeechSettings, defaultEventSettings } from "./speechRuntime";

interface ChatMessage {
  id: number;
  role: "user" | "pet";
  text: string;
  status?: "thinking" | "error";
  voiceText?: string;
  aiRawContent?: string;
}

type VoiceInputState = "idle" | "recording" | "transcribing";
type VoiceStopReason = "auto" | "manual";

interface VoiceReplyAudio {
  audioUrl: string;
  mimeType: string;
}

interface VoiceReplyQueueState {
  items: Array<{
    segment: string;
    audioPromise?: Promise<VoiceReplyAudio | undefined>;
  }>;
  playing: boolean;
  playbackBlocked: boolean;
  streamedVoiceText: string;
  streamedConsumedLength: number;
  queuedVoiceSegments: string[];
}

interface SyncVoiceRevealState {
  requestId: number;
  pendingMessageId: number;
  latestContent: string;
  revealed: boolean;
  firstAudioSettled: boolean;
  watchingFirstAudio: boolean;
}

const voiceWaveformBarCount = 12;
const initialVoiceWaveformLevels = Array.from({ length: voiceWaveformBarCount }, () => 0.18);
const voiceAutoSendFallbackMs = 400;
const voiceReplySynthesisLookahead = 3;
const voiceReplySegmentMaxAttempts = 3;
const voiceReplySegmentRetryBaseMs = 220;
const chatReplyTypewriterDelayMs = 34;
const chatInputMaxVisibleHeightPx = 65;
const aiReplyPendingText = "回复生成中...";

function normalizeVoiceReplyText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function waitForVoiceRetry(delayMs: number): Promise<void> {
  return new Promise((resolve) => {
    window.setTimeout(resolve, delayMs);
  });
}

function getUnqueuedFinalVoiceSegments(finalVoiceText: string, queuedSegments: string[]): string[] {
  const normalizedFinalText = normalizeVoiceReplyText(finalVoiceText);

  if (!normalizedFinalText) {
    return [];
  }

  if (!queuedSegments.length) {
    return splitVoiceTextIntoSegments(normalizedFinalText);
  }

  const queuedPrefix = normalizeVoiceReplyText(queuedSegments.join(" "));

  if (queuedPrefix && normalizedFinalText.startsWith(queuedPrefix)) {
    return splitVoiceTextIntoSegments(normalizedFinalText.slice(queuedPrefix.length));
  }

  const finalSegments = splitVoiceTextIntoSegments(normalizedFinalText);
  const queuedKeys = queuedSegments.map(normalizeVoiceReplyText);
  let queuedIndex = 0;

  return finalSegments.filter((segment) => {
    const segmentKey = normalizeVoiceReplyText(segment);

    for (let index = queuedIndex; index < queuedKeys.length; index += 1) {
      if (queuedKeys[index] === segmentKey) {
        queuedIndex = index + 1;
        return false;
      }
    }

    return true;
  });
}

function getTextDisplayDurationMs(text: string): number {
  const textLength = text.trim().length;
  const subtitleHoldMs = Math.min(Math.max(textLength * 110, 2200), 6200);
  const typewriterMs = textLength * 42;

  return typewriterMs + subtitleHoldMs;
}

const fallbackEventLines: Partial<Record<PetLineEvent, PetLine[]>> = {
  ready: ["我来啦，今天也会陪在你旁边。", "我到啦，今天也会安静陪着你。"],
  click: ["嗯？叫我吗？", "我在呢。"],
  chatOpen: ["嗯，我在听。", "可以和我说说。"],
  chatClose: ["好，我先安静陪着你。", "我先收起来，有需要再叫我。"],
  userMessage: ["嗯，我听见了。", "我收到啦。"],
  aiReply: ["我想好了。", "我整理好啦。"],
  idle: ["我还在这里，别担心。", "我会安静陪着你。"],
  drag: ["慢一点，我跟着你走。", "好，我换个位置陪你。"],
  rapidClick: ["呜哇，点得有点快啦。", "我在我在，别急。"],
  clickThroughOn: ["我先把自己挪到不打扰你的状态。", "我会安静一点，不挡住你操作。"],
  clickThroughOff: ["我又可以和你互动啦。", "我回来啦，可以继续叫我。"],
  closing: ["那我先回去休息啦。", "我先退下啦，下次再陪你。"],
  modelError: [
    "我好像没能正确出现，可以帮我检查一下模型文件吗？",
    "我卡住了，可以帮我看看模型资源吗？"
  ]
};

function getCustomThemeStyle(theme: PetCustomTheme | undefined): CSSProperties | undefined {
  if (!theme) {
    return undefined;
  }

  const { tokens } = theme;

  return {
    "--custom-theme-background": tokens.background,
    "--custom-theme-surface": tokens.surface,
    "--custom-theme-pet-surface": tokens.petSurface ?? tokens.surface,
    "--custom-theme-text": tokens.text,
    "--custom-theme-muted": tokens.mutedText,
    "--custom-theme-accent": tokens.accent,
    "--custom-theme-accent-strong": tokens.accentStrong ?? tokens.accent,
    "--custom-theme-border": tokens.border,
    "--custom-theme-danger": tokens.danger ?? "#ef4444",
    "--custom-theme-shadow": tokens.shadow ?? "none",
    "--custom-theme-radius": `${tokens.radius ?? 14}px`
  } as CSSProperties;
}

export function PetWindow(): JSX.Element {
  const initialPet = useMemo(readSearchParams, []);
  const [pet, setPet] = useState(initialPet);
  const petDefinition = pet.petDefinition;
  const voiceInputEnabled = Boolean(petDefinition?.capabilities.voiceInput);
  const uiTheme = petDefinition?.uiSettings?.theme ?? "soft";
  const customThemeStyle = getCustomThemeStyle(petDefinition?.uiSettings?.customTheme);
  const subtitle = useSubtitle();
  const clickThroughButtonRef = useRef<HTMLButtonElement>(null);
  const chatMessagesRef = useRef<HTMLDivElement>(null);
  const chatDraftInputRef = useRef<HTMLTextAreaElement>(null);
  const chatPanelDragRef = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    left: number;
    bottom: number;
  } | null>(null);
  const clickThroughButtonInteractiveRef = useRef(false);
  const draggingRef = useRef(false);
  const modelDragMovedRef = useRef(false);
  const modelDragLineShownRef = useRef(false);
  const lastModelTouchHitAtRef = useRef(0);
  const rapidModelClickCountRef = useRef(0);
  const rapidModelClickWindowStartedAtRef = useRef(0);
  const lookAtListenersRef = useRef(new Set<(point: { clientX: number; clientY: number }) => void>());

  useEffect(() => {
    let disposed = false;

    void window.desktopPet?.petWindow.getPayload().then((payload) => {
      if (!payload || disposed) {
        return;
      }

      setPet(createPetWindowStateFromPayload(payload, initialPet));
    });

    return () => {
      disposed = true;
    };
  }, [initialPet]);

  useEffect(() => {
    return window.desktopPet?.petConfig.onChanged((changedPet) => {
      if (changedPet?.id === pet.petId) {
        setPet((currentPet) =>
          createPetWindowStateFromPayload(
            {
              id: changedPet.id,
              name: changedPet.name,
              modelPath: changedPet.modelPath,
              avatar: changedPet.avatar,
              definition: changedPet
            },
            currentPet
          )
        );
        return;
      }

      if (!changedPet) {
        void window.desktopPet?.petWindow.getPayload().then((payload) => {
          if (payload?.id === pet.petId) {
            setPet((currentPet) => createPetWindowStateFromPayload(payload, currentPet));
          }
        });
      }
    });
  }, [pet.petId]);

  useEffect(() => {
    return window.desktopPet?.petWindow.onCursorMoved((point) => {
      for (const listener of lookAtListenersRef.current) {
        listener({
          clientX: point.windowX,
          clientY: point.windowY
        });
      }
    });
  }, []);
  const modelDragStartPointRef = useRef<
    | {
        pointerId: number;
        screenX: number;
        screenY: number;
      }
    | undefined
  >();
  const pendingPetWindowDragPointRef = useRef<PetWindowDragPoint | undefined>();
  const petWindowDragFrameRef = useRef<number | undefined>();
  const idleTimerRef = useRef<number | undefined>();
  const audioContextRef = useRef<AudioContext | null>(null);
  const audioProcessorRef = useRef<ScriptProcessorNode | null>(null);
  const audioSourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const presetLineAudioRef = useRef<HTMLAudioElement | null>(null);
  const voiceReplyAudioRef = useRef<HTMLAudioElement | null>(null);
  const voiceReplyUrlRef = useRef<string | undefined>();
  const voiceReplyPendingUrlsRef = useRef<Set<string>>(new Set());
  const voiceReplyQueueRef = useRef<VoiceReplyQueueState>({
    items: [],
    playing: false,
    playbackBlocked: false,
    streamedVoiceText: "",
    streamedConsumedLength: 0,
    queuedVoiceSegments: []
  });
  const syncVoiceRevealRef = useRef<SyncVoiceRevealState | undefined>();
  const voiceReplyRequestIdRef = useRef(0);
  const voiceReplySubtitleHoldRef = useRef<
    | {
        requestId: number;
        active: boolean;
      }
    | undefined
  >();
  const voiceReplyExpressionHoldRef = useRef<
    | {
        requestId: number;
        active: boolean;
      }
    | undefined
  >();
  const pendingVoiceReplyExpressionRef = useRef<PetExpressionKey | undefined>();
  const audioChunksRef = useRef<Float32Array[]>([]);
  const draftRef = useRef("");
  const streamSessionIdRef = useRef<string | undefined>();
  const streamPendingSamplesRef = useRef<Float32Array[]>([]);
  const streamFinalSegmentsRef = useRef<Map<number, string>>(new Map());
  const streamPartialTextRef = useRef("");
  const streamStoppingRef = useRef(false);
  const voiceAutoSendPendingRef = useRef(false);
  const sendRecognizedVoiceTextRef = useRef<() => void>(() => undefined);
  const aiChatStreamIdRef = useRef<string | undefined>();
  const aiChatStreamContextRef = useRef<
    | {
        pendingMessageId: number;
        isVoiceTriggered: boolean;
      }
    | undefined
  >();
  const aiReplyStreamingSubtitleMessageIdRef = useRef<number | undefined>();
  const voiceAutoSendTimerRef = useRef<number | undefined>();
  const voiceRestartTimerRef = useRef<number | undefined>();
  const voiceRestartAfterReplyRef = useRef(false);
  const voiceDetectedRef = useRef(false);
  const voiceLastActiveAtRef = useRef(0);
  const voiceStartedAtRef = useRef(0);
  const voiceInputStateRef = useRef<VoiceInputState>("idle");
  const chatMessageTypewriterTimerRef = useRef<number | undefined>();
  const chatMessageTypewriterSequenceRef = useRef(0);
  const speechSettingsRef = useRef(defaultSpeechFrontendSettings);
  const nextSendFromVoiceRef = useRef(false);
  const sendingRef = useRef(false);
  const audioStreamRef = useRef<MediaStream | null>(null);
  const [state, setState] = useState<PetWindowState>(fallbackState);
  const [chatOpen, setChatOpen] = useState(false);
  const [chatCollapsed, setChatCollapsed] = useState(false);
  const [touchEnabled, setTouchEnabled] = useState(false);
  const [chatPanelPosition, setChatPanelPosition] = useState({ left: 8, bottom: 8 });
  const [radialMenuOpen, setRadialMenuOpen] = useState(false);
  const [radialMenuPosition, setRadialMenuPosition] = useState({ x: 190, y: 190 });
  const [closingEffect, setClosingEffect] = useState(false);
  const [expressionEvent, setExpressionEvent] = useState<PetExpressionEvent | undefined>();
  const [explodeEventId, setExplodeEventId] = useState(0);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [voiceInputState, setVoiceInputState] = useState<VoiceInputState>("idle");
  const [voiceTypewriterTarget, setVoiceTypewriterTarget] = useState("");
  const [voiceTypewriterText, setVoiceTypewriterText] = useState("");
  const [voiceTypewriterActive, setVoiceTypewriterActive] = useState(false);
  const [voiceWaveformLevels, setVoiceWaveformLevels] = useState(initialVoiceWaveformLevels);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const petRef = useRef(pet);
  const petDefinitionRef = useRef(petDefinition);
  const messagesRef = useRef<ChatMessage[]>(messages);

  const setSendingState = (nextSending: boolean): void => {
    sendingRef.current = nextSending;
    setSending(nextSending);
  };

  const clearVoiceTypewriter = (): void => {
    setVoiceTypewriterActive(false);
    setVoiceTypewriterTarget("");
    setVoiceTypewriterText("");
  };

  const clearChatMessageTypewriter = (): void => {
    chatMessageTypewriterSequenceRef.current += 1;
    window.clearTimeout(chatMessageTypewriterTimerRef.current);
    chatMessageTypewriterTimerRef.current = undefined;
  };

  const showPetMessageWithTypewriter = (
    messageId: number,
    fullText: string,
    options?: {
      voiceText?: string;
      aiRawContent?: string;
    }
  ): void => {
    clearChatMessageTypewriter();

    const characters = Array.from(fullText);
    const sequenceId = chatMessageTypewriterSequenceRef.current;
    let nextIndex = Math.min(1, characters.length);

    setMessages((currentMessages) =>
      currentMessages.map((message) =>
        message.id === messageId
          ? {
              id: messageId,
              role: "pet",
              text: characters.slice(0, nextIndex).join(""),
              voiceText: options?.voiceText,
              aiRawContent: options?.aiRawContent
            }
          : message
      )
    );

    const typeNext = (): void => {
      if (sequenceId !== chatMessageTypewriterSequenceRef.current) {
        return;
      }

      nextIndex += 1;
      const nextText = characters.slice(0, nextIndex).join("");

      setMessages((currentMessages) =>
        currentMessages.map((message) =>
          message.id === messageId
            ? {
                ...message,
                text: nextText
              }
            : message
        )
      );

      if (nextIndex < characters.length) {
        chatMessageTypewriterTimerRef.current = window.setTimeout(typeNext, chatReplyTypewriterDelayMs);
      }
    };

    if (nextIndex < characters.length) {
      chatMessageTypewriterTimerRef.current = window.setTimeout(typeNext, chatReplyTypewriterDelayMs);
    }
  };

  const setRecognizedVoiceDraft = (text: string): void => {
    draftRef.current = text;
    setDraft(text);

    if (!text) {
      clearVoiceTypewriter();
      return;
    }

    setVoiceTypewriterTarget(text);
    setVoiceTypewriterText((currentText) => (text.startsWith(currentText) ? currentText : ""));
    setVoiceTypewriterActive(true);
  };

  useEffect(() => {
    draftRef.current = draft;
  }, [draft]);

  useEffect(() => {
    petRef.current = pet;
    petDefinitionRef.current = petDefinition;
  }, [pet, petDefinition]);

  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);

  useEffect(() => {
    voiceInputStateRef.current = voiceInputState;
  }, [voiceInputState]);

  useLayoutEffect(() => {
    const input = chatDraftInputRef.current;

    if (!input) {
      return;
    }

    input.style.height = "0px";
    input.style.height = `${Math.min(input.scrollHeight, chatInputMaxVisibleHeightPx)}px`;
  }, [chatCollapsed, chatOpen, draft, voiceTypewriterText]);

  useEffect(() => {
    if (!voiceTypewriterActive) {
      return;
    }

    if (!voiceTypewriterTarget) {
      setVoiceTypewriterText("");
      return;
    }

    if (voiceTypewriterText === voiceTypewriterTarget) {
      if (voiceInputState !== "idle") {
        return;
      }

      const finishTimer = window.setTimeout(() => {
        setVoiceTypewriterActive(false);
      }, 520);

      return () => {
        window.clearTimeout(finishTimer);
      };
    }

    const typingTimer = window.setTimeout(() => {
      setVoiceTypewriterText((currentText) => {
        if (!voiceTypewriterTarget.startsWith(currentText)) {
          return voiceTypewriterTarget.slice(0, 1);
        }

        return voiceTypewriterTarget.slice(0, Math.min(currentText.length + 1, voiceTypewriterTarget.length));
      });
    }, 28);

    return () => {
      window.clearTimeout(typingTimer);
    };
  }, [voiceInputState, voiceTypewriterActive, voiceTypewriterTarget, voiceTypewriterText]);

  useEffect(() => {
    return () => {
      clearChatMessageTypewriter();
      stopVoiceReplyPlayback();
    };
  }, []);

  const normalizePresetLine = (line: PetLine | undefined): PetPresetLine | undefined => {
    if (!line) {
      return undefined;
    }

    return typeof line === "string" ? { text: line } : line;
  };

  const pickLineFromLines = (lines: PetLine[] | undefined): PetPresetLine | undefined => {
    const normalizedLines =
      lines
        ?.map(normalizePresetLine)
        .filter(
          (line): line is PetPresetLine =>
            Boolean(line?.text?.trim() || line?.audioPath?.trim())
        ) ?? [];

    if (!normalizedLines.length) {
      return undefined;
    }

    return normalizedLines[Math.floor(Math.random() * normalizedLines.length)] ?? normalizedLines[0];
  };

  const pickLine = (eventName: PetLineEvent): PetPresetLine | undefined => {
    return (
      pickLineFromLines(petDefinition?.lines?.[eventName]) ??
      pickLineFromLines(fallbackEventLines[eventName])
    );
  };

  const getEventSettings = (
    eventName: PetLineEvent
  ): PetEventSettings & { expressionDurationMs: number; sourceDurationMs: number } => {
    const defaults = defaultEventSettings[eventName] ?? {
      expressionDurationMs: 2600
    };
    const savedSettings = petDefinition?.eventSettings?.[eventName];
    const savedExpression = savedSettings?.expression;
    const expression =
      savedExpression && petDefinition?.expressions?.[savedExpression]
        ? savedExpression
        : defaults.expression;

    return {
      expression,
      expressionDurationMs: savedSettings?.expressionDurationMs ?? defaults.expressionDurationMs,
      source: savedSettings?.source,
      sourceDurationMs:
        savedSettings?.sourceDurationMs ??
        savedSettings?.expressionDurationMs ??
        defaults.expressionDurationMs
    };
  };

  const triggerEventExpression = (
    eventName: PetLineEvent,
    priority: PetExpressionEvent["priority"] = "normal",
    fallbackExpression?: PetExpressionKey
  ): void => {
    const settings = getEventSettings(eventName);

    if (settings.source) {
      triggerExpressionSource(settings.source, priority, settings.sourceDurationMs);
      return;
    }

    const hasSavedSettings = Boolean(petDefinition?.eventSettings?.[eventName]);
    const expression = hasSavedSettings ? settings.expression : settings.expression ?? fallbackExpression;

    if (!expression) {
      return;
    }

    triggerExpression(expression, priority, settings.expressionDurationMs);
  };

  const speakLine = (
    eventName: PetLineEvent,
    fallbackText: string,
    options?: { mode?: "instant" | "typewriter" }
  ): void => {
    const voiceSubtitleHold = voiceReplySubtitleHoldRef.current;
    const pickedLine = pickLine(eventName);
    const text = pickedLine?.text?.trim() || fallbackText;

    if (
      petDefinition?.capabilities.subtitles &&
      !(
        voiceSubtitleHold?.active &&
        voiceSubtitleHold.requestId === voiceReplyRequestIdRef.current
      )
    ) {
      subtitle.show({
        text,
        mode: options?.mode ?? "typewriter",
        tone: petDefinition.subtitleStyle?.tone,
        maxWidth: petDefinition.subtitleStyle?.maxWidth
      });
    }

    if (pickedLine?.audioPath) {
      void playPresetLineAudio(pickedLine.audioPath);
    }
  };

  const hasConfiguredEvent = (eventName: PetLineEvent): boolean => {
    const configuredSource = petDefinition?.eventSettings?.[eventName]?.source;
    const hasSource = Boolean(configuredSource?.sourceFileName?.trim());
    const configuredExpression = petDefinition?.eventSettings?.[eventName]?.expression;
    const hasExpression = Boolean(
      configuredExpression && petDefinition?.expressions?.[configuredExpression]
    );
    const hasLine = Boolean(petDefinition?.lines?.[eventName]?.some((line: PetLine) => {
      const normalizedLine = normalizePresetLine(line);

      return Boolean(normalizedLine?.text?.trim() || normalizedLine?.audioPath?.trim());
    }));

    return hasSource || hasExpression || hasLine;
  };

  const playPresetLineAudio = async (audioPath: string): Promise<void> => {
    const source = audioPath.trim();

    if (!source || voiceReplyAudioRef.current || voiceReplyQueueRef.current.playing) {
      return;
    }

    presetLineAudioRef.current?.pause();
    const audio = new Audio(source);
    presetLineAudioRef.current = audio;

    const cleanup = (): void => {
      if (presetLineAudioRef.current === audio) {
        presetLineAudioRef.current = null;
      }
    };

    audio.addEventListener("ended", cleanup, { once: true });
    audio.addEventListener("error", cleanup, { once: true });

    try {
      await audio.play();
    } catch {
      cleanup();
    }
  };

  const stopVoiceReplyPlayback = (): void => {
    voiceReplyRequestIdRef.current += 1;
    syncVoiceRevealRef.current = undefined;
    voiceReplySubtitleHoldRef.current = undefined;
    voiceReplyExpressionHoldRef.current = undefined;
    voiceRestartAfterReplyRef.current = false;
    presetLineAudioRef.current?.pause();
    presetLineAudioRef.current = null;
    voiceReplyAudioRef.current?.pause();
    voiceReplyAudioRef.current = null;
    voiceReplyQueueRef.current = {
      items: [],
      playing: false,
      playbackBlocked: false,
      streamedVoiceText: "",
      streamedConsumedLength: 0,
      queuedVoiceSegments: []
    };

    if (voiceReplyUrlRef.current) {
      window.URL.revokeObjectURL(voiceReplyUrlRef.current);
      voiceReplyUrlRef.current = undefined;
    }

    for (const audioUrl of voiceReplyPendingUrlsRef.current) {
      window.URL.revokeObjectURL(audioUrl);
    }

    voiceReplyPendingUrlsRef.current.clear();

    void window.desktopPet?.textToSpeech.stop();
  };

  const releaseVoiceReplySubtitle = (requestId: number): void => {
    const hold = voiceReplySubtitleHoldRef.current;

    if (!hold?.active || hold.requestId !== requestId || requestId !== voiceReplyRequestIdRef.current) {
      return;
    }

    hold.active = false;
    subtitle.hideAfter(1800);
  };

  const releaseVoiceReplyExpression = (requestId: number): void => {
    const hold = voiceReplyExpressionHoldRef.current;

    if (!hold?.active || hold.requestId !== requestId || requestId !== voiceReplyRequestIdRef.current) {
      return;
    }

    hold.active = false;
    triggerExpression("normal", "high", 1800);
  };

  const hasActiveVoiceReplyAudio = (): boolean =>
    Boolean(
      voiceReplyAudioRef.current ||
        voiceReplyQueueRef.current.playing ||
        voiceReplyQueueRef.current.items.length ||
        voiceReplyPendingUrlsRef.current.size
    );

  const getStreamingVoiceSourceText = (content: string): string => {
    const currentPetDefinition = petDefinitionRef.current;
    const chatLanguage = currentPetDefinition?.personaSettings?.chatLanguage ?? "zh";
    const voiceLanguage = currentPetDefinition?.voiceModelSettings?.language ?? "zh";

    if (chatLanguage === voiceLanguage) {
      const replyPreview = extractStreamingReplyPreview(content);

      return replyPreview === aiReplyPendingText ? "" : replyPreview;
    }

    return extractStreamingVoiceText(content);
  };

  const holdVoiceReplyExpression = (requestId: number, expression?: PetExpressionKey): void => {
    if (!expression || requestId !== voiceReplyRequestIdRef.current || voiceReplyExpressionHoldRef.current?.active) {
      return;
    }

    voiceReplyExpressionHoldRef.current = {
      requestId,
      active: true
    };
    triggerExpression(expression, "high", undefined, true);
  };

  const primeQueuedVoiceReplyItems = (
    queue: VoiceReplyQueueState,
    requestId: number,
    lookahead = voiceReplySynthesisLookahead
  ): void => {
    if (requestId !== voiceReplyRequestIdRef.current) {
      return;
    }

    let primedCount = 0;

    for (const item of queue.items) {
      if (primedCount >= lookahead) {
        return;
      }

      if (!item.audioPromise) {
        item.audioPromise = synthesizeVoiceSegment(item.segment, requestId);
      }

      primedCount += 1;
    }
  };

  const getStreamingReplyDisplayText = (content: string): string => {
    const preview = extractStreamingReplyPreview(content);

    return preview && preview !== aiReplyPendingText ? preview : "";
  };

  const showStreamingReplyPreview = (
    pendingMessageId: number,
    content: string,
    holdSubtitle: boolean
  ): boolean => {
    const displayPreview = getStreamingReplyDisplayText(content);

    if (!displayPreview) {
      return false;
    }

    aiReplyStreamingSubtitleMessageIdRef.current = pendingMessageId;
    showAiReplySubtitle(displayPreview, {
      mode: "instant",
      holdMs: holdSubtitle ? Number.POSITIVE_INFINITY : undefined
    });

    setMessages((currentMessages) =>
      currentMessages.map((message) =>
        message.id === pendingMessageId
          ? {
              ...message,
              text: displayPreview
            }
          : message
      )
    );

    return true;
  };

  const revealSynchronizedVoiceOutput = (requestId: number): boolean => {
    const revealState = syncVoiceRevealRef.current;
    const queue = voiceReplyQueueRef.current;

    if (
      !revealState ||
      revealState.requestId !== requestId ||
      revealState.revealed ||
      !revealState.firstAudioSettled ||
      requestId !== voiceReplyRequestIdRef.current
    ) {
      return false;
    }

    if (!showStreamingReplyPreview(revealState.pendingMessageId, revealState.latestContent, true)) {
      return false;
    }

    revealState.revealed = true;
    queue.playbackBlocked = false;
    void drainVoiceReplyQueue(requestId);

    return true;
  };

  const watchFirstQueuedVoiceForSync = (requestId: number): void => {
    const revealState = syncVoiceRevealRef.current;
    const queue = voiceReplyQueueRef.current;

    if (
      !revealState ||
      revealState.requestId !== requestId ||
      revealState.revealed ||
      revealState.firstAudioSettled ||
      revealState.watchingFirstAudio ||
      requestId !== voiceReplyRequestIdRef.current
    ) {
      return;
    }

    const firstItem = queue.items[0];

    if (!firstItem) {
      return;
    }

    revealState.watchingFirstAudio = true;
    firstItem.audioPromise ??= synthesizeVoiceSegment(firstItem.segment, requestId);

    void firstItem.audioPromise.then(() => {
      const currentRevealState = syncVoiceRevealRef.current;

      if (
        !currentRevealState ||
        currentRevealState.requestId !== requestId ||
        requestId !== voiceReplyRequestIdRef.current
      ) {
        return;
      }

      currentRevealState.firstAudioSettled = true;
      revealSynchronizedVoiceOutput(requestId);
    });
  };

  const drainVoiceReplyQueue = async (requestId: number): Promise<void> => {
    const queue = voiceReplyQueueRef.current;

    if (queue.playing || queue.playbackBlocked) {
      return;
    }

    queue.playing = true;

    try {
      while (requestId === voiceReplyRequestIdRef.current && queue.items.length > 0) {
        const item = queue.items.shift();

        if (!item) {
          continue;
        }

        item.audioPromise ??= synthesizeVoiceSegment(item.segment, requestId);
        const audio = await item.audioPromise;

        if (requestId !== voiceReplyRequestIdRef.current) {
          return;
        }

        if (!audio) {
          continue;
        }

        primeQueuedVoiceReplyItems(queue, requestId);

        const canContinue = await playAudioUrl(audio.audioUrl, audio.mimeType, requestId);

        if (!canContinue) {
          return;
        }
      }
    } finally {
      if (voiceReplyQueueRef.current === queue) {
        queue.playing = false;

        if (requestId === voiceReplyRequestIdRef.current && queue.items.length > 0) {
          void drainVoiceReplyQueue(requestId);
          return;
        }

        if (requestId === voiceReplyRequestIdRef.current && queue.items.length === 0) {
          releaseVoiceReplySubtitle(requestId);
          releaseVoiceReplyExpression(requestId);
          scheduleVoiceRestart(voiceRestartAfterReplyRef.current);
          voiceRestartAfterReplyRef.current = false;
        }
      }
    }
  };

  const enqueueVoiceReplySegments = (segments: string[], requestId: number): void => {
    enqueuePreparedVoiceReplySegments(
      segments.map((segment) => ({ segment })),
      requestId
    );
  };

  const enqueuePreparedVoiceReplySegments = (
    segments: Array<{ segment: string; audio?: VoiceReplyAudio }>,
    requestId: number
  ): void => {
    const filteredSegments = segments
      .map(({ segment, audio }) => ({
        segment: normalizeVoiceReplyText(segment),
        audio
      }))
      .filter((item) => item.segment);

    if (!filteredSegments.length || requestId !== voiceReplyRequestIdRef.current) {
      return;
    }

    if (pendingVoiceReplyExpressionRef.current) {
      holdVoiceReplyExpression(requestId, pendingVoiceReplyExpressionRef.current);
      pendingVoiceReplyExpressionRef.current = undefined;
    }

    voiceReplyQueueRef.current.queuedVoiceSegments.push(
      ...filteredSegments.map(({ segment }) => segment)
    );
    voiceReplyQueueRef.current.items.push(
      ...filteredSegments.map(({ segment, audio }) => ({
        segment,
        audioPromise: audio ? Promise.resolve(audio) : undefined
      }))
    );

    primeQueuedVoiceReplyItems(voiceReplyQueueRef.current, requestId);

    if (voiceReplyQueueRef.current.playbackBlocked) {
      watchFirstQueuedVoiceForSync(requestId);
      return;
    }

    void drainVoiceReplyQueue(requestId);
  };

  const enqueueFinalVoiceTextRemainder = (voiceText: string, requestId: number): void => {
    if (requestId !== voiceReplyRequestIdRef.current || !speechSettingsRef.current.voiceReplyEnabled) {
      return;
    }

    const queue = voiceReplyQueueRef.current;
    const finalSegments = getUnqueuedFinalVoiceSegments(voiceText, queue.queuedVoiceSegments);
    const normalizedVoiceText = normalizeVoiceReplyText(voiceText);

    queue.streamedVoiceText = normalizedVoiceText || queue.streamedVoiceText;
    queue.streamedConsumedLength = queue.streamedVoiceText.length;
    enqueueVoiceReplySegments(finalSegments, requestId);
  };

  const enqueueStreamingVoiceText = (
    streamedVoiceText: string,
    requestId: number,
    options?: { flushRest?: boolean }
  ): void => {
    if (requestId !== voiceReplyRequestIdRef.current || !speechSettingsRef.current.voiceReplyEnabled) {
      return;
    }

    const queue = voiceReplyQueueRef.current;

    if (!streamedVoiceText || streamedVoiceText.length < queue.streamedConsumedLength) {
      return;
    }

    queue.streamedVoiceText = streamedVoiceText;
    const unconsumedText = streamedVoiceText.slice(queue.streamedConsumedLength);
    const { segments, rest } = takeCompleteVoiceSegments(unconsumedText);

    if (segments.length) {
      const consumedLength = unconsumedText.length - rest.length;
      queue.streamedConsumedLength += consumedLength;
      enqueueVoiceReplySegments(segments, requestId);
    }

    if (options?.flushRest) {
      const restText = streamedVoiceText.slice(queue.streamedConsumedLength).trim();

      if (restText) {
        queue.streamedConsumedLength = streamedVoiceText.length;
        enqueueVoiceReplySegments([restText], requestId);
      }
    }
  };

  const playAudioUrl = async (audioUrl: string, mimeType: string, requestId: number): Promise<boolean> => {
    if (requestId !== voiceReplyRequestIdRef.current) {
      window.URL.revokeObjectURL(audioUrl);
      voiceReplyPendingUrlsRef.current.delete(audioUrl);
      return false;
    }

    voiceReplyPendingUrlsRef.current.delete(audioUrl);
    const audio = new Audio(audioUrl);
    voiceReplyAudioRef.current = audio;
    voiceReplyUrlRef.current = audioUrl;

    return new Promise((resolve) => {
      const cleanup = (): void => {
        if (voiceReplyAudioRef.current === audio) {
          voiceReplyAudioRef.current = null;
        }

        window.URL.revokeObjectURL(audioUrl);

        if (voiceReplyUrlRef.current === audioUrl) {
          voiceReplyUrlRef.current = undefined;
        }
      };

      audio.addEventListener(
        "ended",
        () => {
          cleanup();
          resolve(true);
        },
        { once: true }
      );

      audio.addEventListener(
        "error",
        () => {
          cleanup();
          resolve(true);
        },
        { once: true }
      );

      void audio.play().catch(() => {
        cleanup();
        showVoiceMessage("语音已经生成，但当前环境阻止了自动播放。", "error");
        releaseVoiceReplySubtitle(requestId);
        releaseVoiceReplyExpression(requestId);
        resolve(false);
      });
    });
  };

  const synthesizeVoiceSegment = async (
    segment: string,
    requestId: number
  ): Promise<VoiceReplyAudio | undefined> => {
    for (let attempt = 1; attempt <= voiceReplySegmentMaxAttempts; attempt += 1) {
      if (requestId !== voiceReplyRequestIdRef.current) {
        return undefined;
      }

      const response = await window.desktopPet?.textToSpeech.speak({
        petId: petRef.current.petId,
        text: segment
      });

      if (requestId !== voiceReplyRequestIdRef.current) {
        return undefined;
      }

      if (response?.ok && response.audioBase64) {
        const mimeType = response.mimeType ?? "audio/wav";
        const audioUrl = window.URL.createObjectURL(base64ToBlob(response.audioBase64, mimeType));
        voiceReplyPendingUrlsRef.current.add(audioUrl);

        return {
          audioUrl,
          mimeType
        };
      }

      if (attempt < voiceReplySegmentMaxAttempts) {
        await waitForVoiceRetry(voiceReplySegmentRetryBaseMs * attempt);
      }
    }

    return undefined;
  };

  useEffect(() => {
    void window.desktopPet?.petWindow.getState().then(setState);
    return window.desktopPet?.petWindow.onStateChanged(setState);
  }, []);

  useEffect(() => {
    return window.desktopPet?.speechStream.onResult((event) => {
      if (event.sessionId !== streamSessionIdRef.current) {
        return;
      }

      if (!event.ok) {
        if (streamStoppingRef.current) {
          return;
        }

        voiceInputStateRef.current = "idle";
        setVoiceInputState("idle");
        setVoiceWaveformLevels(initialVoiceWaveformLevels);
        streamSessionIdRef.current = undefined;
        triggerExpression("panic", "normal", 2200);
        showVoiceMessage(event.message ?? "实时语音识别失败。", "error");
        return;
      }

      if (!event.text) {
        return;
      }

      if (event.sliceType === 2 || event.final) {
        streamFinalSegmentsRef.current.set(event.index ?? streamFinalSegmentsRef.current.size, event.text);
        streamPartialTextRef.current = "";
      } else {
        streamPartialTextRef.current = event.text;
      }

      const finalText = Array.from(streamFinalSegmentsRef.current.entries())
        .sort(([leftIndex], [rightIndex]) => leftIndex - rightIndex)
        .map(([, text]) => text)
        .join("");
      const recognizedText = `${finalText}${streamPartialTextRef.current}`.trim();
      setRecognizedVoiceDraft(recognizedText);

      if (streamStoppingRef.current && event.final) {
        streamSessionIdRef.current = undefined;
        streamStoppingRef.current = false;

        if (voiceAutoSendPendingRef.current) {
          voiceAutoSendPendingRef.current = false;
          window.clearTimeout(voiceAutoSendTimerRef.current);
          sendRecognizedVoiceTextRef.current();
        }
      }
    });
  }, []);

  useEffect(() => {
    return window.desktopPet?.petWindow.onCloseEffect(() => {
      subtitle.hide();
      setClosingEffect(true);
      setChatOpen(false);
      setRadialMenuOpen(false);
      voiceAutoSendPendingRef.current = false;
      window.clearTimeout(voiceAutoSendTimerRef.current);
      window.clearTimeout(voiceRestartTimerRef.current);
      if (voiceInputStateRef.current === "recording") {
        voiceInputStateRef.current = "idle";
        setVoiceInputState("idle");
        audioProcessorRef.current?.disconnect();
        audioSourceRef.current?.disconnect();
        audioStreamRef.current?.getTracks().forEach((track) => track.stop());
        audioProcessorRef.current = null;
        audioSourceRef.current = null;
        audioStreamRef.current = null;
        void audioContextRef.current?.close();
        audioContextRef.current = null;
      }
      setExplodeEventId(Date.now());
    });
  }, [subtitle]);

  const triggerExpression = (
    expression: PetExpressionKey,
    priority: PetExpressionEvent["priority"] = "normal",
    durationMs?: number,
    hold?: boolean
  ): void => {
    setExpressionEvent({
      id: Date.now(),
      expression,
      priority,
      durationMs,
      hold
    });
  };

  const getMotionSourceIndex = (source: PetExpressionSourceItem): number => {
    const runtimeName = source.runtimeName;

    if (runtimeName === undefined || source.sourceKind !== "motion") {
      return 0;
    }

    const sameGroupSources = (petDefinition?.expressionSources ?? []).filter(
      (item) => item.sourceKind === "motion" && String(item.runtimeName) === String(runtimeName)
    );
    const index = sameGroupSources.findIndex(
      (item) => item.sourceFileName === source.sourceFileName
    );

    return Math.max(index, 0);
  };

  const pickRandomExpressionSource = (): PetExpressionSourceItem | undefined => {
    const scope: PetExpressionRandomScope = petDefinition?.expressionRandomScope ?? "all";
    const sources = (petDefinition?.expressionSources ?? []).filter((source) => {
      const hasRuntimeName =
        source.runtimeName !== undefined &&
        (typeof source.runtimeName === "number" || source.runtimeName.trim().length > 0);

      if (!hasRuntimeName) {
        return false;
      }

      return scope === "all" || source.sourceKind === scope;
    });

    if (!sources.length) {
      return undefined;
    }

    return sources[Math.floor(Math.random() * sources.length)] ?? sources[0];
  };

  const showAiReplySubtitle = (
    text: string,
    options?: { holdMs?: number; mode?: "instant" | "typewriter" }
  ): void => {
    const currentPetDefinition = petDefinitionRef.current;

    subtitle.show({
      text,
      mode: options?.mode ?? "instant",
      holdMs: options?.holdMs,
      tone: currentPetDefinition?.subtitleStyle?.tone,
      maxWidth: currentPetDefinition?.subtitleStyle?.maxWidth
    });
  };

  const triggerExpressionSource = (
    source: PetExpressionSourceItem,
    priority: PetExpressionEvent["priority"] = "normal",
    durationMs?: number
  ): void => {
    const runtimeName = source.runtimeName ?? source.sourceFileName;

    if (runtimeName === undefined) {
      return;
    }

    setExpressionEvent({
      id: Date.now(),
      source: {
        sourceKind: source.sourceKind,
        runtimeName,
        index: source.sourceKind === "motion" ? getMotionSourceIndex(source) : undefined
      },
      priority,
      durationMs
    });
  };

  const resetIdleTimer = (): void => {
    window.clearTimeout(idleTimerRef.current);
    idleTimerRef.current = window.setTimeout(() => {
      triggerEventExpression("idle", "low", "offline");
      speakLine("idle", "我还在这里，别担心。");
    }, 22000);
  };

  useEffect(() => {
    resetIdleTimer();

    return () => {
      voiceAutoSendPendingRef.current = false;
      window.clearTimeout(voiceAutoSendTimerRef.current);
      window.clearTimeout(voiceRestartTimerRef.current);
      window.clearTimeout(idleTimerRef.current);
      audioProcessorRef.current?.disconnect();
      audioSourceRef.current?.disconnect();
      void audioContextRef.current?.close();
      audioStreamRef.current?.getTracks().forEach((track) => track.stop());
      if (streamSessionIdRef.current) {
        window.desktopPet?.speechStream.stop({ sessionId: streamSessionIdRef.current });
      }
      window.clearTimeout(voiceAutoSendTimerRef.current);
      window.clearTimeout(voiceRestartTimerRef.current);
    };
  }, []);

  useEffect(() => {
    if (state.clickThrough) {
      setRadialMenuOpen(true);
    }
  }, [state.clickThrough]);

  const scrollChatToLatest = (behavior: ScrollBehavior = "smooth"): void => {
    const chatMessages = chatMessagesRef.current;

    if (!chatMessages) {
      return;
    }

    chatMessages.scrollTo({
      top: chatMessages.scrollHeight,
      behavior
    });
  };

  useLayoutEffect(() => {
    if (!chatOpen || chatCollapsed) {
      return;
    }

    scrollChatToLatest("auto");
  }, [chatCollapsed, chatOpen]);

  useEffect(() => {
    if (!chatOpen || chatCollapsed) {
      return;
    }

    scrollChatToLatest("smooth");
  }, [chatCollapsed, chatOpen, messages]);

  useEffect(() => {
    if (!chatOpen) {
      return;
    }

    const panelWidth = 252;
    const panelHeight = chatCollapsed ? 112 : 214;
    const maxLeft = Math.max(window.innerWidth - panelWidth - 8, 8);
    const maxBottom = Math.max(window.innerHeight - panelHeight - 72, 8);

    setChatPanelPosition((position) => ({
      left: Math.min(Math.max(position.left, 8), maxLeft),
      bottom: Math.min(Math.max(position.bottom, 8), maxBottom)
    }));
  }, [chatCollapsed, chatOpen]);

  useEffect(() => {
    if (!radialMenuOpen) {
      return;
    }

    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        setRadialMenuOpen(false);
      }
    };

    window.addEventListener("keydown", handleKeyDown);

    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [radialMenuOpen]);

  useEffect(() => {
    if (!state.clickThrough) {
      clickThroughButtonInteractiveRef.current = false;
      void window.desktopPet?.petWindow.setClickThroughControlInteractive(false);
      return;
    }

    const handleMouseMove = (event: MouseEvent): void => {
      const clickThroughButton = clickThroughButtonRef.current;

      if (!clickThroughButton) {
        return;
      }

      const bounds = clickThroughButton.getBoundingClientRect();
      const isInsideClickThroughButton =
        event.clientX >= bounds.left &&
        event.clientX <= bounds.right &&
        event.clientY >= bounds.top &&
        event.clientY <= bounds.bottom;

      if (isInsideClickThroughButton === clickThroughButtonInteractiveRef.current) {
        return;
      }

      clickThroughButtonInteractiveRef.current = isInsideClickThroughButton;
      void window.desktopPet?.petWindow.setClickThroughControlInteractive(
        isInsideClickThroughButton
      );
    };

    window.addEventListener("mousemove", handleMouseMove);

    return () => {
      window.removeEventListener("mousemove", handleMouseMove);
      clickThroughButtonInteractiveRef.current = false;
      void window.desktopPet?.petWindow.setClickThroughControlInteractive(false);
    };
  }, [state.clickThrough]);

  const toggleClickThrough = async (): Promise<void> => {
    const nextState = await window.desktopPet?.petWindow.toggleClickThrough();

    if (nextState) {
      setState(nextState);
      triggerEventExpression(
        nextState.clickThrough ? "clickThroughOn" : "clickThroughOff",
        "normal",
        nextState.clickThrough ? "ready" : "happy"
      );
      speakLine(
        nextState.clickThrough ? "clickThroughOn" : "clickThroughOff",
        nextState.clickThrough ? "我先把自己挪到不打扰你的状态。" : "我又可以和你互动啦。"
      );
      resetIdleTimer();
    }

    setRadialMenuOpen(true);
  };

  const toggleTouch = (): void => {
    setTouchEnabled((value) => !value);
  };

  const showRadialMenu = (event: React.MouseEvent<HTMLDivElement>): void => {
    event.preventDefault();

    if (closingEffect) {
      return;
    }

    const menuSize = 198;
    const edgePadding = 100;
    const x = Math.min(Math.max(event.clientX, edgePadding), window.innerWidth - edgePadding);
    const y = Math.min(Math.max(event.clientY, edgePadding), window.innerHeight - edgePadding);

    setRadialMenuPosition({
      x: Number.isFinite(x) ? x : menuSize,
      y: Number.isFinite(y) ? y : menuSize
    });
    setRadialMenuOpen(true);
  };

  const closeRadialMenu = (): void => {
    setRadialMenuOpen(false);
  };

  const toggleChat = (): void => {
    setChatOpen((value) => {
      const nextValue = !value;
      triggerEventExpression(nextValue ? "chatOpen" : "chatClose", "normal", nextValue ? "panic" : "crying");
      speakLine(
        nextValue ? "chatOpen" : "chatClose",
        nextValue ? "嗯，我在听。" : "好，我先安静陪着你。"
      );
      resetIdleTimer();
      return nextValue;
    });
  };

  const closeWindow = async (): Promise<void> => {
    const playCloseEffect = hasConfiguredEvent("closing");

    if (playCloseEffect) {
      triggerEventExpression("closing", "normal", "crying");
      speakLine("closing", "那我先回去休息啦。", {
        mode: "instant"
      });
      await new Promise((resolve) => window.setTimeout(resolve, 1200));
      subtitle.hide();
    }

    const nextState = await window.desktopPet?.petWindow.close({
      playEffect: playCloseEffect
    });

    if (nextState) {
      setState(nextState);
    }
  };

  const flushPetWindowDrag = (): void => {
    petWindowDragFrameRef.current = undefined;
    const point = pendingPetWindowDragPointRef.current;
    pendingPetWindowDragPointRef.current = undefined;

    if (!point || !draggingRef.current || state.clickThrough) {
      return;
    }

    void window.desktopPet?.petWindow.moveDrag(point);
  };

  const queuePetWindowDrag = (point: PetWindowDragPoint): void => {
    pendingPetWindowDragPointRef.current = point;

    if (petWindowDragFrameRef.current !== undefined) {
      return;
    }

    petWindowDragFrameRef.current = window.requestAnimationFrame(flushPetWindowDrag);
  };

  const clearQueuedPetWindowDrag = (): void => {
    pendingPetWindowDragPointRef.current = undefined;

    if (petWindowDragFrameRef.current === undefined) {
      return;
    }

    window.cancelAnimationFrame(petWindowDragFrameRef.current);
    petWindowDragFrameRef.current = undefined;
  };

  const startDrag = (event: React.PointerEvent<HTMLDivElement>): void => {
    if (state.clickThrough) {
      return;
    }

    draggingRef.current = true;
    modelDragMovedRef.current = false;
    modelDragStartPointRef.current = undefined;
    event.currentTarget.setPointerCapture(event.pointerId);
    void window.desktopPet?.petWindow.startDrag({
      x: event.screenX,
      y: event.screenY
    });
  };

  const moveDrag = (event: React.PointerEvent<HTMLDivElement>): void => {
    if (!draggingRef.current || state.clickThrough) {
      return;
    }

    queuePetWindowDrag({
      x: event.screenX,
      y: event.screenY
    });
  };

  const endDrag = (event: React.PointerEvent<HTMLDivElement>): void => {
    if (!draggingRef.current) {
      return;
    }

    draggingRef.current = false;
    modelDragStartPointRef.current = undefined;
    clearQueuedPetWindowDrag();
    event.currentTarget.releasePointerCapture(event.pointerId);
    void window.desktopPet?.petWindow.endDrag();
  };

  const startModelDragCandidate = (event: React.PointerEvent<HTMLDivElement>): void => {
    if (event.button !== 0 || state.clickThrough || !touchEnabled) {
      return;
    }

    if (!(event.target instanceof Element) || !event.target.closest(".live2dHost")) {
      return;
    }

    modelDragMovedRef.current = false;
    modelDragLineShownRef.current = false;
    modelDragStartPointRef.current = {
      pointerId: event.pointerId,
      screenX: event.screenX,
      screenY: event.screenY
    };
  };

  const moveModelDragCandidate = (event: React.PointerEvent<HTMLDivElement>): void => {
    if (state.clickThrough || !touchEnabled) {
      return;
    }

    const startPoint = modelDragStartPointRef.current;

    if (!startPoint || startPoint.pointerId !== event.pointerId) {
      return;
    }

    const deltaX = event.screenX - startPoint.screenX;
    const deltaY = event.screenY - startPoint.screenY;

    if (!draggingRef.current && Math.hypot(deltaX, deltaY) <= 4) {
      return;
    }

    if (!draggingRef.current) {
      draggingRef.current = true;
      modelDragMovedRef.current = true;
      modelDragLineShownRef.current = false;
      event.currentTarget.setPointerCapture(event.pointerId);
      void window.desktopPet?.petWindow.startDrag({
        x: startPoint.screenX,
        y: startPoint.screenY
      });
    }

    if (!modelDragLineShownRef.current && Math.hypot(deltaX, deltaY) >= 36) {
      modelDragLineShownRef.current = true;
      triggerEventExpression("drag", "normal", "focus");
      speakLine("drag", "慢一点，我跟着你走。");
      resetIdleTimer();
    }

    queuePetWindowDrag({
      x: event.screenX,
      y: event.screenY
    });
  };

  const handleModelTouchHit = (): void => {
    if (!touchEnabled || state.clickThrough) {
      return;
    }

    if (modelDragMovedRef.current) {
      modelDragMovedRef.current = false;
      return;
    }

    const now = window.performance.now();

    if (now - lastModelTouchHitAtRef.current < 260) {
      return;
    }

    lastModelTouchHitAtRef.current = now;

    if (now - rapidModelClickWindowStartedAtRef.current > 1400) {
      rapidModelClickWindowStartedAtRef.current = now;
      rapidModelClickCountRef.current = 0;
    }

    rapidModelClickCountRef.current += 1;

    if (rapidModelClickCountRef.current >= 3) {
      rapidModelClickCountRef.current = 0;
      rapidModelClickWindowStartedAtRef.current = now;
      triggerEventExpression("rapidClick", "high", "melt");
      speakLine("rapidClick", "呜哇，点得有点快啦。");
      resetIdleTimer();
      return;
    }

    const clickExpression = getEventSettings("click").expression;
    triggerEventExpression("click", clickExpression === "impact" ? "high" : "normal", "shy");
    speakLine("click", "嗯？叫我吗？");
    resetIdleTimer();
  };

  const endModelDragCandidate = (event: React.PointerEvent<HTMLDivElement>): void => {
    modelDragStartPointRef.current = undefined;
    modelDragLineShownRef.current = false;

    if (!draggingRef.current) {
      return;
    }

    draggingRef.current = false;
    clearQueuedPetWindowDrag();

    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }

    void window.desktopPet?.petWindow.endDrag();
  };

  const startChatPanelDrag = (event: React.PointerEvent<HTMLDivElement>): void => {
    if (state.clickThrough) {
      return;
    }

    chatPanelDragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      left: chatPanelPosition.left,
      bottom: chatPanelPosition.bottom
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const moveChatPanelDrag = (event: React.PointerEvent<HTMLDivElement>): void => {
    const dragState = chatPanelDragRef.current;

    if (!dragState || dragState.pointerId !== event.pointerId) {
      return;
    }

    const nextLeft = dragState.left + event.clientX - dragState.startX;
    const nextBottom = dragState.bottom - (event.clientY - dragState.startY);

    const panelWidth = 252;
    const panelHeight = chatCollapsed ? 112 : 214;
    const maxLeft = Math.max(window.innerWidth - panelWidth - 8, 8);
    const maxBottom = Math.max(window.innerHeight - panelHeight - 72, 8);

    setChatPanelPosition({
      left: Math.min(Math.max(nextLeft, 8), maxLeft),
      bottom: Math.min(Math.max(nextBottom, 8), maxBottom)
    });
  };

  const endChatPanelDrag = (event: React.PointerEvent<HTMLDivElement>): void => {
    if (!chatPanelDragRef.current) {
      return;
    }

    chatPanelDragRef.current = null;
    event.currentTarget.releasePointerCapture(event.pointerId);
  };

  const scheduleVoiceRestart = (isVoiceTriggered: boolean): void => {
    if (
      isVoiceTriggered &&
      speechSettingsRef.current.continuousConversationEnabled &&
      voiceInputStateRef.current === "idle" &&
      !state.clickThrough
    ) {
      window.clearTimeout(voiceRestartTimerRef.current);
      voiceRestartTimerRef.current = window.setTimeout(() => {
        if (voiceInputStateRef.current === "idle" && !state.clickThrough) {
          void startVoiceRecording({ silent: true });
        }
      }, 650);
    }
  };

  const finishAiStreamReply = async (
    pendingMessageId: number,
    rawContent: string,
    isVoiceTriggered: boolean
  ): Promise<void> => {
    const didStreamSubtitle = aiReplyStreamingSubtitleMessageIdRef.current === pendingMessageId;
    aiReplyStreamingSubtitleMessageIdRef.current = undefined;
    const parsedResponse = parseStructuredReplyFallback(rawContent);
    const replyText = parsedResponse.reply;
    const replyEmotion = parsedResponse.emotion;
    const voiceText = parsedResponse.voiceText;
    const chatLanguage = petDefinition?.personaSettings?.chatLanguage ?? "zh";
    const voiceLanguage = petDefinition?.voiceModelSettings?.language ?? "zh";
    const useReplyAsVoiceText =
      speechSettingsRef.current.voiceReplyEnabled && chatLanguage === voiceLanguage;
    const effectiveVoiceText =
      speechSettingsRef.current.voiceReplyEnabled
        ? useReplyAsVoiceText || !voiceText?.trim()
          ? replyText
          : voiceText
        : voiceText;
    const inferredExpression = inferExpressionFromAiReply(replyText);
    const randomExpressionMode = petDefinition?.expressionSelectionMode === "random";
    const randomReplySource = randomExpressionMode ? pickRandomExpressionSource() : undefined;
    const replyExpression = randomExpressionMode
      ? undefined
      : resolveMappedExpression(
          replyEmotion,
          petDefinition?.expressions,
          inferredExpression
        );
    const shouldHoldSubtitleForVoice =
      speechSettingsRef.current.voiceReplyEnabled && Boolean(effectiveVoiceText?.trim());
    const voiceSubtitleRequestId = voiceReplyRequestIdRef.current;
    const syncTextWithVoice = shouldHoldSubtitleForVoice && speechSettingsRef.current.syncTextWithVoice;

    if (syncTextWithVoice) {
      const revealState = syncVoiceRevealRef.current;

      if (revealState?.requestId === voiceSubtitleRequestId) {
        revealState.latestContent = rawContent;
      }

      enqueueFinalVoiceTextRemainder(
        effectiveVoiceText || voiceReplyQueueRef.current.streamedVoiceText || "",
        voiceSubtitleRequestId
      );

      if (voiceReplyQueueRef.current.playbackBlocked) {
        setMessages((currentMessages) =>
          currentMessages.map((message) =>
            message.id === pendingMessageId
              ? {
                  ...message,
                  text: "首句语音生成中..."
                }
              : message
          )
        );

        watchFirstQueuedVoiceForSync(voiceSubtitleRequestId);

        const firstItem = voiceReplyQueueRef.current.items[0];

        if (firstItem) {
          firstItem.audioPromise ??= synthesizeVoiceSegment(firstItem.segment, voiceSubtitleRequestId);
          await firstItem.audioPromise;
        }

        if (voiceSubtitleRequestId !== voiceReplyRequestIdRef.current) {
          return;
        }

        voiceReplyQueueRef.current.playbackBlocked = false;
        void drainVoiceReplyQueue(voiceSubtitleRequestId);
      }

      if (voiceSubtitleRequestId !== voiceReplyRequestIdRef.current) {
        return;
      }
    }

    if (syncTextWithVoice && !didStreamSubtitle) {
      showPetMessageWithTypewriter(pendingMessageId, replyText, {
        voiceText: effectiveVoiceText,
        aiRawContent: rawContent
      });
    } else {
      clearChatMessageTypewriter();
      setMessages((currentMessages) =>
        currentMessages.map((message) =>
          message.id === pendingMessageId
            ? {
                id: pendingMessageId,
                role: "pet",
                text: replyText,
                voiceText: effectiveVoiceText,
                aiRawContent: rawContent
              }
            : message
        )
      );
    }

    if (randomReplySource) {
      triggerExpressionSource(
        randomReplySource,
        "normal",
        randomReplySource.sourceKind === "expression"
          ? getTextDisplayDurationMs(replyText)
          : undefined
      );
    } else if (shouldHoldSubtitleForVoice && replyExpression) {
      pendingVoiceReplyExpressionRef.current = replyExpression;
      if (
        syncTextWithVoice ||
        voiceReplyQueueRef.current.playing ||
        voiceReplyQueueRef.current.items.length > 0
      ) {
        holdVoiceReplyExpression(voiceReplyRequestIdRef.current, pendingVoiceReplyExpressionRef.current);
        pendingVoiceReplyExpressionRef.current = voiceReplyExpressionHoldRef.current?.active
          ? undefined
          : pendingVoiceReplyExpressionRef.current;
      }
    } else if (replyExpression) {
      triggerExpression(
        replyExpression,
        "normal",
        replyExpression === "focus" ? 3600 : 2600
      );
    }

    if (shouldHoldSubtitleForVoice) {
      voiceReplySubtitleHoldRef.current = {
        requestId: voiceSubtitleRequestId,
        active: true
      };
      voiceRestartAfterReplyRef.current = isVoiceTriggered;
    }

    showAiReplySubtitle(replyText, {
      mode: didStreamSubtitle ? "instant" : "typewriter",
      holdMs: shouldHoldSubtitleForVoice ? Number.POSITIVE_INFINITY : undefined,
    });

    if (!syncTextWithVoice && shouldHoldSubtitleForVoice) {
      enqueueFinalVoiceTextRemainder(
        effectiveVoiceText || voiceReplyQueueRef.current.streamedVoiceText || "",
        voiceReplyRequestIdRef.current,
      );
    }

    if (shouldHoldSubtitleForVoice && !hasActiveVoiceReplyAudio()) {
      releaseVoiceReplySubtitle(voiceSubtitleRequestId);
    }

    if (!shouldHoldSubtitleForVoice) {
      voiceReplySubtitleHoldRef.current = undefined;
    }

    if (syncTextWithVoice) {
      syncVoiceRevealRef.current = undefined;
    }

    setSendingState(false);
    resetIdleTimer();
    if (!shouldHoldSubtitleForVoice) {
      scheduleVoiceRestart(isVoiceTriggered);
    }
  };

  const failAiStreamReply = (
    pendingMessageId: number,
    errorText: string,
    isVoiceTriggered: boolean
  ): void => {
    aiReplyStreamingSubtitleMessageIdRef.current = undefined;
    syncVoiceRevealRef.current = undefined;
    voiceReplyQueueRef.current.playbackBlocked = false;
    clearChatMessageTypewriter();
    setMessages((currentMessages) =>
      currentMessages.map((message) =>
        message.id === pendingMessageId
          ? {
              id: pendingMessageId,
              role: "pet",
              text: errorText,
              status: "error"
            }
          : message
      )
    );
    triggerExpression("panic", "high", 3600);
    subtitle.show({
      text: errorText,
      mode: "instant",
      tone: petDefinition?.subtitleStyle?.tone,
      maxWidth: petDefinition?.subtitleStyle?.maxWidth
    });
    setSendingState(false);
    resetIdleTimer();
    scheduleVoiceRestart(isVoiceTriggered);
  };

  useEffect(() => {
    return window.desktopPet?.aiChat.onStreamEvent((event) => {
      if (event.streamId !== aiChatStreamIdRef.current) {
        return;
      }

      const context = aiChatStreamContextRef.current;

      if (!context) {
        return;
      }

      if (event.type === "chunk") {
        const content = event.content ?? "";

        if (speechSettingsRef.current.syncTextWithVoice) {
          const revealState = syncVoiceRevealRef.current;

          if (revealState?.requestId === voiceReplyRequestIdRef.current) {
            revealState.latestContent = content;
          }

          enqueueStreamingVoiceText(
            getStreamingVoiceSourceText(content),
            voiceReplyRequestIdRef.current
          );
          if (!revealSynchronizedVoiceOutput(voiceReplyRequestIdRef.current) && revealState?.revealed) {
            showStreamingReplyPreview(context.pendingMessageId, content, true);
          }
          return;
        }

        enqueueStreamingVoiceText(
          extractStreamingVoiceText(content),
          voiceReplyRequestIdRef.current
        );

        if (!showStreamingReplyPreview(
          context.pendingMessageId,
          content,
          speechSettingsRef.current.voiceReplyEnabled
        )) {
          setMessages((currentMessages) =>
            currentMessages.map((message) =>
              message.id === context.pendingMessageId
                ? {
                    ...message,
                    text: aiReplyPendingText
                  }
                : message
            )
          );
        }
        return;
      }

      aiChatStreamIdRef.current = undefined;
      aiChatStreamContextRef.current = undefined;

      if (event.type === "done" && event.ok && event.content) {
        void finishAiStreamReply(context.pendingMessageId, event.content, context.isVoiceTriggered);
        return;
      }

      failAiStreamReply(
        context.pendingMessageId,
        event.message ?? "AI 暂时没有回应，请稍后再试。",
        context.isVoiceTriggered
      );
    });
  });

  const sendMessageText = async (text: string): Promise<void> => {
    const nextText = text.trim();
    const isVoiceTriggered = nextSendFromVoiceRef.current;
    nextSendFromVoiceRef.current = false;

    if (!nextText || sendingRef.current) {
      return;
    }

    stopVoiceReplyPlayback();
    clearChatMessageTypewriter();
    pendingVoiceReplyExpressionRef.current = undefined;
    aiReplyStreamingSubtitleMessageIdRef.current = undefined;
    const currentPet = petRef.current;
    const currentPetDefinition = petDefinitionRef.current;
    speechSettingsRef.current = buildSpeechSettings(
      currentPetDefinition?.voiceInputSettings,
      currentPetDefinition?.voiceModelSettings
    );
    const userMessageId = Date.now();
    const pendingMessageId = userMessageId + 1;
    const shouldSyncTextWithVoice =
      speechSettingsRef.current.voiceReplyEnabled && speechSettingsRef.current.syncTextWithVoice;

    voiceReplyQueueRef.current.playbackBlocked = shouldSyncTextWithVoice;
    syncVoiceRevealRef.current = shouldSyncTextWithVoice
      ? {
          requestId: voiceReplyRequestIdRef.current,
          pendingMessageId,
          latestContent: "",
          revealed: false,
          firstAudioSettled: false,
          watchingFirstAudio: false
        }
      : undefined;

    const aiMessages = buildAiMessages({
      petDefinition: currentPetDefinition,
      messages: messagesRef.current,
      nextUserText: nextText,
      voiceReplyEnabled: speechSettingsRef.current.voiceReplyEnabled
    });

    setSendingState(true);
    setMessages((currentMessages) => [
      ...currentMessages,
      {
        id: userMessageId,
        role: "user",
        text: nextText
      },
      {
        id: pendingMessageId,
        role: "pet",
        text: "思考中...",
        status: "thinking"
      }
    ]);
    draftRef.current = "";
    setDraft("");
    clearVoiceTypewriter();
    triggerExpression("focus", "normal", 1800);
    speakLine("userMessage", "嗯，我听见了。");
    resetIdleTimer();

    try {
      const streamResult = await window.desktopPet?.aiChat.stream({
        petId: currentPet.petId,
        messages: aiMessages
      });

      if (!streamResult?.ok || !streamResult.streamId) {
        failAiStreamReply(
          pendingMessageId,
          streamResult?.message ?? "AI 暂时没有回应，请稍后再试。",
          isVoiceTriggered
        );
        return;
      }

      aiChatStreamIdRef.current = streamResult.streamId;
      aiChatStreamContextRef.current = {
        pendingMessageId,
        isVoiceTriggered
      };
    } catch {
      failAiStreamReply(pendingMessageId, "无法连接 AI 服务，请检查网络或本地服务状态。", isVoiceTriggered);
    }
  };

  const sendMessage = async (): Promise<void> => {
    await sendMessageText(draft);
  };

  const sendRecognizedVoiceText = (): void => {
    const currentText = draftRef.current.trim();

    if (currentText) {
      nextSendFromVoiceRef.current = true;
      void sendMessageText(currentText);
    } else {
      triggerExpression("nervous", "normal", 2600);
      showVoiceMessage("我没听清，再说一次好吗？");
    }
  };
  sendRecognizedVoiceTextRef.current = sendRecognizedVoiceText;

  const showVoiceMessage = (text: string, status?: ChatMessage["status"]): void => {
    subtitle.show({
      text,
      mode: "instant",
      holdMs: status === "error" ? 3200 : undefined,
      tone: petDefinition?.subtitleStyle?.tone,
      maxWidth: petDefinition?.subtitleStyle?.maxWidth
    });
  };

  const flushStreamAudio = (force = false): void => {
    const sessionId = streamSessionIdRef.current;

    if (!sessionId || !streamPendingSamplesRef.current.length) {
      return;
    }

    const packetSampleCount = 640;
    const merged = mergeAudioChunks(streamPendingSamplesRef.current);
    let offset = 0;

    while (merged.length - offset >= packetSampleCount) {
      const packet = merged.slice(offset, offset + packetSampleCount);
      window.desktopPet?.speechStream.audio({
        sessionId,
        audio: encodePcm16(packet)
      });
      offset += packetSampleCount;
    }

    if (force && merged.length > offset) {
      window.desktopPet?.speechStream.audio({
        sessionId,
        audio: encodePcm16(merged.slice(offset))
      });
      streamPendingSamplesRef.current = [];
      return;
    }

    streamPendingSamplesRef.current = offset < merged.length ? [merged.slice(offset)] : [];
  };

  const stopVoiceRecording = (reason: VoiceStopReason): void => {
    if (voiceInputStateRef.current !== "recording") {
      return;
    }

    voiceInputStateRef.current = "transcribing";
    setVoiceInputState("transcribing");
    audioProcessorRef.current?.disconnect();
    audioSourceRef.current?.disconnect();
    audioStreamRef.current?.getTracks().forEach((track) => track.stop());
    flushStreamAudio(true);

    const audioContext = audioContextRef.current;
    const sessionId = streamSessionIdRef.current;

    audioProcessorRef.current = null;
    audioSourceRef.current = null;
    audioStreamRef.current = null;
    audioContextRef.current = null;
    audioChunksRef.current = [];
    streamPendingSamplesRef.current = [];
    voiceDetectedRef.current = false;
    voiceLastActiveAtRef.current = 0;
    voiceStartedAtRef.current = 0;
    setVoiceWaveformLevels(initialVoiceWaveformLevels);
    void audioContext?.close();

    if (sessionId) {
      streamStoppingRef.current = true;
      window.desktopPet?.speechStream.stop({ sessionId });
    }

    voiceInputStateRef.current = "idle";
    setVoiceInputState("idle");

    window.setTimeout(() => {
      if (streamSessionIdRef.current === sessionId) {
        streamSessionIdRef.current = undefined;
        streamStoppingRef.current = false;
      }
    }, 9000);

    window.clearTimeout(voiceAutoSendTimerRef.current);
    voiceAutoSendPendingRef.current = false;

    if (reason === "auto") {
      voiceAutoSendPendingRef.current = true;
      voiceAutoSendTimerRef.current = window.setTimeout(() => {
        voiceAutoSendPendingRef.current = false;
        sendRecognizedVoiceTextRef.current();
      }, voiceAutoSendFallbackMs);
    }
  };

  const startVoiceRecording = async (options?: { silent?: boolean }): Promise<void> => {
    if (!voiceInputEnabled || voiceInputState !== "idle" || state.clickThrough) {
      return;
    }

    const AudioContextConstructor =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;

    if (!window.navigator.mediaDevices?.getUserMedia || !AudioContextConstructor) {
      showVoiceMessage("当前环境不支持麦克风录音。", "error");
      return;
    }

    try {
      window.clearTimeout(voiceAutoSendTimerRef.current);
      window.clearTimeout(voiceRestartTimerRef.current);
      voiceAutoSendPendingRef.current = false;
      const streamResult = await window.desktopPet?.speechStream.start({ petId: pet.petId });

      if (!streamResult?.ok || !streamResult.sessionId) {
        showVoiceMessage(streamResult?.message ?? "实时语音识别服务没有连接成功。", "error");
        return;
      }

      const stream = await window.navigator.mediaDevices.getUserMedia({ audio: true });
      const audioContext = new AudioContextConstructor();
      const source = audioContext.createMediaStreamSource(stream);
      const processor = audioContext.createScriptProcessor(4096, 1, 1);
      speechSettingsRef.current = buildSpeechSettings(
        petDefinition?.voiceInputSettings,
        petDefinition?.voiceModelSettings
      );
      audioChunksRef.current = [];
      draftRef.current = "";
      setDraft("");
      clearVoiceTypewriter();
      streamPendingSamplesRef.current = [];
      streamFinalSegmentsRef.current = new Map();
      streamPartialTextRef.current = "";
      streamStoppingRef.current = false;
      voiceDetectedRef.current = false;
      voiceLastActiveAtRef.current = 0;
      voiceStartedAtRef.current = window.performance.now();
      streamSessionIdRef.current = streamResult.sessionId;
      audioStreamRef.current = stream;
      audioContextRef.current = audioContext;
      audioSourceRef.current = source;
      audioProcessorRef.current = processor;

      processor.onaudioprocess = (event) => {
        const targetSampleRate = 16000;
        const input = new Float32Array(event.inputBuffer.getChannelData(0));
        const resampled = resampleAudio(input, audioContext.sampleRate, targetSampleRate);
        const audioLevel = calculateAudioLevel(input);

        audioChunksRef.current.push(input);
        streamPendingSamplesRef.current.push(resampled);
        setVoiceWaveformLevels((levels) => [...levels.slice(1), audioLevel]);
        flushStreamAudio();

        const settings = speechSettingsRef.current;

        if (!settings.autoEndEnabled || streamStoppingRef.current) {
          return;
        }

        const now = window.performance.now();
        const isVoiceActive = audioLevel >= settings.volumeThreshold;

        if (isVoiceActive) {
          voiceDetectedRef.current = true;
          voiceLastActiveAtRef.current = now;
          return;
        }

        if (
          voiceDetectedRef.current &&
          now - voiceStartedAtRef.current > 900 &&
          now - voiceLastActiveAtRef.current >= settings.silenceSeconds * 1000
        ) {
          stopVoiceRecording("auto");
        }
      };

      source.connect(processor);
      processor.connect(audioContext.destination);
      setVoiceWaveformLevels(initialVoiceWaveformLevels);
      voiceInputStateRef.current = "recording";
      setVoiceInputState("recording");
      triggerExpression("happy", "normal", 1600);
      if (!options?.silent) {
        showVoiceMessage("我在听，慢慢说。");
      }
    } catch {
      voiceInputStateRef.current = "idle";
      setVoiceInputState("idle");
      setVoiceWaveformLevels(initialVoiceWaveformLevels);
      if (streamSessionIdRef.current) {
        window.desktopPet?.speechStream.stop({ sessionId: streamSessionIdRef.current });
        streamSessionIdRef.current = undefined;
      }
      showVoiceMessage("无法使用麦克风，请检查系统权限。", "error");
    }
  };

  const toggleVoiceInput = async (): Promise<void> => {
    if (voiceInputStateRef.current === "recording") {
      stopVoiceRecording("manual");
      return;
    }

    if (voiceInputStateRef.current === "idle") {
      await startVoiceRecording();
    }
  };

  return (
    <main
      className={[
        "petWindowShell",
        `theme-${uiTheme}`,
        state.clickThrough ? "clickThroughMode" : "",
        chatOpen ? "chatActive" : "",
        closingEffect ? "closingEffect" : ""
      ]
        .filter(Boolean)
        .join(" ")}
      data-pet-id={pet.petId}
      style={customThemeStyle}
    >
      <div
        className={[
          "petDragSurface",
          state.clickThrough ? "disabled" : "",
          touchEnabled ? "touchDragEnabled" : ""
        ]
          .filter(Boolean)
          .join(" ")}
        onPointerDown={touchEnabled ? startModelDragCandidate : undefined}
        onPointerMove={touchEnabled ? moveModelDragCandidate : undefined}
        onPointerUp={touchEnabled ? endModelDragCandidate : undefined}
        onPointerCancel={touchEnabled ? endModelDragCandidate : undefined}
        onContextMenu={showRadialMenu}
      >
        <Live2DCanvas
          modelPath={pet.modelPath}
          fallbackText={pet.avatar}
          autoIdle
          expressions={petDefinition?.expressions}
          expressionEffects={petDefinition?.expressionEffects}
          expressionEvent={expressionEvent}
          explodeEventId={explodeEventId}
          onModelReady={() => {
            triggerEventExpression("ready", "normal", "nervous");
            speakLine("ready", "我来啦，今天也会陪在你旁边。");
            resetIdleTimer();
          }}
          onModelError={() => {
            triggerEventExpression("modelError", "high", "panic");
            speakLine("modelError", "我好像没能正确出现，可以帮我检查一下模型文件吗？", {
              mode: "instant"
            });
          }}
          onModelHit={handleModelTouchHit}
          subscribeLookAtPoint={(callback) => {
            lookAtListenersRef.current.add(callback);

            return () => {
              lookAtListenersRef.current.delete(callback);
            };
          }}
        />
      </div>

      {!closingEffect ? <Subtitle state={subtitle.state} /> : null}

      {chatOpen && !closingEffect ? (
        <section
          className={chatCollapsed ? "petChatPanel collapsed" : "petChatPanel"}
          aria-label="对话窗口"
          style={{
            left: chatPanelPosition.left,
            bottom: chatPanelPosition.bottom
          }}
        >
          {!chatCollapsed ? (
            <>
              <div className="petChatHeader">
                <span
                  className="petChatDragZone"
                  onPointerDown={startChatPanelDrag}
                  onPointerMove={moveChatPanelDrag}
                  onPointerUp={endChatPanelDrag}
                  onPointerCancel={endChatPanelDrag}
                >
                  对话
                </span>
                <span className="petChatHeaderActions">
                  <button
                    type="button"
                    title="收起对话"
                    onPointerDown={(event) => event.stopPropagation()}
                    onClick={(event) => {
                      event.stopPropagation();
                      setChatCollapsed(true);
                    }}
                  >
                    <ChevronDown size={14} />
                  </button>
                  <button
                    type="button"
                    title="关闭对话"
                    onPointerDown={(event) => event.stopPropagation()}
                    onClick={(event) => {
                      event.stopPropagation();
                      setChatOpen(false);
                      triggerEventExpression("chatClose", "normal", "crying");
                      speakLine("chatClose", "好，我先安静陪着你。");
                    }}
                  >
                    <X size={13} />
                  </button>
                </span>
              </div>
              <div className="petChatMessages" ref={chatMessagesRef}>
                {messages.map((message) => (
                  <p
                    className={["petChatMessage", message.role, message.status]
                      .filter(Boolean)
                      .join(" ")}
                    key={message.id}
                  >
                    {message.text}
                  </p>
                ))}
              </div>
            </>
          ) : null}
          <div
            className={[
              "petChatInputRow",
              !voiceInputEnabled ? "noVoiceInput" : "",
              voiceInputState === "recording" ? "recording" : "",
              voiceInputState === "transcribing" ? "transcribing" : ""
            ]
              .filter(Boolean)
              .join(" ")}
          >
            {voiceInputEnabled ? (
              <button
                className={
                  voiceInputState === "recording" ? "petVoiceButton recording" : "petVoiceButton"
                }
                disabled={state.clickThrough || voiceInputState === "transcribing"}
                title={
                  voiceInputState === "recording"
                    ? "说完了"
                    : voiceInputState === "transcribing"
                      ? "我在整理"
                      : "对我说话"
                }
                type="button"
                onClick={() => void toggleVoiceInput()}
              >
                <Mic size={15} />
              </button>
            ) : null}
            <div className={voiceTypewriterActive ? "petVoiceInputField typewriting" : "petVoiceInputField"}>
              {voiceTypewriterActive ? (
                <span className="petVoiceTypewriterText" aria-hidden="true">
                  {voiceTypewriterText}
                  <span className="petVoiceTypewriterCaret" />
                </span>
              ) : null}
              <textarea
                ref={chatDraftInputRef}
                aria-label="输入对话内容"
                value={draft}
                disabled={state.clickThrough || voiceInputState === "transcribing"}
                rows={1}
                onChange={(event) => {
                  clearVoiceTypewriter();
                  setDraft(event.target.value);
                }}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                    event.preventDefault();
                    void sendMessage();
                  }
                }}
                placeholder={
                  voiceInputState === "recording"
                    ? "我在听…"
                    : voiceInputState === "transcribing"
                      ? "我在整理刚才的话…"
                      : "输入文字"
                }
              />
            </div>
            {voiceInputState === "recording" ? (
              <div className="petVoiceWaveform" aria-hidden="true">
                {voiceWaveformLevels.map((level, index) => (
                  <span
                    key={`${index}-${level.toFixed(3)}`}
                    style={{ "--voice-level": level } as CSSProperties}
                  />
                ))}
              </div>
            ) : null}
            <button
              className="petSendButton"
              disabled={state.clickThrough || sending}
              title="发送"
              type="button"
              onClick={() => void sendMessage()}
            >
              <Send size={15} />
            </button>
            {chatCollapsed ? (
              <button
                className="petExpandChatButton"
                type="button"
                title="展开对话"
                onPointerDown={(event) => event.stopPropagation()}
                onClick={(event) => {
                  event.stopPropagation();
                  setChatCollapsed(false);
                }}
              >
                <ChevronUp size={15} />
              </button>
            ) : null}
          </div>
        </section>
      ) : null}

      {radialMenuOpen && !closingEffect ? (
        <RadialPetMenu
          state={state}
          position={radialMenuPosition}
          variant={uiTheme}
          touchEnabled={touchEnabled}
          chatOpen={chatOpen}
          clickThroughButtonRef={clickThroughButtonRef}
          onCloseMenu={closeRadialMenu}
          onToggleClickThrough={() => void toggleClickThrough()}
          onCloseWindow={() => void closeWindow()}
          onToggleTouch={toggleTouch}
          onToggleChat={toggleChat}
        />
      ) : null}
    </main>
  );
}
