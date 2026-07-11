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
import type { PetWindowState } from "../../shared/types/window";
import { Subtitle } from "../components/Subtitle/Subtitle";
import type { PetExpressionEvent } from "../live2d/Live2DCanvas";
import { Live2DCanvas } from "../live2d/Live2DCanvas";
import { useSubtitle } from "../services/subtitle/subtitleStore";
import {
  createPetWindowStateFromPayload,
  fallbackState,
  readSearchParams
} from "./petWindowState";
import { RadialPetMenu } from "./RadialPetMenu";
import { buildSpeechSettings, defaultEventSettings } from "./speechRuntime";
import { useAiStream } from "./useAiStream";
import { useVoiceRecorder } from "./useVoiceRecorder";
import { useVoiceReplyQueue } from "./useVoiceReplyQueue";
import { useWindowDrag } from "./useWindowDrag";

const chatInputMaxVisibleHeightPx = 65;

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

const defaultClickThroughOpacity = 0.45;

function getClickThroughOpacity(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return defaultClickThroughOpacity;
  }

  return Math.min(0.8, Math.max(0.2, Math.round(value * 100) / 100));
}

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
  const clickThroughOpacity = getClickThroughOpacity(petDefinition?.uiSettings?.clickThroughOpacity);
  const customThemeStyle = getCustomThemeStyle(petDefinition?.uiSettings?.customTheme);
  const subtitle = useSubtitle();
  const clickThroughButtonRef = useRef<HTMLButtonElement>(null);
  const chatMessagesRef = useRef<HTMLDivElement>(null);
  const chatDraftInputRef = useRef<HTMLTextAreaElement>(null);
  const clickThroughButtonInteractiveRef = useRef(false);
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
    let disposed = false;
    const unsubscribe = window.desktopPet?.petConfig.onChanged((changedPet) => {
      if (disposed) {
        return;
      }

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
          if (!disposed && payload?.id === pet.petId) {
            setPet((currentPet) => createPetWindowStateFromPayload(payload, currentPet));
          }
        });
      }
    });

    return () => {
      disposed = true;
      unsubscribe?.();
    };
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
  const idleTimerRef = useRef<number | undefined>();
  const draftRef = useRef("");
  const chatOpenRef = useRef(false);
  const clickThroughRef = useRef(fallbackState.clickThrough);
  const sendRecognizedVoiceTextRef = useRef<(text: string) => void>(() => undefined);
  const scheduleVoiceRestartRef = useRef<(isVoiceTriggered: boolean) => void>(() => undefined);
  const cancelAiStreamRef = useRef<(options?: { updateUi?: boolean }) => void>(() => undefined);
  const showSynchronizedReplyRef = useRef<(messageId: number, content: string) => void>(
    () => undefined
  );
  const [state, setState] = useState<PetWindowState>(fallbackState);
  const [chatOpen, setChatOpen] = useState(false);
  const [chatCollapsed, setChatCollapsed] = useState(false);
  const [touchEnabled, setTouchEnabled] = useState(true);
  const [radialMenuOpen, setRadialMenuOpen] = useState(false);
  const [radialMenuPosition, setRadialMenuPosition] = useState({ x: 190, y: 190 });
  const [closingEffect, setClosingEffect] = useState(false);
  const [expressionEvent, setExpressionEvent] = useState<PetExpressionEvent | undefined>();
  const [explodeEventId, setExplodeEventId] = useState(0);
  const [draft, setDraft] = useState("");
  const petDefinitionRef = useRef(petDefinition);
  const speechSettings = useMemo(
    () =>
      buildSpeechSettings(
        petDefinition?.voiceInputSettings,
        petDefinition?.voiceModelSettings
      ),
    [petDefinition?.voiceInputSettings, petDefinition?.voiceModelSettings]
  );

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

  const showVoiceMessage = (text: string, status?: "thinking" | "error"): void => {
    subtitle.show({
      text,
      mode: "typewriter",
      holdMs: status === "error" ? 3200 : undefined,
      tone: petDefinitionRef.current?.subtitleStyle?.tone,
      maxWidth: petDefinitionRef.current?.subtitleStyle?.maxWidth
    });
  };

  const voiceReply = useVoiceReplyQueue({
    petId: pet.petId,
    subtitle,
    triggerExpression,
    showVoiceMessage,
    onSynchronizedReveal: (messageId, content) =>
      showSynchronizedReplyRef.current(messageId, content),
    onPlaybackDrained: (restartContinuousConversation) =>
      scheduleVoiceRestartRef.current(restartContinuousConversation)
  });
  const voiceRecorder = useVoiceRecorder({
    available:
      voiceInputEnabled && chatOpen && !state.clickThrough && !closingEffect,
    petId: pet.petId,
    settings: speechSettings,
    draftRef,
    setDraft,
    onRecognizedAutoSend: (text) => sendRecognizedVoiceTextRef.current(text),
    triggerExpression,
    showVoiceMessage
  });
  const {
    voiceInputState,
    voiceTypewriterActive,
    voiceTypewriterText,
    voiceWaveformLevels
  } = voiceRecorder;

  const setChatOpenState = (open: boolean): void => {
    chatOpenRef.current = open;
    setChatOpen(open);
  };


  useLayoutEffect(() => {
    draftRef.current = draft;
  }, [draft]);

  useLayoutEffect(() => {
    petDefinitionRef.current = petDefinition;
  }, [petDefinition]);

  useEffect(() => {
    chatOpenRef.current = chatOpen;
  }, [chatOpen]);

  useLayoutEffect(() => {
    const input = chatDraftInputRef.current;

    if (!input) {
      return;
    }

    input.style.height = "0px";
    input.style.height = `${Math.min(input.scrollHeight, chatInputMaxVisibleHeightPx)}px`;
  }, [chatCollapsed, chatOpen, draft, voiceTypewriterText]);

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
    const pickedLine = pickLine(eventName);
    const text = pickedLine?.text?.trim() || fallbackText;

    if (petDefinition?.capabilities.subtitles && !voiceReply.isSubtitleHeld()) {
      subtitle.show({
        text,
        mode: options?.mode ?? "typewriter",
        tone: petDefinition.subtitleStyle?.tone,
        maxWidth: petDefinition.subtitleStyle?.maxWidth
      });
    }

    if (pickedLine?.audioPath) {
      void voiceReply.playPresetLineAudio(pickedLine.audioPath);
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

  useEffect(() => {
    let disposed = false;
    const applyWindowState = (nextState: PetWindowState): void => {
      if (disposed) {
        return;
      }

      clickThroughRef.current = nextState.clickThrough;

      if (nextState.clickThrough || !nextState.visible) {
        voiceRecorder.cancel();
        cancelAiStreamRef.current({ updateUi: nextState.visible });
        voiceReply.stop();
      }

      setState(nextState);
    };

    void window.desktopPet?.petWindow.getState().then(applyWindowState);
    const unsubscribe = window.desktopPet?.petWindow.onStateChanged(applyWindowState);

    return () => {
      disposed = true;
      unsubscribe?.();
    };
  }, []);

  useEffect(() => {
    return window.desktopPet?.petWindow.onCloseEffect(() => {
      subtitle.hide();
      voiceRecorder.cancel();
      cancelAiStreamRef.current();
      voiceReply.stop();
      setClosingEffect(true);
      setChatOpenState(false);
      setRadialMenuOpen(false);
      setExplodeEventId(Date.now());
    });
  }, [subtitle.hide]);

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
      mode: options?.mode ?? "typewriter",
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

  const aiStream = useAiStream({
    petId: pet.petId,
    petDefinition,
    settings: speechSettings,
    draftRef,
    setDraft,
    subtitle,
    voiceReply,
    clearVoiceTypewriter: voiceRecorder.clearTypewriter,
    triggerExpression,
    triggerExpressionSource,
    pickRandomExpressionSource,
    speakLine,
    showAiReplySubtitle,
    resetIdleTimer,
    scheduleVoiceRestart: (isVoiceTriggered) =>
      scheduleVoiceRestartRef.current(isVoiceTriggered)
  });
  const { messages, sending, sendMessageText } = aiStream;
  const windowDrag = useWindowDrag({
    chatCollapsed,
    chatOpen,
    clickThrough: state.clickThrough,
    touchEnabled,
    onModelDragFeedback: () => {
      triggerEventExpression("drag", "normal", "focus");
      speakLine("drag", "慢一点，我跟着你走。");
      resetIdleTimer();
    }
  });
  const {
    chatPanelPosition,
    consumeModelDragMoved,
    endChatPanelDrag,
    endModelDragCandidate,
    moveChatPanelDrag,
    moveModelDragCandidate,
    startChatPanelDrag,
    startModelDragCandidate
  } = windowDrag;

  useLayoutEffect(() => {
    cancelAiStreamRef.current = aiStream.cancel;
    sendRecognizedVoiceTextRef.current = (text) => {
      void aiStream.sendMessageText(text, true);
    };
    scheduleVoiceRestartRef.current = voiceRecorder.scheduleRestart;
    showSynchronizedReplyRef.current = (messageId, content) => {
      aiStream.showStreamingReply(messageId, content);
    };
  }, [aiStream, voiceRecorder.scheduleRestart]);

  useEffect(() => {
    resetIdleTimer();

    return () => {
      window.clearTimeout(idleTimerRef.current);
    };
  }, []);

  useEffect(() => {
    clickThroughRef.current = state.clickThrough;

    if (state.clickThrough) {
      voiceRecorder.cancel();
      aiStream.cancel();
      voiceReply.stop();
      setChatOpenState(false);
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
    if (!clickThroughRef.current) {
      voiceRecorder.cancel();
      aiStream.cancel();
      voiceReply.stop();
    }

    const nextState = await window.desktopPet?.petWindow.toggleClickThrough();

    if (nextState) {
      clickThroughRef.current = nextState.clickThrough;

      if (nextState.clickThrough) {
        voiceRecorder.cancel();
        aiStream.cancel();
        voiceReply.stop();
        setChatOpenState(false);
      }

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

  const closeChat = (): void => {
    voiceRecorder.cancel();
    aiStream.cancel();
    voiceReply.stop();
    setChatOpenState(false);
    triggerEventExpression("chatClose", "normal", "crying");
    speakLine("chatClose", "好，我先安静陪着你。");
    resetIdleTimer();
  };

  const toggleChat = (): void => {
    if (chatOpenRef.current) {
      closeChat();
      return;
    }

    chatOpenRef.current = true;
    setChatOpenState(true);
    triggerEventExpression("chatOpen", "normal", "panic");
    speakLine("chatOpen", "嗯，我在听。");
    resetIdleTimer();
  };

  const closeWindow = async (): Promise<void> => {
    voiceRecorder.cancel();
    aiStream.cancel();
    voiceReply.stop();
    setChatOpenState(false);
    const playCloseEffect = hasConfiguredEvent("closing");

    if (playCloseEffect) {
      triggerEventExpression("closing", "normal", "crying");
      speakLine("closing", "那我先回去休息啦。");
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

  const handleModelTouchHit = (): void => {
    if (!touchEnabled || state.clickThrough) {
      return;
    }

    if (consumeModelDragMoved()) {
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

  const sendMessage = (): Promise<void> => sendMessageText(draft);
  const toggleVoiceInput = (): Promise<void> => voiceRecorder.toggle();

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
      style={{
        ...customThemeStyle,
        "--click-through-opacity": clickThroughOpacity
      } as CSSProperties}
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
            speakLine("modelError", "我好像没能正确出现，可以帮我检查一下模型文件吗？");
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
                      closeChat();
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
              voiceInputState === "connecting" ? "connecting" : "",
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
                disabled={
                  state.clickThrough ||
                  voiceInputState === "connecting" ||
                  voiceInputState === "transcribing"
                }
                title={
                  voiceInputState === "recording"
                    ? "说完了"
                    : voiceInputState === "connecting"
                      ? "正在连接麦克风和语音识别"
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
                disabled={
                  state.clickThrough ||
                  voiceInputState === "connecting" ||
                  voiceInputState === "transcribing"
                }
                rows={1}
                onChange={(event) => {
                  voiceRecorder.clearTypewriter();
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
                    : voiceInputState === "connecting"
                      ? "正在连接麦克风…"
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
