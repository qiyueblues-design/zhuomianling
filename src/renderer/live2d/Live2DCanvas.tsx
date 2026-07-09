import { useEffect, useRef, useState } from "react";
import type {
  PetExpressionEffectMap,
  PetExpressionKey,
  PetExpressionMap,
  PetExpressionSourceKind
} from "../../shared/types/pet";
import {
  CubismLive2DModel,
  type CubismMotionPriority,
  type Live2DFitMode
} from "./live2dRuntime";
import {
  Cubism2Live2DModel,
  isCubism2ModelPath
} from "./live2dRuntimeV2";

type Live2DModelRuntime = CubismLive2DModel | Cubism2Live2DModel;

interface Live2DLookAtPoint {
  clientX: number;
  clientY: number;
}

interface Live2DCanvasProps {
  modelPath: string;
  fallbackText: string;
  autoIdle?: boolean;
  expressions?: PetExpressionMap;
  expressionEffects?: PetExpressionEffectMap;
  expressionEvent?: PetExpressionEvent;
  previewAction?: Live2DPreviewAction;
  neutralPreview?: boolean;
  fitMode?: Live2DFitMode;
  explodeEventId?: number;
  onModelHit?: () => void;
  onModelReady?: () => void;
  onModelError?: () => void;
  subscribeLookAtPoint?: (callback: (point: Live2DLookAtPoint) => void) => () => void;
}

type LoadState = "idle" | "loading" | "ready" | "error";
type ExpressionPriority = "low" | "normal" | "high";

interface ForcedParameter {
  id: string;
  value: number;
  until: number;
}

interface ForcedPart {
  idOrIndex: string | number;
  opacity: number;
  until: number;
}

export interface PetExpressionEvent {
  id: number;
  expression?: PetExpressionKey;
  source?: {
    sourceKind: PetExpressionSourceKind;
    runtimeName: string | number;
    index?: number;
  };
  priority?: ExpressionPriority;
  durationMs?: number;
  hold?: boolean;
}

export type Live2DPreviewAction =
  | {
      id: number;
      kind: "reset";
    }
  | {
      id: number;
      kind: "expression";
      name: string;
    }
  | {
      id: number;
      kind: "motion";
      group: string;
      index?: number;
    };

const priorityValue: Record<ExpressionPriority, number> = {
  low: 0,
  normal: 1,
  high: 2
};

function toMotionPriority(priority: ExpressionPriority): CubismMotionPriority {
  if (priority === "high") {
    return "force";
  }

  return priority === "low" ? "idle" : "normal";
}

export function Live2DCanvas({
  modelPath,
  fallbackText,
  autoIdle = false,
  expressions,
  expressionEffects,
  expressionEvent,
  previewAction,
  neutralPreview = false,
  fitMode = "stage",
  explodeEventId,
  onModelHit,
  onModelReady,
  onModelError,
  subscribeLookAtPoint
}: Live2DCanvasProps): JSX.Element {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const canvasKey = `${modelPath}-${isCubism2ModelPath(modelPath) ? "cubism2" : "cubism4-5"}`;
  const modelRef = useRef<Live2DModelRuntime | null>(null);
  const expressionMapRef = useRef<PetExpressionMap | undefined>(expressions);
  const expressionEffectsRef = useRef<PetExpressionEffectMap | undefined>(expressionEffects);
  const onModelHitRef = useRef(onModelHit);
  const onModelReadyRef = useRef(onModelReady);
  const onModelErrorRef = useRef(onModelError);
  const subscribeLookAtPointRef = useRef(subscribeLookAtPoint);
  const lastExpressionAtRef = useRef(0);
  const activePriorityRef = useRef<ExpressionPriority>("low");
  const forcedParameterRef = useRef<ForcedParameter | undefined>();
  const forcedPartsRef = useRef<ForcedPart[]>([]);
  const resetTimerRef = useRef<number | undefined>();
  const forcedEffectFrameRef = useRef<number | undefined>();
  const loadSequenceRef = useRef(0);
  const [loadState, setLoadState] = useState<LoadState>(modelPath ? "loading" : "idle");

  useEffect(() => {
    expressionMapRef.current = expressions;
  }, [expressions]);

  useEffect(() => {
    expressionEffectsRef.current = expressionEffects;
  }, [expressionEffects]);

  useEffect(() => {
    onModelHitRef.current = onModelHit;
    onModelReadyRef.current = onModelReady;
    onModelErrorRef.current = onModelError;
  }, [onModelError, onModelHit, onModelReady]);

  useEffect(() => {
    subscribeLookAtPointRef.current = subscribeLookAtPoint;
  }, [subscribeLookAtPoint]);

  const applyForcedEffects = (): void => {
    const model = modelRef.current;

    if (!model) {
      return;
    }

    const now = window.performance.now();
    const forcedParameter = forcedParameterRef.current;

    if (forcedParameter) {
      if (now > forcedParameter.until) {
        forcedParameterRef.current = undefined;
      } else {
        model.setParameterValue(forcedParameter.id, forcedParameter.value, 1);
      }
    }

    if (forcedPartsRef.current.length) {
      forcedPartsRef.current = forcedPartsRef.current.filter((forcedPart) => forcedPart.until >= now);

      for (const forcedPart of forcedPartsRef.current) {
        model.setPartOpacity(forcedPart.idOrIndex, forcedPart.opacity);
      }
    }

    if (forcedParameterRef.current || forcedPartsRef.current.length) {
      forcedEffectFrameRef.current = window.requestAnimationFrame(applyForcedEffects);
    } else {
      forcedEffectFrameRef.current = undefined;
    }
  };

  const scheduleForcedEffects = (): void => {
    if (!forcedEffectFrameRef.current) {
      forcedEffectFrameRef.current = window.requestAnimationFrame(applyForcedEffects);
    }
  };

  const clearForcedEffects = (): void => {
    forcedParameterRef.current = undefined;
    forcedPartsRef.current = [];
    window.cancelAnimationFrame(forcedEffectFrameRef.current ?? 0);
    forcedEffectFrameRef.current = undefined;
  };

  const playExpression = (
    expression: PetExpressionKey,
    priority: ExpressionPriority = "normal",
    durationMs = 2600,
    hold = false
  ): void => {
    const model = modelRef.current;
    const expressionName = expressionMapRef.current?.[expression];

    if (!model || expressionName === undefined) {
      return;
    }

    const now = window.performance.now();
    const currentPriority = activePriorityRef.current;

    if (now - lastExpressionAtRef.current < 780 && priorityValue[priority] < priorityValue[currentPriority]) {
      return;
    }

    window.clearTimeout(resetTimerRef.current);
    lastExpressionAtRef.current = now;
    activePriorityRef.current = priority;
    const effect = expressionEffectsRef.current?.[expression];
    const effectUntil = hold ? Number.POSITIVE_INFINITY : now + durationMs;
    forcedParameterRef.current = effect?.parameters?.[0]
      ? {
          ...effect.parameters[0],
          until: effectUntil
        }
      : undefined;
    forcedPartsRef.current =
      effect?.parts?.map((part) => ({
        ...part,
        until: effectUntil
      })) ?? [];
    scheduleForcedEffects();

    void model.expression(expressionName).then((ok) => {
      if (!ok) {
        console.warn("Live2D expression did not play", {
          expression,
          expressionName
        });
      }
    });

    if (expression !== "normal" && !hold) {
      resetTimerRef.current = window.setTimeout(() => {
        activePriorityRef.current = "low";
        clearForcedEffects();
        const normalExpression = expressionMapRef.current?.normal;

        if (normalExpression !== undefined && modelRef.current) {
          void modelRef.current.expression(normalExpression);
        } else {
          modelRef.current?.resetToNeutralFace();
        }
      }, durationMs);
    }
  };

  const playExpressionSource = (
    source: NonNullable<PetExpressionEvent["source"]>,
    priority: ExpressionPriority = "normal",
    durationMs = 2600
  ): void => {
    const model = modelRef.current;

    if (!model) {
      return;
    }

    const now = window.performance.now();
    const currentPriority = activePriorityRef.current;

    if (now - lastExpressionAtRef.current < 780 && priorityValue[priority] < priorityValue[currentPriority]) {
      return;
    }

    window.clearTimeout(resetTimerRef.current);
    clearForcedEffects();
    lastExpressionAtRef.current = now;
    activePriorityRef.current = priority;

    if (source.sourceKind === "motion") {
      void model.motion(String(source.runtimeName), source.index ?? 0, toMotionPriority(priority));
      return;
    }

    void model.expression(source.runtimeName);

    if (Number.isFinite(durationMs)) {
      resetTimerRef.current = window.setTimeout(() => {
        activePriorityRef.current = "low";
        modelRef.current?.resetToNeutralFace();
      }, durationMs);
    }
  };

  useEffect(() => {
    if (!expressionEvent) {
      return;
    }

    if (expressionEvent.source) {
      playExpressionSource(
        expressionEvent.source,
        expressionEvent.priority ?? "normal",
        expressionEvent.durationMs
      );
      return;
    }

    if (expressionEvent.expression) {
      playExpression(
        expressionEvent.expression,
        expressionEvent.priority ?? "normal",
        expressionEvent.durationMs,
        expressionEvent.hold
      );
    }
  }, [expressionEvent]);

  useEffect(() => {
    const model = modelRef.current;

    if (!previewAction || !model) {
      return;
    }

    window.clearTimeout(resetTimerRef.current);
    clearForcedEffects();
    activePriorityRef.current = previewAction.kind === "reset" ? "low" : "high";

    if (previewAction.kind === "reset") {
      resetPreviewRuntime(model, true);
      return;
    }

    if (previewAction.kind === "expression") {
      void model.expression(previewAction.name);
      return;
    }

    void model.motion(previewAction.group, previewAction.index ?? 0, "force");
  }, [previewAction]);

  useEffect(() => {
    if (!explodeEventId || !modelRef.current) {
      return;
    }

    window.clearTimeout(resetTimerRef.current);
    clearForcedEffects();
    activePriorityRef.current = "high";
    void modelRef.current.motion("Tap", 0, toMotionPriority("high"));
  }, [explodeEventId]);

  useEffect(() => {
    const host = hostRef.current;
    const canvas = canvasRef.current;
    const loadSequence = loadSequenceRef.current + 1;
    loadSequenceRef.current = loadSequence;

    if (!host || !canvas || !modelPath) {
      setLoadState("idle");
      return;
    }

    let disposed = false;
    let startupFrame = 0;
    let neutralResetFrame = 0;
    let neutralResetSecondFrame = 0;
    let neutralResetThirdFrame = 0;
    let cleanupResize: (() => void) | undefined;
    let cleanupLookAt: (() => void) | undefined;
    let loadedModel: Live2DModelRuntime | undefined;
    const abortController = new AbortController();

    modelRef.current = null;
    activePriorityRef.current = "low";
    lastExpressionAtRef.current = 0;
    window.clearTimeout(resetTimerRef.current);
    clearForcedEffects();
    setLoadState("loading");

    const isCurrentLoad = (): boolean => !disposed && loadSequenceRef.current === loadSequence;

    const waitForHostSize = (): Promise<void> =>
      new Promise((resolve) => {
        const checkSize = (): void => {
          if (!isCurrentLoad() || (host.clientWidth > 0 && host.clientHeight > 0)) {
            resolve();
            return;
          }

          startupFrame = window.requestAnimationFrame(checkSize);
        };

        checkSize();
      });

    void waitForHostSize()
      .then(async () => {
        if (!isCurrentLoad()) {
          return;
        }

        const Runtime = isCubism2ModelPath(modelPath) ? Cubism2Live2DModel : CubismLive2DModel;
        const model = await Runtime.from({
          canvas,
          modelPath,
          autoIdle,
          fitMode,
          abortSignal: abortController.signal,
          onHit: () => onModelHitRef.current?.(),
          onError: (error) => {
            console.error("Live2D runtime error", error);
            if (isCurrentLoad()) {
              setLoadState("error");
              onModelErrorRef.current?.();
            }
          }
        });

        if (!isCurrentLoad()) {
          model.destroy();
          return;
        }

        loadedModel = model;
        modelRef.current = model;
        resetPreviewRuntime(model, true);

        if (neutralPreview || !autoIdle) {
          neutralResetFrame = window.requestAnimationFrame(() => {
            if (!isCurrentLoad() || modelRef.current !== model) {
              return;
            }

            resetPreviewRuntime(model, true);
            neutralResetSecondFrame = window.requestAnimationFrame(() => {
              if (!isCurrentLoad() || modelRef.current !== model) {
                return;
              }

              resetPreviewRuntime(model, true);
              neutralResetThirdFrame = window.requestAnimationFrame(() => {
                if (isCurrentLoad() && modelRef.current === model) {
                  resetPreviewRuntime(model, true);
                }
              });
            });
          });
        }

        cleanupLookAt = subscribeLookAtPointRef.current?.((point) => {
          if (isCurrentLoad() && modelRef.current === model) {
            model.lookAtClientPoint(point.clientX, point.clientY);
          }
        });
        setLoadState("ready");
        onModelReadyRef.current?.();

        let resizeFrame = 0;
        const resizeObserver = new ResizeObserver(() => {
          window.cancelAnimationFrame(resizeFrame);
          resizeFrame = window.requestAnimationFrame(() => {
            if (isCurrentLoad() && modelRef.current === model) {
              model.resize();
            }
          });
        });
        resizeObserver.observe(host);
        cleanupResize = () => {
          window.cancelAnimationFrame(resizeFrame);
          resizeObserver.disconnect();
        };
      })
      .catch((error: unknown) => {
        if (!isCurrentLoad() || abortController.signal.aborted) {
          return;
        }

        console.error("Failed to load Live2D model", error);

        setLoadState("error");
        onModelErrorRef.current?.();
      });

    return () => {
      disposed = true;
      abortController.abort();
      if (loadSequenceRef.current === loadSequence) {
        loadSequenceRef.current += 1;
      }
      cleanupLookAt?.();
      cleanupResize?.();
      if (modelRef.current === loadedModel) {
        modelRef.current = null;
      }
      loadedModel?.destroy();
      window.cancelAnimationFrame(startupFrame);
      window.cancelAnimationFrame(neutralResetFrame);
      window.cancelAnimationFrame(neutralResetSecondFrame);
      window.cancelAnimationFrame(neutralResetThirdFrame);
      window.clearTimeout(resetTimerRef.current);
      clearForcedEffects();
    };
  }, [autoIdle, fitMode, modelPath, neutralPreview]);

  const resetPreviewRuntime = (model: Live2DModelRuntime, resize = false): void => {
    window.clearTimeout(resetTimerRef.current);
    clearForcedEffects();
    activePriorityRef.current = "low";
    lastExpressionAtRef.current = 0;

    if (resize) {
      model.resize();
    }

    model.resetToNeutralFace();
  };

  return (
    <div className="live2dHost" ref={hostRef} aria-label="Live2D 模型">
      <canvas className="live2dCanvas" ref={canvasRef} key={canvasKey} />
      {loadState === "loading" ? (
        <div className="live2dLoader" aria-label="模型加载中">
          <span />
          <span />
          <span />
        </div>
      ) : null}
      {loadState === "error" ? (
        <div className="live2dError">
          <span>{fallbackText}</span>
          <strong>模型加载失败</strong>
        </div>
      ) : null}
    </div>
  );
}
