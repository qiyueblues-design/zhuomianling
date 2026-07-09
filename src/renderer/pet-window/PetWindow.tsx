import {
  ChevronDown,
  ChevronUp,
  Mic,
  Send,
  X
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties } from "react";
import type { AiChatMessage } from "../../shared/types/ai";
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
import type { PetWindowState } from "../../shared/types/window";
import { Subtitle } from "../components/Subtitle/Subtitle";
import type { PetExpressionEvent } from "../live2d/Live2DCanvas";
import { Live2DCanvas } from "../live2d/Live2DCanvas";
import { defaultSpeechFrontendSettings } from "../services/speech/speechSettings";
import { useSubtitle } from "../services/subtitle/subtitleStore";
import {
  buildExpressionPrompt,
  buildReplyPreferencePrompt,
  buildVoiceTextPrompt,
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
import { RadialPetMenu } from "./RadialPetMenu";
import { buildSpeechSettings, defaultEventSettings } from "./speechRuntime";

function hasConfiguredExpressions(expressions: unknown, descriptions: unknown): boolean {
  if (
    !expressions ||
    typeof expressions !== "object" ||
    !descriptions ||
    typeof descriptions !== "object"
  ) {
    return false;
  }

  const expressionMap = expressions as Record<string, unknown>;

  return Object.entries(descriptions).some(
    ([expression, description]) => Boolean(description) && Boolean(expressionMap[expression])
  );
}

interface ChatMessage {
  id: number;
  role: "user" | "pet";
  text: string;
  status?: "thinking" | "error";
  voiceText?: string;
  aiRawContent?: string;
}

type VoiceInputState = "idle" | "recording" | "transcribing";

interface VoiceReplyAudio {
  audioUrl: string;
  mimeType: string;
}

interface VoiceReplyQueueState {
  items: Array<{
    segment: string;
    audioPromise: Promise<VoiceReplyAudio | undefined>;
  }>;
  playing: boolean;
  streamedVoiceText: string;
  streamedConsumedLength: number;
}

const voiceWaveformBarCount = 12;
const initialVoiceWaveformLevels = Array.from({ length: voiceWaveformBarCount }, () => 0.18);

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
    streamedVoiceText: "",
    streamedConsumedLength: 0
  });
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
  const aiChatStreamIdRef = useRef<string | undefined>();
  const aiChatStreamContextRef = useRef<
    | {
        pendingMessageId: number;
        isVoiceTriggered: boolean;
      }
    | undefined
  >();
  const voiceAutoSendTimerRef = useRef<number | undefined>();
  const voiceRestartTimerRef = useRef<number | undefined>();
  const voiceRestartAfterReplyRef = useRef(false);
  const voiceDetectedRef = useRef(false);
  const voiceLastActiveAtRef = useRef(0);
  const voiceStartedAtRef = useRef(0);
  const voiceInputStateRef = useRef<VoiceInputState>("idle");
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
  const [voiceWaveformLevels, setVoiceWaveformLevels] = useState(initialVoiceWaveformLevels);
  const [messages, setMessages] = useState<ChatMessage[]>([]);

  const setSendingState = (nextSending: boolean): void => {
    sendingRef.current = nextSending;
    setSending(nextSending);
  };

  useEffect(() => {
    draftRef.current = draft;
  }, [draft]);

  useEffect(() => {
    voiceInputStateRef.current = voiceInputState;
  }, [voiceInputState]);

  useEffect(() => {
    return () => {
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
      streamedVoiceText: "",
      streamedConsumedLength: 0
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

  const drainVoiceReplyQueue = async (requestId: number): Promise<void> => {
    const queue = voiceReplyQueueRef.current;

    if (queue.playing) {
      return;
    }

    queue.playing = true;

    try {
      while (requestId === voiceReplyRequestIdRef.current && queue.items.length > 0) {
        const item = queue.items.shift();

        if (!item) {
          continue;
        }

        const audio = await item.audioPromise;

        if (!audio || requestId !== voiceReplyRequestIdRef.current) {
          return;
        }

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
    const filteredSegments = segments.map((segment) => segment.trim()).filter(Boolean);

    if (!filteredSegments.length || requestId !== voiceReplyRequestIdRef.current) {
      return;
    }

    if (pendingVoiceReplyExpressionRef.current) {
      holdVoiceReplyExpression(requestId, pendingVoiceReplyExpressionRef.current);
      pendingVoiceReplyExpressionRef.current = undefined;
    }

    voiceReplyQueueRef.current.items.push(
      ...filteredSegments.map((segment) => ({
        segment,
        audioPromise: synthesizeVoiceSegment(segment, requestId)
      }))
    );
    void drainVoiceReplyQueue(requestId);
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
          showVoiceMessage(`语音片段播放失败：${mimeType}`, "error");
          releaseVoiceReplySubtitle(requestId);
          releaseVoiceReplyExpression(requestId);
          resolve(false);
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
    const response = await window.desktopPet?.textToSpeech.speak({
      petId: pet.petId,
      text: segment
    });

    if (requestId !== voiceReplyRequestIdRef.current) {
      return undefined;
    }

    if (!response?.ok || !response.audioBase64) {
      showVoiceMessage(response?.message ?? "语音暂时没能播放。", "error");
      releaseVoiceReplySubtitle(requestId);
      releaseVoiceReplyExpression(requestId);
      return undefined;
    }

    const mimeType = response.mimeType ?? "audio/wav";
    const audioUrl = window.URL.createObjectURL(base64ToBlob(response.audioBase64, mimeType));
    voiceReplyPendingUrlsRef.current.add(audioUrl);

    return {
      audioUrl,
      mimeType
    };
  };

  const prepareVoiceReplySegments = async (
    segments: string[],
    requestId: number
  ): Promise<VoiceReplyAudio[] | undefined> => {
    const audios: VoiceReplyAudio[] = [];

    for (const segment of segments) {
      const audio = await synthesizeVoiceSegment(segment, requestId);

      if (!audio || requestId !== voiceReplyRequestIdRef.current) {
        return undefined;
      }

      audios.push(audio);
    }

    return audios;
  };

  const playPreparedVoiceReplySegments = (audios: VoiceReplyAudio[], requestId: number): void => {
    if (!audios.length || requestId !== voiceReplyRequestIdRef.current) {
      return;
    }

    voiceReplyQueueRef.current.items.push(
      ...audios.map((audio) => ({
        segment: "",
        audioPromise: Promise.resolve(audio)
      }))
    );
    void drainVoiceReplyQueue(requestId);
  };

  const playVoiceReply = async (voiceText: string, requestId = voiceReplyRequestIdRef.current): Promise<void> => {
    const text = voiceText.trim();
    speechSettingsRef.current = buildSpeechSettings(
      petDefinition?.voiceInputSettings,
      petDefinition?.voiceModelSettings
    );

    if (!text || !speechSettingsRef.current.voiceReplyEnabled) {
      releaseVoiceReplySubtitle(requestId);
      releaseVoiceReplyExpression(requestId);
      return;
    }

    enqueueVoiceReplySegments(
      speechSettingsRef.current.voiceReplyMode === "full" ? [text] : splitVoiceTextIntoSegments(text),
      requestId
    );
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
      draftRef.current = recognizedText;
      setDraft(recognizedText);

      if (streamStoppingRef.current && event.final) {
        streamSessionIdRef.current = undefined;
        streamStoppingRef.current = false;
      }
    });
  }, []);

  useEffect(() => {
    return window.desktopPet?.petWindow.onCloseEffect(() => {
      subtitle.hide();
      setClosingEffect(true);
      setChatOpen(false);
      setRadialMenuOpen(false);
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

  useEffect(() => {
    const chatMessages = chatMessagesRef.current;

    if (!chatMessages) {
      return;
    }

    chatMessages.scrollTo({
      top: chatMessages.scrollHeight,
      behavior: "smooth"
    });
  }, [messages]);

  useEffect(() => {
    if (!chatOpen) {
      return;
    }

    const panelWidth = 252;
    const panelHeight = chatCollapsed ? 46 : 214;
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

    void window.desktopPet?.petWindow.moveDrag({
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
    event.currentTarget.releasePointerCapture(event.pointerId);
    void window.desktopPet?.petWindow.endDrag();
  };

  const startModelDragCandidate = (event: React.PointerEvent<HTMLDivElement>): void => {
    if (event.button !== 0 || state.clickThrough || !touchEnabled) {
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

    void window.desktopPet?.petWindow.moveDrag({
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
      handleModelTouchHit();
      return;
    }

    draggingRef.current = false;

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
    const panelHeight = chatCollapsed ? 46 : 214;
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

  const buildAiMessages = (nextUserText: string): AiChatMessage[] => {
    const voiceOutputEnabled = Boolean(
      petDefinition?.voiceModelSettings?.enabled && petDefinition.voiceModelSettings.connected
    );
    const randomExpressionMode = petDefinition?.expressionSelectionMode === "random";
    const expressionOutputEnabled =
      !randomExpressionMode &&
      hasConfiguredExpressions(
        petDefinition?.expressions,
        petDefinition?.expressionDescriptions
      );
    const responseShape = {
      ...(voiceOutputEnabled ? { voiceText: "给语音服务朗读的文本" } : {}),
      reply: "给用户看的回复",
      ...(expressionOutputEnabled ? { emotion: "表情标签" } : {})
    };
    const responseInstructions = [
      `只输出这个 JSON 结构：${JSON.stringify(responseShape)}。`,
      buildReplyPreferencePrompt(
        petDefinition?.personaSettings?.chatLanguage,
        petDefinition?.personaSettings?.replyLength
      )
    ];

    if (voiceOutputEnabled) {
      responseInstructions.push(buildVoiceTextPrompt(petDefinition?.voiceModelSettings?.language ?? "zh"));
    }

    if (expressionOutputEnabled) {
      responseInstructions.push(
        buildExpressionPrompt(petDefinition?.expressions, petDefinition?.expressionDescriptions)
      );
    }
    const recentMessages = messages
      .filter((message) => message.status !== "thinking" && message.status !== "error")
      .slice(-12)
      .map<AiChatMessage>((message) => ({
        role: message.role === "user" ? "user" : "assistant",
        content:
          message.role === "pet"
            ? message.aiRawContent ??
              JSON.stringify({
                ...(voiceOutputEnabled && message.voiceText ? { voiceText: message.voiceText } : {}),
                reply: message.text
              })
            : message.text
      }));

    return [
      {
        role: "system",
        content: [
          petDefinition?.personaPrompt ?? "你是一个桌面宠物聊天助手。",
          "只输出 JSON，不输出 Markdown 或解释。",
          ...responseInstructions
        ].join("\n")
      },
      ...recentMessages,
      {
        role: "user",
        content: nextUserText
      }
    ];
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
    const parsedResponse = parseStructuredReplyFallback(rawContent);
    const replyText = parsedResponse.reply;
    const replyEmotion = parsedResponse.emotion;
    const voiceText = parsedResponse.voiceText;
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
      speechSettingsRef.current.voiceReplyEnabled && Boolean(voiceText?.trim());
    const voiceSubtitleRequestId = voiceReplyRequestIdRef.current;
    const syncTextWithVoice = shouldHoldSubtitleForVoice && speechSettingsRef.current.syncTextWithVoice;
    let preparedVoiceAudios: VoiceReplyAudio[] | undefined;

    if (syncTextWithVoice) {
      setMessages((currentMessages) =>
        currentMessages.map((message) =>
          message.id === pendingMessageId
            ? {
                ...message,
                text: "语音生成中..."
              }
            : message
        )
      );

      const voiceSegments =
        speechSettingsRef.current.voiceReplyMode === "full"
          ? [voiceText ?? ""]
          : splitVoiceTextIntoSegments(voiceText ?? "");
      preparedVoiceAudios = await prepareVoiceReplySegments(voiceSegments, voiceSubtitleRequestId);

      if (voiceSubtitleRequestId !== voiceReplyRequestIdRef.current) {
        return;
      }
    }

    setMessages((currentMessages) =>
      currentMessages.map((message) =>
        message.id === pendingMessageId
          ? {
              id: pendingMessageId,
              role: "pet",
              text: replyText,
              voiceText,
              aiRawContent: rawContent
            }
          : message
      )
    );

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
    }

    subtitle.show({
      text: replyText,
      mode: "typewriter",
      holdMs: shouldHoldSubtitleForVoice ? Number.POSITIVE_INFINITY : undefined,
      tone: petDefinition?.subtitleStyle?.tone,
      maxWidth: petDefinition?.subtitleStyle?.maxWidth
    });

    if (syncTextWithVoice && preparedVoiceAudios?.length) {
      voiceRestartAfterReplyRef.current = isVoiceTriggered;
      playPreparedVoiceReplySegments(preparedVoiceAudios, voiceReplyRequestIdRef.current);
    } else if (
      speechSettingsRef.current.voiceReplyMode === "sentence" &&
      voiceReplyQueueRef.current.streamedVoiceText
    ) {
      enqueueStreamingVoiceText(
        voiceReplyQueueRef.current.streamedVoiceText || voiceText || "",
        voiceReplyRequestIdRef.current,
        { flushRest: true }
      );
    } else {
      void playVoiceReply(voiceText ?? "", voiceSubtitleRequestId);
    }

    if (shouldHoldSubtitleForVoice && !hasActiveVoiceReplyAudio()) {
      releaseVoiceReplySubtitle(voiceSubtitleRequestId);
    }

    if (!shouldHoldSubtitleForVoice) {
      voiceReplySubtitleHoldRef.current = undefined;
    }

    setSendingState(false);
    resetIdleTimer();
    if (!shouldHoldSubtitleForVoice || !syncTextWithVoice || !preparedVoiceAudios?.length) {
      scheduleVoiceRestart(isVoiceTriggered);
    }
  };

  const failAiStreamReply = (
    pendingMessageId: number,
    errorText: string,
    isVoiceTriggered: boolean
  ): void => {
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
        if (speechSettingsRef.current.syncTextWithVoice) {
          return;
        }

        const preview = extractStreamingReplyPreview(event.content ?? "");

        if (speechSettingsRef.current.voiceReplyMode === "sentence") {
          enqueueStreamingVoiceText(
            extractStreamingVoiceText(event.content ?? ""),
            voiceReplyRequestIdRef.current
          );
        }

        setMessages((currentMessages) =>
          currentMessages.map((message) =>
            message.id === context.pendingMessageId
              ? {
                  ...message,
                  text: preview || "回复生成中..."
                }
              : message
          )
        );
        return;
      }

      aiChatStreamIdRef.current = undefined;
      aiChatStreamContextRef.current = undefined;

      if (event.type === "done" && event.ok && event.content) {
        if (
          speechSettingsRef.current.voiceReplyMode === "sentence" &&
          !speechSettingsRef.current.syncTextWithVoice
        ) {
          enqueueStreamingVoiceText(
            extractStreamingVoiceText(event.content),
            voiceReplyRequestIdRef.current,
            { flushRest: true }
          );
        }

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
    pendingVoiceReplyExpressionRef.current = undefined;
    speechSettingsRef.current = buildSpeechSettings(
      petDefinition?.voiceInputSettings,
      petDefinition?.voiceModelSettings
    );
    const userMessageId = Date.now();
    const pendingMessageId = userMessageId + 1;
    const aiMessages = buildAiMessages(nextText);

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
    triggerExpression("focus", "normal", 1800);
    speakLine("userMessage", "嗯，我听见了。");
    resetIdleTimer();

    try {
      const streamResult = await window.desktopPet?.aiChat.stream({
        petId: pet.petId,
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
      showVoiceMessage("没有识别到有效语音，可以再说一次。");
    }
  };

  const showVoiceMessage = (text: string, status?: ChatMessage["status"]): void => {
    setMessages((currentMessages) => [
      ...currentMessages,
      {
        id: Date.now(),
        role: "pet",
        text,
        status
      }
    ]);
    subtitle.show({
      text,
      mode: "instant",
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

  const stopVoiceRecording = (): void => {
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
    voiceAutoSendTimerRef.current = window.setTimeout(sendRecognizedVoiceText, 900);
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
          stopVoiceRecording();
        }
      };

      source.connect(processor);
      processor.connect(audioContext.destination);
      setVoiceWaveformLevels(initialVoiceWaveformLevels);
      voiceInputStateRef.current = "recording";
      setVoiceInputState("recording");
      triggerExpression("happy", "normal", 1600);
      if (!options?.silent) {
        showVoiceMessage("正在听，请开始说话。");
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
      stopVoiceRecording();
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
                    ? "结束录音"
                    : voiceInputState === "transcribing"
                      ? "整理文字中"
                      : "语音转文字"
                }
                type="button"
                onClick={() => void toggleVoiceInput()}
              >
                <Mic size={15} />
              </button>
            ) : null}
            <div className="petVoiceInputField">
              <input
                aria-label="输入对话内容"
                value={draft}
                disabled={state.clickThrough || voiceInputState === "transcribing"}
                onChange={(event) => setDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    void sendMessage();
                  }
                }}
                placeholder={
                  voiceInputState === "recording"
                    ? "我在听…"
                    : voiceInputState === "transcribing"
                      ? "整理文字中…"
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
