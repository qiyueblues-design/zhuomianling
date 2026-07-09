import { FileJson, Upload, X } from "lucide-react";
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

function isSameTheme(
  theme: PetUiTheme,
  customThemeId: string | undefined,
  savedTheme: PetUiTheme,
  savedCustomThemeId: string | undefined
): boolean {
  return theme === savedTheme && (theme !== "custom" || customThemeId === savedCustomThemeId);
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
    <div className="themeImportOverlay" role="dialog" aria-modal="true" aria-label="导入界面主题">
      <div className="themeImportDialog">
        <div className="themeImportHeader">
          <span className="themeImportIcon" aria-hidden="true">
            <FileJson size={20} />
          </span>
          <div>
            <h3>导入界面主题</h3>
            <p>选择一个主题 JSON，导入后会出现在主题列表最前面。</p>
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
              <span>导入后会添加到主题列表，选中后再保存。</span>
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
  const currentCustomThemeId = pet.uiSettings?.customThemeId;
  const [savedTheme, setSavedTheme] = useState<PetUiTheme>(currentTheme);
  const [savedCustomThemeId, setSavedCustomThemeId] = useState<string | undefined>(currentCustomThemeId);
  const [selectedTheme, setSelectedTheme] = useState<PetUiTheme>(currentTheme);
  const [selectedCustomThemeId, setSelectedCustomThemeId] = useState<string | undefined>(currentCustomThemeId);
  const [customThemes, setCustomThemes] = useState<PetCustomTheme[]>([]);
  const [importDialogOpen, setImportDialogOpen] = useState(false);
  const [importingTheme, setImportingTheme] = useState(false);
  const [importResult, setImportResult] = useState<PetCustomThemeImportResult | undefined>();
  const [saving, setSaving] = useState(false);
  const [result, setResult] = useState<LocalPetSaveResult | undefined>();

  const refreshCustomThemes = async (): Promise<PetCustomTheme[]> => {
    const themeResult = await window.desktopPet?.petConfig.listUiThemes();
    const themes = themeResult?.ok ? themeResult.themes : [];
    setCustomThemes(themes);

    return themes;
  };

  useEffect(() => {
    void refreshCustomThemes();
  }, []);

  useEffect(() => {
    const nextTheme = pet.uiSettings?.theme ?? "soft";
    const nextCustomThemeId = pet.uiSettings?.customThemeId;
    setSavedTheme(nextTheme);
    setSavedCustomThemeId(nextCustomThemeId);
    setSelectedTheme(nextTheme);
    setSelectedCustomThemeId(nextCustomThemeId);
    setResult(undefined);
    onDirtyChange(false);
  }, [pet.id, pet.uiSettings?.theme, pet.uiSettings?.customThemeId, onDirtyChange]);

  const themeOptions = useMemo<ThemeCardOption[]>(
    () => [
      ...customThemes.map((theme) => ({
        kind: "custom" as const,
        id: theme.id,
        name: theme.name,
        description: theme.description,
        theme
      })),
      ...uiThemeOptions.map((theme) => ({
        kind: "builtIn" as const,
        ...theme
      }))
    ],
    [customThemes]
  );

  const selectBuiltInTheme = (theme: BuiltInPetUiTheme): void => {
    setSelectedTheme(theme);
    setSelectedCustomThemeId(undefined);
    setResult(undefined);
    onDirtyChange(!isSameTheme(theme, undefined, savedTheme, savedCustomThemeId));
  };

  const selectCustomTheme = (themeId: string): void => {
    setSelectedTheme("custom");
    setSelectedCustomThemeId(themeId);
    setResult(undefined);
    onDirtyChange(!isSameTheme("custom", themeId, savedTheme, savedCustomThemeId));
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
        await refreshCustomThemes();
        selectCustomTheme(nextResult.theme.id);
      }
    } finally {
      setImportingTheme(false);
    }
  };

  const saveUiTheme = async (): Promise<void> => {
    if (pet.id === "new-pet") {
      setResult({
        ok: false,
        message: "请先保存基础信息，再保存界面主题。"
      });
      return;
    }

    setSaving(true);
    setResult(undefined);

    try {
      const saveResult = await window.desktopPet?.petConfig.saveUiSettings({
        petId: pet.id,
        theme: selectedTheme,
        customThemeId: selectedTheme === "custom" ? selectedCustomThemeId : undefined
      });

      if (!saveResult) {
        return;
      }

      setResult(saveResult);

      if (saveResult.ok && saveResult.pet) {
        const nextTheme = saveResult.pet.uiSettings?.theme ?? selectedTheme;
        const nextCustomThemeId = saveResult.pet.uiSettings?.customThemeId;
        setSavedTheme(nextTheme);
        setSavedCustomThemeId(nextCustomThemeId);
        setSelectedTheme(nextTheme);
        setSelectedCustomThemeId(nextCustomThemeId);
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
          <h2>界面主题</h2>
          <p>为当前桌宠选择一套右键菜单、聊天框和字幕气泡的整体外观。</p>
        </div>
        <button className="secondaryAction" type="button" onClick={() => setImportDialogOpen(true)}>
          <Upload size={17} />
          导入主题
        </button>
        <span className="localBadge">按模型保存</span>
      </div>

      <section className="uiThemeSection" aria-label="界面主题">
        <div className="uiThemeGrid">
          {themeOptions.map((theme) => {
            const selected =
              theme.kind === "custom"
                ? selectedTheme === "custom" && selectedCustomThemeId === theme.id
                : selectedTheme === theme.id;

            return (
              <button
                className={selected ? "uiThemeCard selected" : "uiThemeCard"}
                type="button"
                key={`${theme.kind}-${theme.id}`}
                onClick={() => {
                  if (theme.kind === "custom") {
                    selectCustomTheme(theme.id);
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
            );
          })}
        </div>
        <PanelSaveActions
          onSave={() => void saveUiTheme()}
          saving={saving}
          disabled={selectedTheme === "custom" && !selectedCustomThemeId}
          disabledReason="请选择一个已导入的主题。"
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
    </div>
  );
}
