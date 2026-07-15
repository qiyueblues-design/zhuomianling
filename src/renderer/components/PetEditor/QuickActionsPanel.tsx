import { useEffect, useState } from "react";
import type { LocalPetSaveResult, PetDefinition } from "../../../shared/types/pet";
import {
  defaultPetDesktopScale,
  maxPetDesktopScale,
  minPetDesktopScale,
  normalizePetDesktopScale,
  petDesktopScaleStep
} from "../../../shared/validation/petUiSettings";
import { PanelSaveActions } from "./EditorShared";

const defaultClickThroughOpacity = 0.45;
const minClickThroughOpacity = 0.2;
const maxClickThroughOpacity = 0.8;

function normalizeClickThroughOpacity(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return defaultClickThroughOpacity;
  }

  return Math.min(maxClickThroughOpacity, Math.max(minClickThroughOpacity, Math.round(value * 100) / 100));
}

export interface QuickActionsSettingsValues {
  clickThroughOpacity: number;
  cursorFollowEnabled: boolean;
  desktopScale: number;
}

export function hasQuickActionsSettingsChanges(
  current: QuickActionsSettingsValues,
  saved: QuickActionsSettingsValues
): boolean {
  return (
    current.clickThroughOpacity !== saved.clickThroughOpacity ||
    current.cursorFollowEnabled !== saved.cursorFollowEnabled ||
    current.desktopScale !== saved.desktopScale
  );
}

export function QuickActionsPanel({
  pet,
  onSavedPet,
  onDirtyChange
}: {
  pet: PetDefinition;
  onSavedPet?: (pet: PetDefinition) => void;
  onDirtyChange: (dirty: boolean) => void;
}): JSX.Element {
  const currentOpacity = normalizeClickThroughOpacity(pet.uiSettings?.clickThroughOpacity);
  const currentCursorFollowEnabled = pet.uiSettings?.cursorFollowEnabled !== false;
  const currentDesktopScale = normalizePetDesktopScale(pet.uiSettings?.desktopScale);
  const [savedOpacity, setSavedOpacity] = useState(currentOpacity);
  const [selectedOpacity, setSelectedOpacity] = useState(currentOpacity);
  const [savedCursorFollowEnabled, setSavedCursorFollowEnabled] = useState(currentCursorFollowEnabled);
  const [cursorFollowEnabled, setCursorFollowEnabled] = useState(currentCursorFollowEnabled);
  const [savedDesktopScale, setSavedDesktopScale] = useState(currentDesktopScale);
  const [selectedDesktopScale, setSelectedDesktopScale] = useState(currentDesktopScale);
  const [saving, setSaving] = useState(false);
  const [result, setResult] = useState<LocalPetSaveResult | undefined>();

  useEffect(() => {
    const nextOpacity = normalizeClickThroughOpacity(pet.uiSettings?.clickThroughOpacity);
    setSavedOpacity(nextOpacity);
    setSelectedOpacity(nextOpacity);
    const nextCursorFollowEnabled = pet.uiSettings?.cursorFollowEnabled !== false;
    setSavedCursorFollowEnabled(nextCursorFollowEnabled);
    setCursorFollowEnabled(nextCursorFollowEnabled);
    const nextDesktopScale = normalizePetDesktopScale(pet.uiSettings?.desktopScale);
    setSavedDesktopScale(nextDesktopScale);
    setSelectedDesktopScale(nextDesktopScale);
    setResult(undefined);
    onDirtyChange(false);
  }, [
    pet.id,
    pet.uiSettings?.clickThroughOpacity,
    pet.uiSettings?.cursorFollowEnabled,
    pet.uiSettings?.desktopScale,
    onDirtyChange
  ]);

  const savedValues: QuickActionsSettingsValues = {
    clickThroughOpacity: savedOpacity,
    cursorFollowEnabled: savedCursorFollowEnabled,
    desktopScale: savedDesktopScale
  };
  const markDirty = (nextValues: QuickActionsSettingsValues): void => {
    setResult(undefined);
    onDirtyChange(hasQuickActionsSettingsChanges(nextValues, savedValues));
  };

  const saveQuickActions = async (): Promise<void> => {
    if (pet.id === "new-pet") {
      setResult({ ok: false, message: "请先保存基础信息，再保存快捷操作。" });
      return;
    }

    setSaving(true);
    setResult(undefined);

    try {
      const saveResult = await window.desktopPet?.petConfig.saveUiSettings({
        petId: pet.id,
        theme: pet.uiSettings?.theme ?? "soft",
        customThemeId: pet.uiSettings?.customThemeId,
        clickThroughOpacity: selectedOpacity,
        cursorFollowEnabled,
        desktopScale: selectedDesktopScale
      });

      if (!saveResult) {
        return;
      }

      setResult(saveResult);

      if (saveResult.ok && saveResult.pet) {
        const nextOpacity = normalizeClickThroughOpacity(saveResult.pet.uiSettings?.clickThroughOpacity);
        setSavedOpacity(nextOpacity);
        setSelectedOpacity(nextOpacity);
        const nextCursorFollowEnabled = saveResult.pet.uiSettings?.cursorFollowEnabled !== false;
        setSavedCursorFollowEnabled(nextCursorFollowEnabled);
        setCursorFollowEnabled(nextCursorFollowEnabled);
        const nextDesktopScale = normalizePetDesktopScale(
          saveResult.pet.uiSettings?.desktopScale
        );
        setSavedDesktopScale(nextDesktopScale);
        setSelectedDesktopScale(nextDesktopScale);
        onDirtyChange(false);
        onSavedPet?.(saveResult.pet);
      }
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="editorPanel">
      <div className="panelTitleRow">
        <div>
          <h2>快捷操作</h2>
          <p>调整桌宠常用交互在桌面上的显示方式。</p>
        </div>
        <span className="localBadge">按模型保存</span>
      </div>

      <section className="quickActionsPanel" aria-label="快捷操作设置">
        <fieldset className="settingsField quickActionScaleField">
          <legend>桌宠大小</legend>
          <div className="quickActionFieldHeader">
            <p>调整桌宠窗口和模型在桌面上的整体尺寸，保存后立即生效。</p>
            <button
              className="secondaryAction quickActionResetButton"
              type="button"
              disabled={selectedDesktopScale === defaultPetDesktopScale}
              onClick={() => {
                setSelectedDesktopScale(defaultPetDesktopScale);
                markDirty({
                  clickThroughOpacity: selectedOpacity,
                  cursorFollowEnabled,
                  desktopScale: defaultPetDesktopScale
                });
              }}
            >
              恢复 100%
            </button>
          </div>
          <div className="desktopScaleRangeControl">
            <span aria-hidden="true">70%</span>
            <input
              id="desktop-pet-scale"
              type="range"
              min={minPetDesktopScale * 100}
              max={maxPetDesktopScale * 100}
              step={petDesktopScaleStep * 100}
              value={Math.round(selectedDesktopScale * 100)}
              aria-label="桌宠大小"
              aria-describedby="desktop-pet-scale-note"
              aria-valuetext={`${Math.round(selectedDesktopScale * 100)}%`}
              onChange={(event) => {
                const nextDesktopScale = normalizePetDesktopScale(
                  Number(event.target.value) / 100
                );
                setSelectedDesktopScale(nextDesktopScale);
                markDirty({
                  clickThroughOpacity: selectedOpacity,
                  cursorFollowEnabled,
                  desktopScale: nextDesktopScale
                });
              }}
            />
            <span aria-hidden="true">150%</span>
            <strong aria-live="polite">{Math.round(selectedDesktopScale * 100)}%</strong>
          </div>
          <p className="settingsFieldNote" id="desktop-pet-scale-note">
            可调范围 70%–150%，每档 5%；屏幕空间不足时会自动等比缩小。
          </p>
        </fieldset>
        <fieldset className="settingsField">
          <legend>点击穿透</legend>
          <div className="quickActionFieldHeader">
            <p>开启穿透时，聊天框会关闭，桌宠会保持可见但不遮挡后方文字。</p>
          </div>
          <label className="quickActionRangeLabel" htmlFor="click-through-opacity">
            穿透后透明度
          </label>
          <div className="rangeControl">
            <input
              id="click-through-opacity"
              type="range"
              min={minClickThroughOpacity * 100}
              max={maxClickThroughOpacity * 100}
              step="5"
              value={Math.round(selectedOpacity * 100)}
              aria-describedby="click-through-opacity-note"
              aria-valuetext={`${Math.round(selectedOpacity * 100)}%`}
              onChange={(event) => {
                const nextOpacity = normalizeClickThroughOpacity(Number(event.target.value) / 100);
                setSelectedOpacity(nextOpacity);
                markDirty({
                  clickThroughOpacity: nextOpacity,
                  cursorFollowEnabled,
                  desktopScale: selectedDesktopScale
                });
              }}
            />
            <strong>{Math.round(selectedOpacity * 100)}%</strong>
          </div>
          <p className="settingsFieldNote" id="click-through-opacity-note">
            数值越低，开启穿透后越容易看清桌宠后方的内容。
          </p>
        </fieldset>
        <div className="settingsToggleRow">
          <div>
            <h3>鼠标光标跟随</h3>
            <p>开启后，模型会随桌面鼠标光标转头和移动视线；关闭不影响拖拽。</p>
          </div>
          <button
            className={cursorFollowEnabled ? "settingsToggle active" : "settingsToggle"}
            type="button"
            role="switch"
            aria-checked={cursorFollowEnabled}
            aria-label="鼠标光标跟随"
            onClick={() => {
              const nextValue = !cursorFollowEnabled;
              setCursorFollowEnabled(nextValue);
              markDirty({
                clickThroughOpacity: selectedOpacity,
                cursorFollowEnabled: nextValue,
                desktopScale: selectedDesktopScale
              });
            }}
          >
            <span aria-hidden="true" />
          </button>
        </div>
        <PanelSaveActions onSave={() => void saveQuickActions()} saving={saving} result={result} />
      </section>
    </div>
  );
}
