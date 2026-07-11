import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { Dispatch, MutableRefObject, SetStateAction } from "react";
import type { PetExpressionKey } from "../../shared/types/pet";
import type { PetExpressionEvent } from "../live2d/Live2DCanvas";
import type { SpeechFrontendSettings } from "../services/speech/speechSettings";
import {
  calculateAudioLevel,
  encodePcm16,
  mergeAudioChunks,
  resampleAudio
} from "./audioUtils";
import {
  VoiceRecordingLifecycle,
  type VoiceRecordingPhase
} from "./voiceRecordingLifecycle";

interface UseVoiceRecorderOptions {
  available: boolean;
  petId: string;
  settings: SpeechFrontendSettings;
  draftRef: MutableRefObject<string>;
  setDraft: Dispatch<SetStateAction<string>>;
  onRecognizedAutoSend: (text: string) => void;
  triggerExpression: (
    expression: PetExpressionKey,
    priority?: PetExpressionEvent["priority"],
    durationMs?: number
  ) => void;
  showVoiceMessage: (text: string, status?: "thinking" | "error") => void;
}

export interface UseVoiceRecorderResult {
  cancel: (options?: { updateUi?: boolean }) => void;
  clearTypewriter: () => void;
  scheduleRestart: (isVoiceTriggered: boolean) => void;
  toggle: () => Promise<void>;
  voiceInputState: VoiceRecordingPhase;
  voiceTypewriterActive: boolean;
  voiceTypewriterText: string;
  voiceWaveformLevels: number[];
}

type VoiceStopReason = "auto" | "manual";

const waveformBarCount = 12;
export const initialVoiceWaveformLevels = Array.from(
  { length: waveformBarCount },
  () => 0.18
);
const autoSendFallbackMs = 400;
const manualTranscriptionFallbackMs = 1600;

function createSessionId(): string {
  return `desktop-pet-${Date.now()}-${Math.random().toString(36).slice(2, 12)}`;
}

function stopMediaStream(stream: MediaStream | null | undefined): void {
  stream?.getTracks().forEach((track) => track.stop());
}

export function useVoiceRecorder(options: UseVoiceRecorderOptions): UseVoiceRecorderResult {
  const optionsRef = useRef(options);
  const [voiceInputState, setVoiceInputState] = useState<VoiceRecordingPhase>("idle");
  const [voiceTypewriterTarget, setVoiceTypewriterTarget] = useState("");
  const [voiceTypewriterText, setVoiceTypewriterText] = useState("");
  const [voiceTypewriterActive, setVoiceTypewriterActive] = useState(false);
  const [voiceWaveformLevels, setVoiceWaveformLevels] = useState(initialVoiceWaveformLevels);
  const stateRef = useRef<VoiceRecordingPhase>("idle");
  const mountedRef = useRef(true);
  const lifecycleRef = useRef(new VoiceRecordingLifecycle());
  const audioContextRef = useRef<AudioContext | null>(null);
  const audioProcessorRef = useRef<ScriptProcessorNode | null>(null);
  const audioSourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const audioStreamRef = useRef<MediaStream | null>(null);
  const sessionIdRef = useRef<string | undefined>();
  const pendingSamplesRef = useRef<Float32Array[]>([]);
  const finalSegmentsRef = useRef<Map<number, string>>(new Map());
  const partialTextRef = useRef("");
  const stoppingRef = useRef(false);
  const autoSendPendingRef = useRef(false);
  const autoSendTimerRef = useRef<number | undefined>();
  const transcriptionFinishTimerRef = useRef<number | undefined>();
  const restartTimerRef = useRef<number | undefined>();
  const voiceDetectedRef = useRef(false);
  const lastActiveAtRef = useRef(0);
  const startedAtRef = useRef(0);
  const cancelRef = useRef<(options?: { updateUi?: boolean }) => void>(() => undefined);
  const finishTranscriptionRef = useRef<(sessionId?: string) => void>(() => undefined);
  const autoSendRef = useRef<() => void>(() => undefined);

  const setPhase = (phase: VoiceRecordingPhase, updateUi = true): void => {
    stateRef.current = phase;
    if (updateUi && mountedRef.current) {
      setVoiceInputState(phase);
    }
  };

  const clearTypewriter = (): void => {
    if (!mountedRef.current) {
      return;
    }
    setVoiceTypewriterActive(false);
    setVoiceTypewriterTarget("");
    setVoiceTypewriterText("");
  };

  const setRecognizedDraft = (text: string): void => {
    optionsRef.current.draftRef.current = text;
    optionsRef.current.setDraft(text);

    if (!text) {
      clearTypewriter();
      return;
    }

    setVoiceTypewriterTarget(text);
    setVoiceTypewriterText((currentText) => (text.startsWith(currentText) ? currentText : ""));
    setVoiceTypewriterActive(true);
  };

  const isAvailable = (): boolean =>
    Boolean(optionsRef.current.available && !document.hidden && mountedRef.current);

  const flushAudio = (force = false): void => {
    const sessionId = sessionIdRef.current;
    if (!sessionId || !pendingSamplesRef.current.length) {
      return;
    }

    const packetSampleCount = 640;
    const merged = mergeAudioChunks(pendingSamplesRef.current);
    let offset = 0;
    while (merged.length - offset >= packetSampleCount) {
      window.desktopPet?.speechStream.audio({
        sessionId,
        audio: encodePcm16(merged.slice(offset, offset + packetSampleCount))
      });
      offset += packetSampleCount;
    }

    if (force && merged.length > offset) {
      window.desktopPet?.speechStream.audio({
        sessionId,
        audio: encodePcm16(merged.slice(offset))
      });
      pendingSamplesRef.current = [];
      return;
    }

    pendingSamplesRef.current = offset < merged.length ? [merged.slice(offset)] : [];
  };

  const releaseCaptureResources = (flushPendingAudio: boolean): void => {
    const processor = audioProcessorRef.current;
    const source = audioSourceRef.current;
    const stream = audioStreamRef.current;
    const audioContext = audioContextRef.current;

    if (processor) {
      processor.onaudioprocess = null;
    }
    if (flushPendingAudio) {
      flushAudio(true);
    }
    try {
      processor?.disconnect();
    } catch {
      // Another lifecycle path may already have disconnected the node.
    }
    try {
      source?.disconnect();
    } catch {
      // Another lifecycle path may already have disconnected the node.
    }
    stopMediaStream(stream);
    audioProcessorRef.current = null;
    audioSourceRef.current = null;
    audioStreamRef.current = null;
    audioContextRef.current = null;
    pendingSamplesRef.current = [];
    voiceDetectedRef.current = false;
    lastActiveAtRef.current = 0;
    startedAtRef.current = 0;
    if (mountedRef.current) {
      setVoiceWaveformLevels(initialVoiceWaveformLevels);
    }
    if (audioContext && audioContext.state !== "closed") {
      void audioContext.close().catch(() => undefined);
    }
  };

  const finishTranscription = (expectedSessionId?: string): void => {
    const lifecycle = lifecycleRef.current;
    if (
      lifecycle.phase !== "transcribing" ||
      (expectedSessionId && sessionIdRef.current && sessionIdRef.current !== expectedSessionId)
    ) {
      return;
    }

    window.clearTimeout(transcriptionFinishTimerRef.current);
    transcriptionFinishTimerRef.current = undefined;
    sessionIdRef.current = undefined;
    stoppingRef.current = false;
    lifecycle.finishTranscribing();
    setPhase("idle");
  };

  const cancel = (cancelOptions?: { updateUi?: boolean }): void => {
    const updateUi = cancelOptions?.updateUi ?? true;
    const sessionId = sessionIdRef.current;
    lifecycleRef.current.setAvailable(false);
    lifecycleRef.current.cancel();
    autoSendPendingRef.current = false;
    window.clearTimeout(autoSendTimerRef.current);
    window.clearTimeout(transcriptionFinishTimerRef.current);
    window.clearTimeout(restartTimerRef.current);
    autoSendTimerRef.current = undefined;
    transcriptionFinishTimerRef.current = undefined;
    restartTimerRef.current = undefined;
    releaseCaptureResources(false);
    sessionIdRef.current = undefined;
    stoppingRef.current = false;
    finalSegmentsRef.current = new Map();
    partialTextRef.current = "";
    if (sessionId) {
      window.desktopPet?.speechStream.stop({ sessionId });
    }
    setPhase("idle", updateUi);
  };

  const stopRecording = (reason: VoiceStopReason): void => {
    if (!lifecycleRef.current.beginTranscribing()) {
      return;
    }

    setPhase("transcribing");
    const sessionId = sessionIdRef.current;
    releaseCaptureResources(true);
    window.clearTimeout(autoSendTimerRef.current);
    window.clearTimeout(transcriptionFinishTimerRef.current);
    window.clearTimeout(restartTimerRef.current);
    autoSendPendingRef.current = reason === "auto";

    if (sessionId) {
      stoppingRef.current = true;
      window.desktopPet?.speechStream.stop({ sessionId });
    } else {
      finishTranscription();
    }

    if (reason === "auto") {
      autoSendTimerRef.current = window.setTimeout(() => {
        if (sessionIdRef.current !== sessionId) {
          return;
        }
        autoSendPendingRef.current = false;
        finishTranscription(sessionId);
        autoSendRef.current();
      }, autoSendFallbackMs);
    } else {
      transcriptionFinishTimerRef.current = window.setTimeout(
        () => finishTranscription(sessionId),
        manualTranscriptionFallbackMs
      );
    }
  };

  const start = async (startOptions?: { silent?: boolean }): Promise<void> => {
    const AudioContextConstructor =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;

    if (!isAvailable() || !window.navigator.mediaDevices?.getUserMedia || !AudioContextConstructor) {
      if (optionsRef.current.available && !window.navigator.mediaDevices?.getUserMedia) {
        optionsRef.current.showVoiceMessage("当前环境不支持麦克风录音。", "error");
      }
      return;
    }

    const lifecycle = lifecycleRef.current;
    lifecycle.setAvailable(true);
    const startToken = lifecycle.begin();
    if (startToken === undefined) {
      return;
    }

    setPhase("connecting");
    let capturedStream: MediaStream | undefined;
    let requestedSessionId: string | undefined;
    let failureMessage = "无法使用麦克风，请检查系统权限。";

    try {
      window.clearTimeout(autoSendTimerRef.current);
      window.clearTimeout(transcriptionFinishTimerRef.current);
      window.clearTimeout(restartTimerRef.current);
      autoSendPendingRef.current = false;
      const stream = await window.navigator.mediaDevices.getUserMedia({ audio: true });
      capturedStream = stream;

      if (!lifecycle.isCurrent(startToken) || !isAvailable()) {
        stopMediaStream(stream);
        if (lifecycle.isCurrent(startToken)) {
          lifecycle.cancel();
          lifecycle.setAvailable(false);
          setPhase("idle");
        }
        return;
      }

      audioStreamRef.current = stream;
      requestedSessionId = createSessionId();
      sessionIdRef.current = requestedSessionId;
      failureMessage = "实时语音识别服务没有连接成功。";
      const streamResult = await window.desktopPet?.speechStream.start({
        petId: optionsRef.current.petId,
        sessionId: requestedSessionId
      });
      const startStillCurrent = lifecycle.isCurrent(startToken);

      if (!startStillCurrent || !isAvailable() || sessionIdRef.current !== requestedSessionId) {
        window.desktopPet?.speechStream.stop({
          sessionId: streamResult?.sessionId ?? requestedSessionId
        });
        if (audioStreamRef.current === stream) {
          releaseCaptureResources(false);
        } else {
          stopMediaStream(stream);
        }
        if (startStillCurrent) {
          lifecycle.cancel();
          lifecycle.setAvailable(false);
          setPhase("idle");
        }
        return;
      }

      if (!streamResult?.ok || !streamResult.sessionId) {
        failureMessage = streamResult?.message ?? failureMessage;
        throw new Error(failureMessage);
      }

      sessionIdRef.current = streamResult.sessionId;
      const audioContext = new AudioContextConstructor();
      audioContextRef.current = audioContext;
      const source = audioContext.createMediaStreamSource(stream);
      audioSourceRef.current = source;
      const processor = audioContext.createScriptProcessor(4096, 1, 1);
      audioProcessorRef.current = processor;
      optionsRef.current.draftRef.current = "";
      optionsRef.current.setDraft("");
      clearTypewriter();
      pendingSamplesRef.current = [];
      finalSegmentsRef.current = new Map();
      partialTextRef.current = "";
      stoppingRef.current = false;
      voiceDetectedRef.current = false;
      lastActiveAtRef.current = 0;
      startedAtRef.current = window.performance.now();
      const activeSessionId = streamResult.sessionId;

      processor.onaudioprocess = (event) => {
        if (
          !lifecycle.isCurrent(startToken) ||
          lifecycle.phase !== "recording" ||
          sessionIdRef.current !== activeSessionId
        ) {
          return;
        }

        const input = new Float32Array(event.inputBuffer.getChannelData(0));
        const resampled = resampleAudio(input, audioContext.sampleRate, 16000);
        const audioLevel = calculateAudioLevel(input);
        pendingSamplesRef.current.push(resampled);
        setVoiceWaveformLevels((levels) => [...levels.slice(1), audioLevel]);
        flushAudio();

        const settings = optionsRef.current.settings;
        if (!settings.autoEndEnabled || stoppingRef.current) {
          return;
        }

        const now = window.performance.now();
        if (audioLevel >= settings.volumeThreshold) {
          voiceDetectedRef.current = true;
          lastActiveAtRef.current = now;
        } else if (
          voiceDetectedRef.current &&
          now - startedAtRef.current > 900 &&
          now - lastActiveAtRef.current >= settings.silenceSeconds * 1000
        ) {
          stopRecording("auto");
        }
      };

      source.connect(processor);
      processor.connect(audioContext.destination);
      if (!lifecycle.markRecording(startToken) || !isAvailable()) {
        cancel();
        return;
      }

      setVoiceWaveformLevels(initialVoiceWaveformLevels);
      setPhase("recording");
      optionsRef.current.triggerExpression("happy", "normal", 1600);
      if (!startOptions?.silent) {
        optionsRef.current.showVoiceMessage("我在听，慢慢说。");
      }
    } catch {
      const attemptStillCurrent = lifecycle.isCurrent(startToken);
      if (requestedSessionId) {
        window.desktopPet?.speechStream.stop({ sessionId: requestedSessionId });
      }
      if (capturedStream && audioStreamRef.current === capturedStream) {
        releaseCaptureResources(false);
      } else {
        stopMediaStream(capturedStream);
      }
      if (sessionIdRef.current === requestedSessionId) {
        sessionIdRef.current = undefined;
      }
      if (attemptStillCurrent) {
        lifecycle.cancel();
        lifecycle.setAvailable(isAvailable());
        setPhase("idle");
        optionsRef.current.showVoiceMessage(failureMessage, "error");
      }
    }
  };

  const sendRecognizedText = (): void => {
    const text = optionsRef.current.draftRef.current.trim();
    if (text) {
      optionsRef.current.onRecognizedAutoSend(text);
    } else {
      optionsRef.current.triggerExpression("nervous", "normal", 2600);
      optionsRef.current.showVoiceMessage("我没听清，再说一次好吗？");
    }
  };

  const scheduleRestart = (isVoiceTriggered: boolean): void => {
    if (
      !isVoiceTriggered ||
      !optionsRef.current.settings.continuousConversationEnabled ||
      stateRef.current !== "idle" ||
      !isAvailable()
    ) {
      return;
    }

    window.clearTimeout(restartTimerRef.current);
    restartTimerRef.current = window.setTimeout(() => {
      if (stateRef.current === "idle" && isAvailable()) {
        void start({ silent: true });
      }
    }, 650);
  };

  useLayoutEffect(() => {
    optionsRef.current = options;
    cancelRef.current = cancel;
    finishTranscriptionRef.current = finishTranscription;
    autoSendRef.current = sendRecognizedText;
  });

  useEffect(() => {
    return window.desktopPet?.speechStream.onResult((event) => {
      if (event.sessionId !== sessionIdRef.current) {
        return;
      }

      if (!event.ok) {
        if (stoppingRef.current) {
          const shouldAutoSend = autoSendPendingRef.current;
          autoSendPendingRef.current = false;
          window.clearTimeout(autoSendTimerRef.current);
          finishTranscriptionRef.current(event.sessionId);
          if (shouldAutoSend) {
            autoSendRef.current();
          }
        } else {
          cancelRef.current();
          optionsRef.current.triggerExpression("panic", "normal", 2200);
          optionsRef.current.showVoiceMessage(event.message ?? "实时语音识别失败。", "error");
        }
        return;
      }

      if (!event.text) {
        return;
      }
      if (event.sliceType === 2 || event.final) {
        finalSegmentsRef.current.set(event.index ?? finalSegmentsRef.current.size, event.text);
        partialTextRef.current = "";
      } else {
        partialTextRef.current = event.text;
      }
      const finalText = Array.from(finalSegmentsRef.current.entries())
        .sort(([leftIndex], [rightIndex]) => leftIndex - rightIndex)
        .map(([, text]) => text)
        .join("");
      setRecognizedDraft(`${finalText}${partialTextRef.current}`.trim());

      if (stoppingRef.current && event.final) {
        const shouldAutoSend = autoSendPendingRef.current;
        autoSendPendingRef.current = false;
        window.clearTimeout(autoSendTimerRef.current);
        finishTranscriptionRef.current(event.sessionId);
        if (shouldAutoSend) {
          autoSendRef.current();
        }
      }
    });
  }, []);

  useEffect(() => {
    lifecycleRef.current.setAvailable(options.available);
    if (!options.available) {
      cancelRef.current();
    }
  }, [options.available]);

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
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      cancelRef.current({ updateUi: false });
    };
  }, []);

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
      const timer = window.setTimeout(() => setVoiceTypewriterActive(false), 520);
      return () => window.clearTimeout(timer);
    }
    const timer = window.setTimeout(() => {
      setVoiceTypewriterText((currentText) =>
        voiceTypewriterTarget.startsWith(currentText)
          ? voiceTypewriterTarget.slice(0, Math.min(currentText.length + 1, voiceTypewriterTarget.length))
          : voiceTypewriterTarget.slice(0, 1)
      );
    }, 28);
    return () => window.clearTimeout(timer);
  }, [voiceInputState, voiceTypewriterActive, voiceTypewriterTarget, voiceTypewriterText]);

  const toggle = async (): Promise<void> => {
    if (stateRef.current === "recording") {
      stopRecording("manual");
    } else if (stateRef.current === "idle") {
      await start();
    }
  };

  return {
    cancel,
    clearTypewriter,
    scheduleRestart,
    toggle,
    voiceInputState,
    voiceTypewriterActive,
    voiceTypewriterText,
    voiceWaveformLevels
  };
}
