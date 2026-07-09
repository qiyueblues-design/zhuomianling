import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import type { PetSubtitleTone } from "../../../shared/types/pet";

export type SubtitleDisplayMode = "instant" | "typewriter";

export interface SubtitleRequest {
  text: string;
  mode?: SubtitleDisplayMode;
  holdMs?: number;
  charDelayMs?: number;
  tone?: PetSubtitleTone;
  maxWidth?: number;
}

export interface SubtitleState {
  visible: boolean;
  text: string;
  fullText: string;
  tone: PetSubtitleTone;
  maxWidth?: number;
  isTyping: boolean;
}

type Listener = () => void;

const defaultState: SubtitleState = {
  visible: false,
  text: "",
  fullText: "",
  tone: "soft",
  isTyping: false
};

function createSubtitleStore() {
  let state = defaultState;
  let typingTimer: number | undefined;
  let hideTimer: number | undefined;
  let sequence = 0;
  const listeners = new Set<Listener>();

  const emit = (): void => {
    for (const listener of listeners) {
      listener();
    }
  };

  const setState = (nextState: SubtitleState): void => {
    state = nextState;
    emit();
  };

  const clearTimers = (): void => {
    window.clearTimeout(typingTimer);
    window.clearTimeout(hideTimer);
  };

  const hide = (): void => {
    clearTimers();
    sequence += 1;
    setState({
      ...state,
      visible: false,
      text: "",
      fullText: "",
      isTyping: false
    });
  };

  const scheduleHide = (requestId: number, holdMs: number): void => {
    if (!Number.isFinite(holdMs)) {
      return;
    }

    window.clearTimeout(hideTimer);
    hideTimer = window.setTimeout(() => {
      if (requestId !== sequence) {
        return;
      }

      hide();
    }, holdMs);
  };

  const show = (request: SubtitleRequest): void => {
    clearTimers();
    sequence += 1;

    const requestId = sequence;
    const fullText = request.text.trim();
    const mode = request.mode ?? "typewriter";
    const holdMs = request.holdMs ?? Math.min(Math.max(fullText.length * 110, 2200), 6200);
    const charDelayMs = request.charDelayMs ?? 42;
    const tone = request.tone ?? "soft";

    if (!fullText) {
      hide();
      return;
    }

    if (mode === "instant") {
      setState({
        visible: true,
        text: fullText,
        fullText,
        tone,
        maxWidth: request.maxWidth,
        isTyping: false
      });
      scheduleHide(requestId, holdMs);
      return;
    }

    let nextIndex = 0;
    setState({
      visible: true,
      text: "",
      fullText,
      tone,
      maxWidth: request.maxWidth,
      isTyping: true
    });

    const typeNext = (): void => {
      if (requestId !== sequence) {
        return;
      }

      nextIndex += 1;
      const nextText = fullText.slice(0, nextIndex);

      setState({
        visible: true,
        text: nextText,
        fullText,
        tone,
        maxWidth: request.maxWidth,
        isTyping: nextIndex < fullText.length
      });

      if (nextIndex < fullText.length) {
        typingTimer = window.setTimeout(typeNext, charDelayMs);
        return;
      }

      scheduleHide(requestId, holdMs);
    };

    typingTimer = window.setTimeout(typeNext, charDelayMs);
  };

  return {
    getSnapshot: () => state,
    subscribe: (listener: Listener) => {
      listeners.add(listener);

      return () => {
        listeners.delete(listener);
      };
    },
    show,
    hide,
    hideAfter: (holdMs: number) => {
      scheduleHide(sequence, holdMs);
    }
  };
}

export const subtitleStore = createSubtitleStore();

export function useSubtitle() {
  const snapshot = useSyncExternalStore(subtitleStore.subscribe, subtitleStore.getSnapshot);
  const snapshotRef = useRef(snapshot);

  useEffect(() => {
    snapshotRef.current = snapshot;
  }, [snapshot]);

  const show = useCallback((request: SubtitleRequest) => subtitleStore.show(request), []);
  const hide = useCallback(() => subtitleStore.hide(), []);
  const hideAfter = useCallback((holdMs: number) => subtitleStore.hideAfter(holdMs), []);

  return useMemo(
    () => ({
      state: snapshot,
      current: snapshotRef,
      show,
      hide,
      hideAfter
    }),
    [hide, hideAfter, show, snapshot]
  );
}
