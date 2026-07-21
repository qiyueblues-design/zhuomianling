import { AlertTriangle, FileJson, Trash2, Upload, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { CSSProperties } from "react";
import { createPortal } from "react-dom";
import type {
  BuiltInPetUiTheme,
  LocalPetSaveResult,
  PetCustomTheme,
  PetCustomThemeImportResult,
  PetDefinition,
  PetUiTheme
} from "../../../shared/types/pet";
import { PanelSaveActions } from "./EditorShared";
import { uiThemeOptions } from "./editorNavigation";

type ThemeCardOption =
  | {
      kind: "custom";
      id: string;
      name: string;
      description: string;
      theme: PetCustomTheme;
    }
  | {
      kind: "builtIn";
      id: BuiltInPetUiTheme;
      name: string;
      description: string;
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
    "--custom-theme-header-surface": tokens.headerSurface ?? tokens.surface,
    "--custom-theme-header-text": tokens.headerText ?? tokens.text,
    "--custom-theme-input-surface": tokens.inputSurface ?? tokens.surface,
    "--custom-theme-user-surface": tokens.userSurface ?? tokens.petSurface ?? tokens.surface,
    "--custom-theme-text": tokens.text,
    "--custom-theme-muted": tokens.mutedText,
    "--custom-theme-accent": tokens.accent,
    "--custom-theme-accent-strong": tokens.accentStrong ?? tokens.accent,
    "--custom-theme-decoration-primary": tokens.decorationPrimary ?? tokens.accent,
    "--custom-theme-decoration-secondary": tokens.decorationSecondary ?? tokens.accentStrong ?? tokens.accent,
    "--custom-theme-watermark": tokens.watermarkColor ?? `color-mix(in srgb, ${tokens.accent} 9%, transparent)`,
    "--custom-theme-border": tokens.border,
    "--custom-theme-danger": tokens.danger ?? "#ef4444",
    "--custom-theme-shadow": tokens.shadow ?? "none",
    "--custom-theme-radius": `${tokens.radius ?? 14}px`
  } as CSSProperties;
}

function isSameTheme(
  theme: PetUiTheme,
  customTheme: PetCustomTheme | undefined,
  savedTheme: PetUiTheme,
  savedCustomTheme: PetCustomTheme | undefined
): boolean {
  return (
    theme === savedTheme &&
    (theme !== "custom" || JSON.stringify(customTheme) === JSON.stringify(savedCustomTheme))
  );
}

function ThemeImportDialog({
  importing,
  result,
  onImport,
  onClose
}: {
  importing: boolean;
  result?: PetCustomThemeImportResult;
  onImport: () => void;
  onClose: () => void;
}): JSX.Element {
  return createPortal(
    <div className="themeImportOverlay" role="dialog" aria-modal="true" aria-label="导入主题风格">
      <div className="themeImportDialog">
        <div className="themeImportHeader">
          <span className="themeImportIcon" aria-hidden="true">
            <FileJson size={20} />
          </span>
          <div>
            <h3>导入主题风格</h3>
            <p>选择一个主题 JSON，保存后只属于当前桌宠。</p>
          </div>
          <button className="iconButton" type="button" title="关闭" aria-label="关闭" onClick={onClose}>
            <X size={17} />
          </button>
        </div>

        <div className="themeImportContent">
          <div className="themeImportPicker">
            <span className="importFileMark" aria-hidden="true">
              <FileJson size={22} />
              <em>JSON</em>
            </span>
            <div>
              <strong>选择主题 JSON</strong>
              <span>读取后会替换当前桌宠的自定义主题，点击保存后生效。</span>
            </div>
            <button className="primaryAction" type="button" disabled={importing} onClick={onImport}>
              <Upload size={17} />
              {importing ? "导入中" : "选择文件"}
            </button>
          </div>
        </div>

        {result && !result.canceled ? (
          <div className={result.ok ? "settingsResult ok" : "settingsResult error"}>
            <span>{result.message}</span>
          </div>
        ) : null}
      </div>
    </div>,
    document.body
  );
}

function ThemeDeleteDialog({
  theme,
  onConfirm,
  onClose
}: {
  theme: PetCustomTheme;
  onConfirm: () => void;
  onClose: () => void;
}): JSX.Element {
  return createPortal(
    <div className="themeImportOverlay" role="dialog" aria-modal="true" aria-labelledby="theme-delete-title">
      <div className="themeImportDialog themeDeleteDialog">
        <div className="themeImportHeader">
          <span className="themeImportIcon danger" aria-hidden="true">
            <AlertTriangle size={20} />
          </span>
          <div>
            <h3 id="theme-delete-title">删除导入主题？</h3>
            <p>“{theme.name}”会从当前桌宠的未保存配置中移除，并切换为软糖风。</p>
          </div>
          <button className="iconButton" type="button" title="关闭" aria-label="关闭" onClick={onClose}>
            <X size={17} />
          </button>
        </div>
        <div className="themeDeleteActions">
          <button className="secondaryAction" type="button" onClick={onClose}>取消</button>
          <button className="primaryAction themeDeleteConfirm" type="button" onClick={onConfirm}>
            <Trash2 size={16} />
            删除主题
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}

export function ThemePanel({
  pet,
  onSavedPet,
  onDirtyChange
}: {
  pet: PetDefinition;
  onSavedPet?: (pet: PetDefinition) => void;
  onDirtyChange: (dirty: boolean) => void;
}): JSX.Element {
  const currentTheme = pet.uiSettings?.theme ?? "soft";
  const currentCustomTheme = pet.uiSettings?.customTheme;
  const [savedTheme, setSavedTheme] = useState<PetUiTheme>(currentTheme);
  const [savedCustomTheme, setSavedCustomTheme] = useState<PetCustomTheme | undefined>(currentCustomTheme);
  const [selectedTheme, setSelectedTheme] = useState<PetUiTheme>(currentTheme);
  const [selectedCustomTheme, setSelectedCustomTheme] = useState<PetCustomTheme | undefined>(currentCustomTheme);
  const [importDialogOpen, setImportDialogOpen] = useState(false);
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  const [importingTheme, setImportingTheme] = useState(false);
  const [importResult, setImportResult] = useState<PetCustomThemeImportResult | undefined>();
  const [saving, setSaving] = useState(false);
  const [result, setResult] = useState<LocalPetSaveResult | undefined>();

  useEffect(() => {
    const nextTheme = pet.uiSettings?.theme ?? "soft";
    const nextCustomTheme = pet.uiSettings?.customTheme;
    setSavedTheme(nextTheme);
    setSavedCustomTheme(nextCustomTheme);
    setSelectedTheme(nextTheme);
    setSelectedCustomTheme(nextCustomTheme);
    setResult(undefined);
    onDirtyChange(false);
  }, [pet.id, pet.uiSettings?.theme, pet.uiSettings?.customTheme, onDirtyChange]);

  const themeOptions = useMemo<ThemeCardOption[]>(
    () => [
      ...(selectedCustomTheme
        ? [{
            kind: "custom" as const,
            id: selectedCustomTheme.id,
            name: selectedCustomTheme.name,
            description: selectedCustomTheme.description,
            theme: selectedCustomTheme
          }]
        : []),
      ...uiThemeOptions.map((theme) => ({
        kind: "builtIn" as const,
        ...theme
      }))
    ],
    [selectedCustomTheme]
  );

  const selectBuiltInTheme = (theme: BuiltInPetUiTheme): void => {
    setSelectedTheme(theme);
    setResult(undefined);
    onDirtyChange(!isSameTheme(theme, selectedCustomTheme, savedTheme, savedCustomTheme));
  };

  const selectCustomTheme = (): void => {
    setSelectedTheme("custom");
    setResult(undefined);
    onDirtyChange(!isSameTheme("custom", selectedCustomTheme, savedTheme, savedCustomTheme));
  };

  const deleteCustomTheme = (): void => {
    setSelectedCustomTheme(undefined);
    setSelectedTheme("soft");
    setResult(undefined);
    setImportResult(undefined);
    setDeleteConfirmOpen(false);
    onDirtyChange(!isSameTheme("soft", undefined, savedTheme, savedCustomTheme));
  };

  const importUiTheme = async (): Promise<void> => {
    setImportingTheme(true);
    setImportResult(undefined);

    try {
      const nextResult = await window.desktopPet?.petConfig.importUiTheme();

      if (!nextResult) {
        return;
      }

      setImportResult(nextResult);

      if (nextResult.ok && nextResult.theme) {
        setSelectedCustomTheme(nextResult.theme);
        setSelectedTheme("custom");
        setResult(undefined);
        onDirtyChange(!isSameTheme("custom", nextResult.theme, savedTheme, savedCustomTheme));
      }
    } finally {
      setImportingTheme(false);
    }
  };

  const saveUiTheme = async (): Promise<void> => {
    if (pet.id === "new-pet") {
      setResult({
        ok: false,
        message: "请先保存基础信息，再保存交互面板。"
      });
      return;
    }

    setSaving(true);
    setResult(undefined);

    try {
      const saveResult = await window.desktopPet?.petConfig.saveUiSettings({
        petId: pet.id,
        theme: selectedTheme,
        customTheme: selectedTheme === "custom" ? selectedCustomTheme : undefined
      });

      if (!saveResult) {
        return;
      }

      setResult(saveResult);

      if (saveResult.ok && saveResult.pet) {
        const nextTheme = saveResult.pet.uiSettings?.theme ?? selectedTheme;
        const nextCustomTheme = saveResult.pet.uiSettings?.customTheme;
        setSavedTheme(nextTheme);
        setSavedCustomTheme(nextCustomTheme);
        setSelectedTheme(nextTheme);
        setSelectedCustomTheme(nextCustomTheme);
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
          <h2>主题风格</h2>
          <p>为右键快捷菜单、聊天框和字幕气泡选择整体外观。</p>
        </div>
        <button className="secondaryAction" type="button" onClick={() => setImportDialogOpen(true)}>
          <Upload size={17} />
          导入主题风格
        </button>
        <span className="localBadge">按桌宠保存</span>
      </div>

      <section className="uiThemeSection" aria-label="主题风格">
        <div className="uiThemeGrid">
          {themeOptions.map((theme) => {
            const selected =
              theme.kind === "custom"
                ? selectedTheme === "custom"
                : selectedTheme === theme.id;

            return (
              <div
                className={theme.kind === "custom" ? "uiThemeCardWrap hasDelete" : "uiThemeCardWrap"}
                key={`${theme.kind}-${theme.id}`}
              >
                <button
                  className={selected ? "uiThemeCard selected" : "uiThemeCard"}
                  type="button"
                  onClick={() => {
                    if (theme.kind === "custom") {
                      selectCustomTheme();
                    } else {
                      selectBuiltInTheme(theme.id);
                    }
                  }}
                >
                  <span
                    className={[
                      "uiThemePreview",
                      theme.kind === "custom" ? "theme-custom" : `theme-${theme.id}`
                    ].join(" ")}
                    style={theme.kind === "custom" ? getCustomThemeStyle(theme.theme) : undefined}
                    aria-hidden="true"
                  >
                    <span className="themePreviewBubble">Hi</span>
                    <span className="themePreviewChat">
                      <span />
                      <em />
                    </span>
                    <span className="themePreviewMenu">
                      <i />
                      <i />
                      <i />
                    </span>
                  </span>
                  <strong>{theme.name}</strong>
                  <span>{theme.description}</span>
                </button>
                {theme.kind === "custom" ? (
                  <button
                    className="themeCardDelete"
                    type="button"
                    title={`删除导入主题「${theme.name}」`}
                    aria-label={`删除导入主题「${theme.name}」`}
                    onClick={() => setDeleteConfirmOpen(true)}
                  >
                    <Trash2 size={15} aria-hidden="true" />
                  </button>
                ) : null}
              </div>
            );
          })}
        </div>
        <PanelSaveActions
          onSave={() => void saveUiTheme()}
          saving={saving}
          disabled={selectedTheme === "custom" && !selectedCustomTheme}
          disabledReason="请先导入当前桌宠的主题。"
          result={result}
        />
      </section>

      {importDialogOpen ? (
        <ThemeImportDialog
          importing={importingTheme}
          result={importResult}
          onImport={() => void importUiTheme()}
          onClose={() => {
            setImportDialogOpen(false);
            setImportResult(undefined);
          }}
        />
      ) : null}
      {deleteConfirmOpen && selectedCustomTheme ? (
        <ThemeDeleteDialog
          theme={selectedCustomTheme}
          onConfirm={deleteCustomTheme}
          onClose={() => setDeleteConfirmOpen(false)}
        />
      ) : null}
    </div>
  );
}
