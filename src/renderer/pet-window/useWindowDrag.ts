import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import type { PetWindowDragPoint } from "../../shared/types/window";

interface UseWindowDragOptions {
  chatCollapsed: boolean;
  chatOpen: boolean;
  clickThrough: boolean;
  touchEnabled: boolean;
  onModelDragFeedback: () => void;
  onModelDragCompleted?: () => void;
}

interface ChatPanelPosition {
  left: number;
  bottom: number;
}

interface ChatPanelAppearanceMetrics {
  viewportWidth: number;
  panelWidth: number;
  modelCanvasLeft: number;
  modelCanvasWidth: number;
}

export interface UseWindowDragResult {
  chatPanelPosition: ChatPanelPosition;
  consumeModelDragMoved: () => boolean;
  endChatPanelDrag: (event: ReactPointerEvent<HTMLDivElement>) => void;
  endModelDragCandidate: (event: ReactPointerEvent<HTMLDivElement>) => void;
  moveChatPanelDrag: (event: ReactPointerEvent<HTMLDivElement>) => void;
  moveModelDragCandidate: (event: ReactPointerEvent<HTMLDivElement>) => void;
  startChatPanelDrag: (event: ReactPointerEvent<HTMLDivElement>) => void;
  startModelDragCandidate: (event: ReactPointerEvent<HTMLDivElement>) => void;
}

const chatPanelEdgePadding = 8;
const chatPanelWidth = 252;
const expandedChatPanelHeight = 214;
const collapsedChatPanelHeight = 112;
const modelDragThreshold = 4;
const modelDragFeedbackThreshold = 36;

export function calculateChatPanelAppearancePosition({
  viewportWidth,
  panelWidth,
  modelCanvasLeft,
  modelCanvasWidth
}: ChatPanelAppearanceMetrics): ChatPanelPosition {
  const safeViewportWidth = Math.max(0, viewportWidth);
  const safePanelWidth = Math.min(Math.max(0, panelWidth), safeViewportWidth);
  const safeModelCanvasWidth = Math.max(0, modelCanvasWidth);
  const desiredLeft = safePanelWidth <= safeModelCanvasWidth
    ? modelCanvasLeft + (safeModelCanvasWidth - safePanelWidth) / 2
    : modelCanvasLeft;
  const maxLeft = Math.max(
    safeViewportWidth - safePanelWidth - chatPanelEdgePadding,
    chatPanelEdgePadding
  );

  return {
    left: Math.min(Math.max(desiredLeft, chatPanelEdgePadding), maxLeft),
    bottom: chatPanelEdgePadding
  };
}

function getChatPanelAppearancePosition(): ChatPanelPosition {
  const chatPanel = document.querySelector<HTMLElement>(".petChatPanel");
  const modelCanvas = document.querySelector<HTMLElement>(".live2dHost");
  const panelWidth = chatPanel?.getBoundingClientRect().width
    ?? Math.min(chatPanelWidth, Math.max(0, window.innerWidth - 18));
  const modelCanvasBounds = modelCanvas?.getBoundingClientRect();

  return calculateChatPanelAppearancePosition({
    viewportWidth: window.innerWidth,
    panelWidth,
    modelCanvasLeft: modelCanvasBounds?.left ?? 0,
    modelCanvasWidth: modelCanvasBounds?.width ?? window.innerWidth
  });
}

function clampChatPanelPosition(
  position: ChatPanelPosition,
  chatCollapsed: boolean
): ChatPanelPosition {
  const panelHeight = chatCollapsed ? collapsedChatPanelHeight : expandedChatPanelHeight;
  const maxLeft = Math.max(window.innerWidth - chatPanelWidth - chatPanelEdgePadding, chatPanelEdgePadding);
  const maxBottom = Math.max(
    window.innerHeight - panelHeight - 72,
    chatPanelEdgePadding
  );

  return {
    left: Math.min(Math.max(position.left, chatPanelEdgePadding), maxLeft),
    bottom: Math.min(Math.max(position.bottom, chatPanelEdgePadding), maxBottom)
  };
}

export function useWindowDrag({
  chatCollapsed,
  chatOpen,
  clickThrough,
  touchEnabled,
  onModelDragFeedback
  ,onModelDragCompleted
}: UseWindowDragOptions): UseWindowDragResult {
  const [chatPanelPosition, setChatPanelPosition] = useState<ChatPanelPosition>({
    left: chatPanelEdgePadding,
    bottom: chatPanelEdgePadding
  });
  const draggingRef = useRef(false);
  const modelDragMovedRef = useRef(false);
  const modelDragLineShownRef = useRef(false);
  const modelDragStartPointRef = useRef<
    | {
        pointerId: number;
        screenX: number;
        screenY: number;
      }
    | undefined
  >();
  const chatPanelDragRef = useRef<
    | {
        pointerId: number;
        startX: number;
        startY: number;
        left: number;
        bottom: number;
      }
    | null
  >(null);
  const chatPanelWasDraggedRef = useRef(false);
  const chatWasOpenRef = useRef(false);
  const pendingPetWindowDragPointRef = useRef<PetWindowDragPoint | undefined>();
  const petWindowDragFrameRef = useRef<number | undefined>();
  const dragGenerationRef = useRef(0);
  const feedbackRef = useRef(onModelDragFeedback);

  useLayoutEffect(() => {
    feedbackRef.current = onModelDragFeedback;
  }, [onModelDragFeedback]);

  const clearQueuedPetWindowDrag = (): void => {
    pendingPetWindowDragPointRef.current = undefined;

    if (petWindowDragFrameRef.current === undefined) {
      return;
    }

    window.cancelAnimationFrame(petWindowDragFrameRef.current);
    petWindowDragFrameRef.current = undefined;
  };

  const finishActiveWindowDrag = (): void => {
    const wasDragging = draggingRef.current;
    draggingRef.current = false;
    modelDragStartPointRef.current = undefined;
    modelDragMovedRef.current = false;
    modelDragLineShownRef.current = false;
    chatPanelDragRef.current = null;
    clearQueuedPetWindowDrag();
    if (wasDragging) {
      dragGenerationRef.current += 1;
      void window.desktopPet?.petWindow.endDrag().catch(() => undefined);
    }
  };

  const flushPetWindowDrag = (): void => {
    petWindowDragFrameRef.current = undefined;
    const point = pendingPetWindowDragPointRef.current;
    pendingPetWindowDragPointRef.current = undefined;

    if (!point || !draggingRef.current || clickThrough) {
      return;
    }

    void window.desktopPet?.petWindow.moveDrag(point).catch(() => undefined);
  };

  const queuePetWindowDrag = (point: PetWindowDragPoint): void => {
    pendingPetWindowDragPointRef.current = point;

    if (petWindowDragFrameRef.current !== undefined) {
      return;
    }

    petWindowDragFrameRef.current = window.requestAnimationFrame(flushPetWindowDrag);
  };

  useLayoutEffect(() => {
    if (!chatOpen) {
      chatWasOpenRef.current = false;
      chatPanelWasDraggedRef.current = false;
      return;
    }

    if (!chatWasOpenRef.current) {
      chatWasOpenRef.current = true;
      chatPanelWasDraggedRef.current = false;
      setChatPanelPosition(getChatPanelAppearancePosition());
      return;
    }

    setChatPanelPosition((position) => clampChatPanelPosition(position, chatCollapsed));
  }, [chatCollapsed, chatOpen]);

  useEffect(() => {
    if (!chatOpen) {
      return;
    }

    const handleResize = (): void => {
      setChatPanelPosition((position) =>
        chatPanelWasDraggedRef.current
          ? clampChatPanelPosition(position, chatCollapsed)
          : getChatPanelAppearancePosition()
      );
    };

    window.addEventListener("resize", handleResize);

    return () => {
      window.removeEventListener("resize", handleResize);
    };
  }, [chatCollapsed, chatOpen]);

  useEffect(() => {
    if (clickThrough || !touchEnabled) {
      finishActiveWindowDrag();
    }
  }, [clickThrough, touchEnabled]);

  useEffect(() => {
    return () => {
      finishActiveWindowDrag();
    };
  }, []);

  const startModelDragCandidate = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (
      event.button !== 0 ||
      clickThrough ||
      !touchEnabled ||
      draggingRef.current ||
      modelDragStartPointRef.current
    ) {
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

  const moveModelDragCandidate = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (clickThrough || !touchEnabled) {
      return;
    }

    const startPoint = modelDragStartPointRef.current;

    if (!startPoint || startPoint.pointerId !== event.pointerId) {
      return;
    }

    const deltaX = event.screenX - startPoint.screenX;
    const deltaY = event.screenY - startPoint.screenY;
    const distance = Math.hypot(deltaX, deltaY);

    if (!draggingRef.current && distance <= modelDragThreshold) {
      return;
    }

    if (!draggingRef.current) {
      draggingRef.current = true;
      dragGenerationRef.current += 1;
      modelDragMovedRef.current = true;
      event.currentTarget.setPointerCapture(event.pointerId);
      void window.desktopPet?.petWindow
        .startDrag({ x: startPoint.screenX, y: startPoint.screenY })
        .catch(() => undefined);
    }

    if (!modelDragLineShownRef.current && distance >= modelDragFeedbackThreshold) {
      modelDragLineShownRef.current = true;
      feedbackRef.current();
    }

    queuePetWindowDrag({
      x: event.screenX,
      y: event.screenY
    });
  };

  const endModelDragCandidate = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const startPoint = modelDragStartPointRef.current;
    if (!startPoint || startPoint.pointerId !== event.pointerId) {
      return;
    }
    modelDragStartPointRef.current = undefined;
    modelDragLineShownRef.current = false;

    if (!draggingRef.current) {
      return;
    }

    const generation = dragGenerationRef.current;
    draggingRef.current = false;
    clearQueuedPetWindowDrag();

    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }

    const finalMove = window.desktopPet?.petWindow.moveDrag({
      x: event.screenX,
      y: event.screenY
    });
    void Promise.resolve(finalMove)
      .catch(() => undefined)
      .then(() => {
        if (generation !== dragGenerationRef.current) {
          return;
        }
        return window.desktopPet?.petWindow.endDrag();
      })
      .then(() => onModelDragCompleted?.())
      .catch(() => undefined);
  };

  const consumeModelDragMoved = (): boolean => {
    const moved = modelDragMovedRef.current;
    modelDragMovedRef.current = false;
    return moved;
  };

  const startChatPanelDrag = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (clickThrough || chatPanelDragRef.current) {
      return;
    }

    chatPanelWasDraggedRef.current = true;
    chatPanelDragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      left: chatPanelPosition.left,
      bottom: chatPanelPosition.bottom
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const moveChatPanelDrag = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const dragState = chatPanelDragRef.current;

    if (!dragState || dragState.pointerId !== event.pointerId) {
      return;
    }

    setChatPanelPosition(
      clampChatPanelPosition(
        {
          left: dragState.left + event.clientX - dragState.startX,
          bottom: dragState.bottom - (event.clientY - dragState.startY)
        },
        chatCollapsed
      )
    );
  };

  const endChatPanelDrag = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (chatPanelDragRef.current?.pointerId !== event.pointerId) {
      return;
    }

    chatPanelDragRef.current = null;

    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  return {
    chatPanelPosition,
    consumeModelDragMoved,
    endChatPanelDrag,
    endModelDragCandidate,
    moveChatPanelDrag,
    moveModelDragCandidate,
    startChatPanelDrag,
    startModelDragCandidate
  };
}
