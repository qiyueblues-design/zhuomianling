import { useEffect, useState } from "react";
import type { LocalPetSaveResult, PetDefinition } from "../../../shared/types/pet";
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
  const [savedOpacity, setSavedOpacity] = useState(currentOpacity);
  const [selectedOpacity, setSelectedOpacity] = useState(currentOpacity);
  const [savedCursorFollowEnabled, setSavedCursorFollowEnabled] = useState(currentCursorFollowEnabled);
  const [cursorFollowEnabled, setCursorFollowEnabled] = useState(currentCursorFollowEnabled);
  const [saving, setSaving] = useState(false);
  const [result, setResult] = useState<LocalPetSaveResult | undefined>();

  useEffect(() => {
    const nextOpacity = normalizeClickThroughOpacity(pet.uiSettings?.clickThroughOpacity);
    setSavedOpacity(nextOpacity);
    setSelectedOpacity(nextOpacity);
    const nextCursorFollowEnabled = pet.uiSettings?.cursorFollowEnabled !== false;
    setSavedCursorFollowEnabled(nextCursorFollowEnabled);
    setCursorFollowEnabled(nextCursorFollowEnabled);
    setResult(undefined);
    onDirtyChange(false);
  }, [pet.id, pet.uiSettings?.clickThroughOpacity, pet.uiSettings?.cursorFollowEnabled, onDirtyChange]);

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
        cursorFollowEnabled
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
        <div className="settingsRowHeader">
          <div>
            <h3>点击穿透</h3>
            <p>开启穿透时，聊天框会关闭，桌宠会保持可见但不遮挡后方文字。</p>
          </div>
        </div>
        <fieldset className="settingsField">
          <legend>穿透后透明度</legend>
          <div className="rangeControl">
            <input
              type="range"
              min={minClickThroughOpacity * 100}
              max={maxClickThroughOpacity * 100}
              step="5"
              value={Math.round(selectedOpacity * 100)}
              aria-valuetext={`${Math.round(selectedOpacity * 100)}%`}
              onChange={(event) => {
                const nextOpacity = normalizeClickThroughOpacity(Number(event.target.value) / 100);
                setSelectedOpacity(nextOpacity);
                setResult(undefined);
                onDirtyChange(
                  nextOpacity !== savedOpacity || cursorFollowEnabled !== savedCursorFollowEnabled
                );
              }}
            />
            <strong>{Math.round(selectedOpacity * 100)}%</strong>
          </div>
          <p className="settingsFieldNote">数值越低，开启穿透后越容易看清桌宠后方的内容。</p>
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
              setResult(undefined);
              onDirtyChange(nextValue !== savedCursorFollowEnabled || selectedOpacity !== savedOpacity);
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
