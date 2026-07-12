import { Play, Plus, Smile, X } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type {
  LocalPetEventSettingsDraft,
  LocalPetEventSettingsItem,
  LocalPetSaveResult,
  PetDefinition,
  PetExpressionSourceItem,
  PetLine,
  PetLineEvent
} from "../../../shared/types/pet";
import { AppleSelect, PanelSaveActions } from "./EditorShared";
import { eventLabels } from "./editorNavigation";
import {
  createEventSettingsDraft,
  getPetLineText,
  normalizeEventSettingsDraft
} from "./petEditorDrafts";

const clearEventExpressionValue = "__clear_event_expression__";

function getSourceValue(source: PetExpressionSourceItem): string {
  return [
    source.sourceKind,
    source.sourceFileName,
    source.runtimeName ?? ""
  ].join("::");
}

function getSourceLabel(source: PetExpressionSourceItem): string {
  const runtimeName = source.runtimeName !== undefined ? String(source.runtimeName) : "";

  return runtimeName && runtimeName !== source.sourceFileName
    ? `${source.sourceFileName} · ${runtimeName}`
    : source.sourceFileName;
}

function updatePetLineAt(previousLines: PetLine[], index: number, nextText: string): PetLine[] {
  const nextLines = [...previousLines];
  const previousLine = nextLines[index];
  const text = nextText.trim();

  if (!text) {
    nextLines[index] = "";
    return nextLines;
  }

  nextLines[index] =
    previousLine && typeof previousLine !== "string"
      ? {
          ...previousLine,
          text
        }
      : text;

  return nextLines;
}

function removePetLineAt(previousLines: PetLine[], index: number): PetLine[] {
  return previousLines.filter((_, lineIndex) => lineIndex !== index);
}

function AutoGrowEventLineTextarea({
  value,
  onChange
}: {
  value: string;
  onChange: (value: string) => void;
}): JSX.Element {
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useLayoutEffect(() => {
    const textarea = textareaRef.current;

    if (!textarea) {
      return;
    }

    textarea.style.height = "0px";
    textarea.style.height = `${textarea.scrollHeight}px`;
  }, [value]);

  return (
    <textarea
      value={value}
      placeholder="触发事件时随机选择一条"
      ref={textareaRef}
      rows={1}
      onChange={(event) => onChange(event.target.value)}
    />
  );
}

export function EventLinesPanel({
  pet,
  onSavedPet,
  onDirtyChange
}: {
  pet: PetDefinition;
  onSavedPet?: (pet: PetDefinition) => void;
  onDirtyChange: (dirty: boolean) => void;
}): JSX.Element {
  const [draft, setDraft] = useState<LocalPetEventSettingsDraft>(() => createEventSettingsDraft(pet));
  const [savedDraft, setSavedDraft] = useState<LocalPetEventSettingsDraft>(() => createEventSettingsDraft(pet));
  const [saving, setSaving] = useState(false);
  const [result, setResult] = useState<LocalPetSaveResult | undefined>();
  const [previewMessage, setPreviewMessage] = useState<string>();
  const [activePreviewEvent, setActivePreviewEvent] = useState<PetLineEvent>();
  const activePreviewIdRef = useRef<number | undefined>();
  const expressionSources = pet.expressionSources ?? [];
  const faceSources = expressionSources.filter((source) => source.sourceKind === "expression");
  const motionSources = expressionSources.filter((source) => source.sourceKind === "motion");
  const hasExpressionSources = expressionSources.length > 0;
  const eventColumns = [
    eventLabels.filter((_, index) => index % 2 === 0),
    eventLabels.filter((_, index) => index % 2 === 1)
  ];

  useEffect(() => {
    const nextDraft = createEventSettingsDraft(pet);

    setDraft(nextDraft);
    setSavedDraft(nextDraft);
    setResult(undefined);
    setPreviewMessage(undefined);
    onDirtyChange(false);
  }, [onDirtyChange, pet]);

  useEffect(() => {
    return window.desktopPet?.petWindow.onSourcePreviewFinished(({ id }) => {
      if (activePreviewIdRef.current === id) {
        activePreviewIdRef.current = undefined;
        setActivePreviewEvent(undefined);
      }
    });
  }, []);

  const markEventDirty = (nextDraft: LocalPetEventSettingsDraft): void => {
    onDirtyChange(normalizeEventSettingsDraft(nextDraft) !== normalizeEventSettingsDraft(savedDraft));
  };

  const updateEvent = (
    eventName: PetLineEvent,
    patch: Partial<Omit<LocalPetEventSettingsItem, "event">>
  ): void => {
    setResult(undefined);
    setDraft((currentDraft) => {
      const nextDraft = {
        ...currentDraft,
        events: currentDraft.events.map((event) =>
          event.event === eventName
            ? {
                ...event,
                ...patch
              }
            : event
        )
      };

      markEventDirty(nextDraft);

      return nextDraft;
    });
  };

  const saveEvents = async (): Promise<void> => {
    if (pet.id === "new-pet") {
      setResult({
        ok: false,
        message: "请先保存基础信息，再配置事件。"
      });
      return;
    }

    setSaving(true);

    try {
      const saveResult = await window.desktopPet?.petConfig.saveEventSettings(draft);

      if (!saveResult) {
        setResult({
          ok: false,
          message: "保存没有返回结果，请重试。"
        });
        return;
      }

      setResult(saveResult);

      if (saveResult.ok && saveResult.pet) {
        const nextDraft = createEventSettingsDraft(saveResult.pet);
        setDraft(nextDraft);
        setSavedDraft(nextDraft);
        onDirtyChange(false);
        onSavedPet?.(saveResult.pet);
      }
    } finally {
      setSaving(false);
    }
  };

  const previewSource = async (
    eventName: PetLineEvent,
    source: PetExpressionSourceItem | undefined
  ): Promise<void> => {
    if (source?.runtimeName === undefined || !pet.modelPath) {
      setPreviewMessage("请先选择可预览的动作或表情。");
      return;
    }

    const result = await window.desktopPet?.petWindow.previewSource({ petId: pet.id, source });

    if (!result?.ok) {
      setPreviewMessage(result?.message ?? "桌面预览未能启动。");
      return;
    }

    activePreviewIdRef.current = result.previewId;
    setActivePreviewEvent(eventName);
    setPreviewMessage("正在桌面桌宠中预览。");
  };

  return (
    <div className="editorPanel eventSettingsPanel">
      <div className="panelTitleRow">
        <div>
          <h2>事件配置</h2>
          <p>为加载、点击、拖拽、穿透、关闭等事件绑定动作 / 表情和候选台词。</p>
        </div>
      </div>

      {!hasExpressionSources ? (
        <div className="settingsHint">
          <Smile size={16} />
          <span>当前还没有可绑定的动作 / 表情源。请先在 Live2D 导入页保存模型。</span>
        </div>
      ) : null}
      {previewMessage ? <p className="eventPreviewMessage">{previewMessage}</p> : null}

      <div className="eventGrid">
        {eventColumns.map((columnEvents, columnIndex) => (
          <div className="eventColumn" key={`event-column-${columnIndex}`}>
            {columnEvents.map((event) => {
              const eventDraft =
                draft.events.find((draftEvent) => draftEvent.event === event.id) ??
                createEventSettingsDraft(pet).events.find((draftEvent) => draftEvent.event === event.id);
              const lines = eventDraft?.lines.length ? eventDraft.lines : [""];
              const selectedSource = eventDraft?.source;
              const selectedSourceKind = selectedSource?.sourceKind;
              const hasSelectedFaceExpression =
                selectedSourceKind === "expression" && Boolean(selectedSource);
              const candidateLineCount = (eventDraft?.lines ?? []).filter((line) =>
                getPetLineText(line).trim()
              ).length;

              return (
                <article className="eventTile" key={event.id}>
                  <div className="eventTileHeader">
                    <div className="eventTitleBlock">
                      <strong>{event.label}</strong>
                    </div>
                    <button
                      className={
                        activePreviewEvent === event.id
                          ? "eventSourcePreviewIconButton active"
                          : "eventSourcePreviewIconButton"
                      }
                      type="button"
                      disabled={selectedSource?.runtimeName === undefined}
                      title="在桌面桌宠中预览当前选择"
                      aria-label={`预览${event.label}的当前动作或表情`}
                      onClick={() => void previewSource(event.id, selectedSource)}
                    >
                      <Play size={16} fill="currentColor" aria-hidden="true" />
                    </button>
                  </div>
                  <div className="eventExpressionSection">
                    <div className="eventExpressionPickerGroup" aria-label={`${event.label} 触发表现`}>
                      <AppleSelect
                        value={selectedSourceKind === "motion" && selectedSource ? getSourceValue(selectedSource) : ""}
                        ariaLabel={`${event.label} 动作`}
                        className="eventExpressionSelect"
                        menuBoundarySelector=".eventTile"
                        placeholder="动作"
                        options={[
                          { value: clearEventExpressionValue, label: "无" },
                          ...motionSources.map((source) => ({
                            value: getSourceValue(source),
                            label: getSourceLabel(source)
                          }))
                        ]}
                        onChange={(nextSourceValue) =>
                          updateEvent(event.id, {
                            expression: undefined,
                            source: motionSources.find((source) => getSourceValue(source) === nextSourceValue)
                          })
                        }
                      />
                      <AppleSelect
                        value={selectedSourceKind === "expression" && selectedSource ? getSourceValue(selectedSource) : ""}
                        ariaLabel={`${event.label} 表情`}
                        className="eventExpressionSelect"
                        menuBoundarySelector=".eventTile"
                        placeholder="表情"
                        options={[
                          { value: clearEventExpressionValue, label: "无" },
                          ...faceSources.map((source) => ({
                            value: getSourceValue(source),
                            label: getSourceLabel(source)
                          }))
                        ]}
                        onChange={(nextSourceValue) =>
                          updateEvent(event.id, {
                            expression: undefined,
                            source: faceSources.find((source) => getSourceValue(source) === nextSourceValue)
                          })
                        }
                      />
                    </div>
                  </div>
                  {hasSelectedFaceExpression ? (
                    <div className="eventTimingGrid single">
                      <label className="eventNumberField">
                        <span>表情持续</span>
                        <input
                          type="number"
                          min="0.5"
                          max="12"
                          step="0.1"
                          value={((eventDraft?.sourceDurationMs ?? eventDraft?.expressionDurationMs ?? event.expressionDurationMs) / 1000).toString()}
                          onChange={(changeEvent) =>
                            updateEvent(event.id, {
                              sourceDurationMs: Math.round(Number(changeEvent.target.value || 0) * 1000)
                            })
                          }
                        />
                        <small>秒</small>
                      </label>
                    </div>
                  ) : null}
                  <div className="eventLinesField">
                    <div className="eventLinesHeader">
                      <span>
                        候选台词
                        <em>{candidateLineCount} 条</em>
                      </span>
                      <button
                        className="eventAddLineButton"
                        type="button"
                        onClick={() =>
                          updateEvent(event.id, {
                            lines: [...(eventDraft?.lines ?? []), ""]
                          })
                        }
                      >
                        <Plus size={14} />
                        新增
                      </button>
                    </div>
                    <div className="eventLineList">
                      {lines.map((line, index) => {
                        const lineText = getPetLineText(line);
                        const canRemove = lines.length > 1 || Boolean(lineText.trim());

                        return (
                          <div className="eventLineItem" key={`${event.id}-line-${index}`}>
                            <AutoGrowEventLineTextarea
                              value={lineText}
                              onChange={(value) =>
                                updateEvent(event.id, {
                                  lines: updatePetLineAt(eventDraft?.lines ?? [], index, value)
                                })
                              }
                            />
                            <button
                              className="eventRemoveLineButton"
                              type="button"
                              disabled={!canRemove}
                              title="删除台词"
                              aria-label="删除台词"
                              onClick={() =>
                                updateEvent(event.id, {
                                  lines: removePetLineAt(eventDraft?.lines ?? [], index)
                                })
                              }
                            >
                              <X size={14} />
                            </button>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                </article>
              );
            })}
          </div>
        ))}
      </div>

      <PanelSaveActions
        onSave={() => void saveEvents()}
        saving={saving}
        result={result}
      />
    </div>
  );
}
