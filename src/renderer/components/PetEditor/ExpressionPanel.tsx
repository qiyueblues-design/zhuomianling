import { ChevronDown, Play, Shuffle, X } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { Live2DImportedSource } from "../../../shared/types/live2dImport";
import type {
  LocalPetSaveResult,
  PetDefinition,
  PetExpressionKey,
  PetExpressionRandomScope,
  PetExpressionSourceItem
} from "../../../shared/types/pet";
import { PanelSaveActions } from "./EditorShared";
import { commonMappingKeys, expressionOrder } from "./editorNavigation";

interface MappingRowDraft {
  id: string;
  sourceFileName: string;
  runtimeName?: string | number;
  sourceKind: "expression" | "motion";
  mappingKey: string;
  description: string;
}

const mappingKeyPattern = /^[A-Za-z][A-Za-z0-9_-]*$/;

interface MappingRowValidation {
  duplicateKeys: Set<string>;
  invalidRowMessages: string[];
  invalidRowIds: Set<string>;
}

function validateMappingRows(rows: MappingRowDraft[]): MappingRowValidation {
  const filledRows = rows.filter((row) => row.mappingKey.trim());
  const keyCounts = new Map<string, number>();

  for (const row of filledRows) {
    const key = row.mappingKey.trim();
    keyCounts.set(key, (keyCounts.get(key) ?? 0) + 1);
  }

  const duplicateKeys = new Set(
    [...keyCounts.entries()]
      .filter(([, count]) => count > 1)
      .map(([key]) => key)
  );
  const invalidRowIds = new Set<string>();
  const invalidRowMessages: string[] = [];

  for (const row of filledRows) {
    const key = row.mappingKey.trim();

    if (!mappingKeyPattern.test(key)) {
      invalidRowIds.add(row.id);
    }

    if (duplicateKeys.has(key)) {
      invalidRowIds.add(row.id);
    }
  }

  if ([...invalidRowIds].some((rowId) => {
    const row = filledRows.find((item) => item.id === rowId);
    return row ? !mappingKeyPattern.test(row.mappingKey.trim()) : false;
  })) {
    invalidRowMessages.push("映射 key 只能填写英文开头的英文、数字、下划线或短横线。");
  }

  for (const key of duplicateKeys) {
    invalidRowMessages.push(`映射 key「${key}」重复，请保持每一行唯一。`);
  }

  return {
    duplicateKeys,
    invalidRowMessages,
    invalidRowIds
  };
}

function AutoGrowDescriptionTextarea({
  id,
  placeholder,
  value,
  disabled = false,
  onChange
}: {
  id: string;
  placeholder: string;
  value: string;
  disabled?: boolean;
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
      className="mappingDescriptionInput"
      value={value}
      aria-label={`${id} ${placeholder}`}
      disabled={disabled}
      placeholder={placeholder}
      ref={textareaRef}
      rows={1}
      onChange={(event) => onChange(event.target.value)}
    />
  );
}

function MappingKeyInput({
  id,
  value,
  disabled = false,
  onChange
}: {
  id: string;
  value: string;
  disabled?: boolean;
  onChange: (value: string) => void;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const options = commonMappingKeys;

  useEffect(() => {
    if (!open) {
      return;
    }

    const closeOnOutsidePointer = (event: PointerEvent): void => {
      if (!rootRef.current?.contains(event.target as Node)) {
        setOpen(false);
      }
    };

    const closeOnEscape = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        setOpen(false);
      }
    };

    window.addEventListener("pointerdown", closeOnOutsidePointer);
    window.addEventListener("keydown", closeOnEscape);

    return () => {
      window.removeEventListener("pointerdown", closeOnOutsidePointer);
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [open]);

  return (
    <div className={open ? "mappingKeyCombobox open" : "mappingKeyCombobox"} ref={rootRef}>
      <input
        className="mappingKeySelect"
        value={value}
        aria-label={`${id} 映射 key`}
        aria-autocomplete="list"
        aria-expanded={open}
        disabled={disabled}
        placeholder="可自定义"
        role="combobox"
        onChange={(event) => {
          onChange(event.target.value);
          setOpen(true);
        }}
        onFocus={() => {
          if (!disabled) {
            setOpen(true);
          }
        }}
      />
      <ChevronDown size={15} aria-hidden="true" />
      {open && !disabled ? (
        <div className="mappingKeyMenu" role="listbox" aria-label={`${id} 可选映射 key`}>
          {options.map((key) => (
            <button
              className={key === value ? "mappingKeyOption selected" : "mappingKeyOption"}
              type="button"
              role="option"
              aria-selected={key === value}
              key={key}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => {
                onChange(key);
                setOpen(false);
              }}
            >
              {key}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function normalizeExpressionName(value: string | number | undefined): string {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/\\/g, "/")
    .split("/")
    .pop()
    ?.replace(/\.exp3\.json$/i, "")
    .replace(/\.[^.]+$/i, "") ?? "";
}

function createRowId(source: Pick<MappingRowDraft, "sourceKind" | "sourceFileName">, index: number): string {
  return `${source.sourceKind}-${source.sourceFileName}-${index}`;
}

function getSavedMappingKeyForSource(
  pet: PetDefinition,
  source: Pick<MappingRowDraft, "sourceKind" | "sourceFileName" | "runtimeName">,
  sourceIndex: number
): PetExpressionKey | undefined {
  const sourceNames = [
    normalizeExpressionName(source.runtimeName),
    normalizeExpressionName(source.sourceFileName)
  ];
  const savedMappingKeys = Object.keys(pet.expressions ?? {}) as PetExpressionKey[];

  return savedMappingKeys.find((key) => {
    const expressionValue = pet.expressions?.[key];
    const mappedExpression = normalizeExpressionName(expressionValue);
    const mappedSourceFile = normalizeExpressionName(pet.expressionSourceFiles?.[key]);
    const matchesExpressionIndex =
      source.sourceKind === "expression" &&
      typeof expressionValue === "number" &&
      expressionValue === sourceIndex;

    return Boolean(
      matchesExpressionIndex ||
      (mappedExpression && sourceNames.includes(mappedExpression)) ||
        (mappedSourceFile && sourceNames.includes(mappedSourceFile))
    );
  });
}

function rowsFromSources(pet: PetDefinition, sources: PetExpressionSourceItem[]): MappingRowDraft[] {
  return sources
    .map((source, index) => {
      const mappedKey = getSavedMappingKeyForSource(pet, source, index);

      return {
        id: createRowId({
          sourceKind: source.sourceKind,
          sourceFileName: source.sourceFileName
        }, index),
        sourceFileName: source.sourceFileName,
        runtimeName: source.runtimeName,
        sourceKind: source.sourceKind,
        mappingKey: mappedKey ?? "",
        description: mappedKey ? pet.expressionDescriptions?.[mappedKey] ?? "" : ""
      };
    })
    .sort((a, b) => Number(Boolean(b.mappingKey)) - Number(Boolean(a.mappingKey)));
}

function getPreferredSourceKind(
  rows: MappingRowDraft[],
  current?: MappingRowDraft["sourceKind"]
): MappingRowDraft["sourceKind"] {
  if (current && rows.some((row) => row.sourceKind === current)) {
    return current;
  }

  return rows.some((row) => row.sourceKind === "motion") ? "motion" : "expression";
}

function createExpressionMappingRows(pet: PetDefinition): MappingRowDraft[] {
  if (pet.expressionSources?.length) {
    return rowsFromSources(pet, pet.expressionSources);
  }

  const savedMappingKeys = Object.keys(pet.expressions ?? {});
  const orderedKeys = [
    ...expressionOrder.filter((key) => savedMappingKeys.includes(key)),
    ...savedMappingKeys.filter((key) => !expressionOrder.includes(key))
  ];

  if (orderedKeys.length) {
    return orderedKeys.map((key) => ({
      id: key,
      sourceFileName: pet.expressionSourceFiles?.[key] ?? String(pet.expressions?.[key] ?? ""),
      runtimeName: pet.expressions?.[key],
      sourceKind: pet.expressionSourceKinds?.[key] ?? "expression",
      mappingKey: key,
      description: pet.expressionDescriptions?.[key] ?? ""
    }));
  }

  return [];
}

export function ExpressionPanel({
  pet,
  onSavedPet,
  onDirtyChange
}: {
  pet: PetDefinition;
  onSavedPet?: (pet: PetDefinition) => void;
  onDirtyChange: (dirty: boolean) => void;
}): JSX.Element {
  const [mappingRows, setMappingRows] = useState<MappingRowDraft[]>(() =>
    createExpressionMappingRows(pet)
  );
  const [saving, setSaving] = useState(false);
  const [activeSourceKind, setActiveSourceKind] = useState<MappingRowDraft["sourceKind"]>("motion");
  const [expressionSelectionMode, setExpressionSelectionMode] = useState(
    pet.expressionSelectionMode ?? "semantic"
  );
  const [expressionRandomScope, setExpressionRandomScope] = useState<PetExpressionRandomScope>(
    pet.expressionRandomScope ?? "all"
  );
  const [randomDialogOpen, setRandomDialogOpen] = useState(false);
  const [draftRandomScope, setDraftRandomScope] = useState<PetExpressionRandomScope>(
    pet.expressionRandomScope ?? "all"
  );
  const [previewMessage, setPreviewMessage] = useState<string>();
  const [activePreviewRowId, setActivePreviewRowId] = useState<string>();
  const activePreviewIdRef = useRef<number | undefined>();
  const [saveResult, setSaveResult] = useState<LocalPetSaveResult>();
  const validation = validateMappingRows(mappingRows);
  const randomMode = expressionSelectionMode === "random";
  const sourceKindCounts = mappingRows.reduce(
    (counts, row) => ({
      ...counts,
      [row.sourceKind]: counts[row.sourceKind] + 1
    }),
    { motion: 0, expression: 0 } as Record<MappingRowDraft["sourceKind"], number>
  );
  const visibleMappingRows = mappingRows.filter((row) => row.sourceKind === activeSourceKind);
  const activeSourceLabel = activeSourceKind === "motion" ? "动作" : "表情";
  const randomScopeCounts = sourceKindCounts;
  const randomScopeTotal = randomScopeCounts.motion + randomScopeCounts.expression;
  const selectedRandomScopeCount =
    expressionRandomScope === "motion"
      ? randomScopeCounts.motion
      : expressionRandomScope === "expression"
        ? randomScopeCounts.expression
        : randomScopeTotal;
  const draftRandomScopeCount =
    draftRandomScope === "motion"
      ? randomScopeCounts.motion
      : draftRandomScope === "expression"
        ? randomScopeCounts.expression
        : randomScopeTotal;

  useEffect(() => {
    const nextRows = createExpressionMappingRows(pet);

    setMappingRows(nextRows);
    setActiveSourceKind((current) => getPreferredSourceKind(nextRows, current));
    setExpressionSelectionMode(pet.expressionSelectionMode ?? "semantic");
    setExpressionRandomScope(pet.expressionRandomScope ?? "all");
    setDraftRandomScope(pet.expressionRandomScope ?? "all");
    setPreviewMessage(undefined);
    setSaveResult(undefined);
    onDirtyChange(false);
  }, [onDirtyChange, pet]);

  useEffect(() => {
    return window.desktopPet?.petWindow.onSourcePreviewFinished(({ id }) => {
      if (activePreviewIdRef.current === id) {
        activePreviewIdRef.current = undefined;
        setActivePreviewRowId(undefined);
      }
    });
  }, []);

  const previewSource = async (row: MappingRowDraft): Promise<void> => {
    if (!pet.modelPath || row.runtimeName === undefined) {
      setPreviewMessage("该资源暂时不能在桌面桌宠中预览。");
      return;
    }

    const result = await window.desktopPet?.petWindow.previewSource({
      petId: pet.id,
      source: {
        sourceFileName: row.sourceFileName,
        runtimeName: row.runtimeName,
        sourceKind: row.sourceKind
      }
    });

    if (!result?.ok) {
      setPreviewMessage(result?.message ?? "桌面预览未能启动。");
      return;
    }

    activePreviewIdRef.current = result.previewId;
    setActivePreviewRowId(row.id);
    setPreviewMessage("正在桌面桌宠中预览。");
  };

  const updateMappingRow = (id: string, nextDraft: Partial<MappingRowDraft>): void => {
    setMappingRows((rows) =>
      rows.map((row) => (row.id === id ? { ...row, ...nextDraft } : row))
    );
    onDirtyChange(true);
  };

  const saveMappings = async (): Promise<void> => {
    if (pet.id === "new-pet") {
      setSaveResult({
        ok: false,
        message: "请先保存基础信息，再保存表现映射。"
      });
      return;
    }

    if (!randomMode && validation.invalidRowMessages.length) {
      setSaveResult({
        ok: false,
        message: validation.invalidRowMessages.join(" ")
      });
      return;
    }

    setSaving(true);
    setSaveResult(undefined);

    const result = await window.desktopPet?.petConfig.saveExpressionMappings({
      petId: pet.id,
      mappings: randomMode
        ? []
        : mappingRows
          .filter((row) => row.mappingKey.trim() && row.description.trim() && row.sourceFileName.trim())
          .map((row) => ({
            sourceFileName: row.sourceFileName,
            runtimeName: row.runtimeName,
            sourceKind: row.sourceKind,
            mappingKey: row.mappingKey,
            description: row.description
          })),
      sources: mappingRows
        .filter((row) => row.sourceFileName.trim())
        .map((row) => ({
          sourceFileName: row.sourceFileName,
          runtimeName: row.runtimeName,
          sourceKind: row.sourceKind
        })),
      expressionSelectionMode,
      expressionRandomScope
    });

    setSaving(false);
    setSaveResult(result);

    if (result?.ok) {
      onDirtyChange(false);

      if (result.pet) {
        onSavedPet?.(result.pet);
      }
    }
  };

  const openRandomDialog = (): void => {
    setDraftRandomScope(expressionRandomScope);
    setRandomDialogOpen(true);
  };

  const enableRandomMode = (): void => {
    setExpressionSelectionMode("random");
    setExpressionRandomScope(draftRandomScope);
    setRandomDialogOpen(false);
    setSaveResult(undefined);
    setPreviewMessage("随机表现已开启：AI 回复时会随机播放表情。");
    onDirtyChange(true);
  };

  const disableRandomMode = (): void => {
    setExpressionSelectionMode("semantic");
    setRandomDialogOpen(false);
    setSaveResult(undefined);
    setPreviewMessage("随机表现已关闭：AI 回复时会按映射描述选择表情。");
    onDirtyChange(true);
  };

  return (
    <div className="editorPanel expressionMappingPanel">
      <div className="panelTitleRow">
        <div>
          <h2>表现映射</h2>
          <p>为已导入的 Live2D 动作 / 表情绑定映射 key 和描述；配置后 AI 可分析聊天语境并触发对应表情。</p>
        </div>
        <button
          className={randomMode ? "mappingRandomToggle active" : "mappingRandomToggle"}
          type="button"
          title="随机表现"
          onClick={openRandomDialog}
        >
          <Shuffle size={16} />
          随机
        </button>
      </div>

      <div className="mappingMetaRow">
        <p className="mappingSourceSummary">
          {pet.modelPath
            ? `已自动识别：${sourceKindCounts.motion} 个动作 · ${sourceKindCounts.expression} 个表情`
            : "导入 Live2D 模型后会自动识别动作和表情。"}
        </p>
        {randomMode ? (
          <p className="mappingRandomStatus">
            随机：
            {expressionRandomScope === "motion" ? "动作" : expressionRandomScope === "expression" ? "表情" : "全部"}
            · {selectedRandomScopeCount} 个（编辑已锁定）
          </p>
        ) : previewMessage ? <p className="mappingPreviewMessage">{previewMessage}</p> : null}
      </div>

      <div className="mappingSourceSwitch" aria-label="源文件类型">
        <button
          className={activeSourceKind === "motion" ? "mappingSourceButton active" : "mappingSourceButton"}
          type="button"
          aria-pressed={activeSourceKind === "motion"}
          onClick={() => setActiveSourceKind("motion")}
        >
          <span>动作</span>
          <strong>{sourceKindCounts.motion}</strong>
        </button>
        <button
          className={activeSourceKind === "expression" ? "mappingSourceButton active" : "mappingSourceButton"}
          type="button"
          aria-pressed={activeSourceKind === "expression"}
          onClick={() => setActiveSourceKind("expression")}
        >
          <span>表情</span>
          <strong>{sourceKindCounts.expression}</strong>
        </button>
      </div>

      <div className={randomMode ? "mappingEditArea randomLocked" : "mappingEditArea"}>
        <div className="mappingHeaderRow" aria-hidden="true">
          <span>源文件</span>
          <span>预览</span>
          <span>映射 key</span>
          <span>{activeSourceLabel}描述</span>
        </div>

        <div className="mappingList">
        {visibleMappingRows.length ? visibleMappingRows.map((row) => {
          const invalid = !randomMode && validation.invalidRowIds.has(row.id);

          return (
          <div className={invalid ? "mappingRow invalid" : "mappingRow"} key={row.id}>
            <input
              className="expressionSourceInput"
              value={row.sourceFileName}
              readOnly
              disabled={randomMode}
              placeholder="导入后显示源文件"
              aria-label={`${row.id} 源文件名`}
            />
            <button
              className={activePreviewRowId === row.id ? "mappingPreviewButton active" : "mappingPreviewButton"}
              type="button"
              disabled={row.runtimeName === undefined}
              title="在桌面桌宠中预览"
              onClick={() => void previewSource(row)}
            >
              <Play size={14} fill="currentColor" aria-hidden="true" />
              预览
            </button>
            <MappingKeyInput
              id={row.id}
              value={row.mappingKey}
              disabled={randomMode}
              onChange={(value) => updateMappingRow(row.id, { mappingKey: value })}
            />
            <AutoGrowDescriptionTextarea
              id={row.id}
              placeholder={`描述该${activeSourceLabel}`}
              value={row.description}
              disabled={randomMode}
              onChange={(value) => updateMappingRow(row.id, { description: value })}
            />
            {invalid ? (
              <span className="mappingRowErrorIcon" title="映射 key 只能填写英文且不能重复" aria-label="映射 key 错误">
                <X size={14} />
              </span>
            ) : null}
          </div>
          );
        }) : (
          <div className="mappingEmptyState">
            {pet.modelPath ? `没有识别到${activeSourceLabel}源文件。` : "导入模型后显示源文件。"}
          </div>
        )}
        </div>
      </div>

      {randomDialogOpen ? (
        <div className="mappingRandomOverlay" role="dialog" aria-modal="true" aria-label="随机表现">
          <div className="mappingRandomDialog">
            <div className="mappingRandomDialogHeader">
              <span className="mappingRandomIcon" aria-hidden="true">
                <Shuffle size={18} />
              </span>
              <div>
                <h3>随机表现</h3>
                <p>开启后，AI 回复时会随机播放所选范围内的表情或动作。</p>
              </div>
            </div>
            <div className="mappingRandomChoices">
              {[
                { value: "motion", label: "动作", count: randomScopeCounts.motion },
                { value: "expression", label: "表情", count: randomScopeCounts.expression },
                { value: "all", label: "全部", count: randomScopeTotal }
              ].map((option) => (
                <button
                  className={draftRandomScope === option.value ? "mappingRandomChoice active" : "mappingRandomChoice"}
                  type="button"
                  disabled={!option.count}
                  key={option.value}
                  onClick={() => setDraftRandomScope(option.value as PetExpressionRandomScope)}
                >
                  <strong>{option.label}</strong>
                  <span>{option.count} 个</span>
                </button>
              ))}
            </div>
            {!randomScopeTotal ? (
              <p className="mappingRandomWarning">还没有可随机的动作或表情，请先扫描当前模型。</p>
            ) : null}
            <div className="mappingRandomActions">
              {randomMode ? (
                <button className="secondaryAction" type="button" onClick={disableRandomMode}>
                  关闭随机
                </button>
              ) : null}
              <button className="secondaryAction" type="button" onClick={() => setRandomDialogOpen(false)}>
                取消
              </button>
              <button className="primaryAction" type="button" disabled={!draftRandomScopeCount} onClick={enableRandomMode}>
                启用随机
              </button>
            </div>
          </div>
        </div>
      ) : null}

      <PanelSaveActions onSave={() => void saveMappings()} saving={saving} result={saveResult} />
    </div>
  );
}
