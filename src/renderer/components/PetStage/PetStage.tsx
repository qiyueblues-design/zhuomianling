import { BookHeart, CheckCircle2, Palette, Pause, Pencil, Play, Sparkles, Subtitles, Trash2, Volume2, X, XCircle } from "lucide-react";
import { useState } from "react";
import type { CSSProperties } from "react";
import type { BuiltInPetUiTheme, LocalPetSaveResult, LocalPetVoiceModelDraft, PetCustomTheme, PetDefinition } from "../../../shared/types/pet";
import type { PetWindowState } from "../../../shared/types/window";
import type { ActiveEditorPanel } from "../PetEditor/editorNavigation";
import { Live2DCanvas } from "../../live2d/Live2DCanvas";
import { hasUsableLive2DModel } from "../../pets/petSources";
import { buildVoiceDraft, getVoiceReadiness } from "./petStageState";

interface PetStageProps {
  pet: PetDefinition;
  isActive: boolean;
  petWindowState: PetWindowState;
  onActivate: () => void | Promise<void>;
  onDeactivate: () => void | Promise<void>;
  onEditPet: (initialPanel?: ActiveEditorPanel) => void;
  onOpenMemoryBook: () => void;
  onDeletePet: () => void | Promise<void>;
  onCloseDetails: () => void;
  onVoiceConnected?: () => void | Promise<void>;
}

function getFileName(filePath: string): string {
  return filePath.split(/[\\/]/).pop() ?? filePath;
}

const uiThemeLabels: Record<BuiltInPetUiTheme, string> = {
  soft: "软糖风",
  rock: "摇滚风",
  pixel: "像素风",
  journal: "手账风",
  cyber: "赛博风",
  minimal: "极简风"
};

function getCustomThemeStyle(theme: PetCustomTheme | undefined): CSSProperties | undefined {
  if (!theme?.tokens) {
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
    "--custom-theme-shadow": tokens.shadow ?? "none",
    "--custom-theme-radius": `${tokens.radius ?? 14}px`
  } as CSSProperties;
}

export function PetStage({
  pet,
  isActive,
  petWindowState,
  onActivate,
  onDeactivate,
  onEditPet,
  onOpenMemoryBook,
  onDeletePet,
  onCloseDetails,
  onVoiceConnected
}: PetStageProps): JSX.Element {
  const [voiceConnecting, setVoiceConnecting] = useState(false);
  const [voiceResult, setVoiceResult] = useState<LocalPetSaveResult | undefined>();
  const [voiceNotice, setVoiceNotice] = useState<{
    title: string;
    message: string;
    showSettingsAction: boolean;
  } | undefined>();
  const voiceModelSettings = pet.voiceModelSettings;
  const uiTheme = pet.uiSettings?.theme ?? "soft";
  const uiThemeLabel = uiTheme === "custom"
    ? pet.uiSettings?.customTheme?.name ?? "自定义主题"
    : uiThemeLabels[uiTheme];
  const customThemeStyle = getCustomThemeStyle(pet.uiSettings?.customTheme);
  const hasModel = hasUsableLive2DModel(pet);
  const detailRole = pet.details?.role?.trim() || "尚未填写角色定位";
  const detailPersonality = pet.details?.personality?.trim() || "尚未填写性格说明";
  const detailScenes = Array.isArray(pet.details?.scenes) ? pet.details.scenes : [];
  const voiceReadiness = getVoiceReadiness(voiceModelSettings);

  const toggleVoiceModel = async (): Promise<void> => {
    if (voiceReadiness.issue) {
      setVoiceNotice({
        title: "声音模型配置不完整",
        message: `${voiceReadiness.issue.summary}。${voiceReadiness.issue.guidance}`,
        showSettingsAction: true
      });
      return;
    }

    const draft: LocalPetVoiceModelDraft | undefined = buildVoiceDraft(
      pet.id,
      voiceModelSettings,
      true,
      false
    );

    if (!draft) {
      setVoiceNotice({
        title: "声音模型配置不完整",
        message: "请前往“编辑 → 对话 → 声音模型”检查运行环境、模型文件、参考音频和参考文本。",
        showSettingsAction: true
      });
      return;
    }

    setVoiceConnecting(true);

    try {
      if (voiceModelSettings?.connected) {
        await window.desktopPet?.petConfig.disconnectVoiceModel();
        const saveResult = await window.desktopPet?.petConfig.saveVoiceModel({
          ...draft,
          connected: false,
          enabled: false
        });

        setVoiceResult(saveResult);

        if (saveResult && !saveResult.ok) {
          setVoiceNotice({
            title: "声音模型设置未保存",
            message: saveResult.message,
            showSettingsAction: true
          });
        }

        if (saveResult?.ok) {
          await onVoiceConnected?.();
        }
        return;
      }

      const connectionResult = await window.desktopPet?.petConfig.testVoiceModelConnection(draft);

      if (!connectionResult?.ok) {
        setVoiceNotice({
          title: "声音模型连接失败",
          message: connectionResult?.message ?? "本地声音服务没有成功连接，请检查声音模型设置。",
          showSettingsAction: true
        });
        return;
      }

      const saveResult = await window.desktopPet?.petConfig.saveVoiceModel({
        ...draft,
        connected: true,
        enabled: true
      });

      setVoiceResult(saveResult);

      if (saveResult && !saveResult.ok) {
        setVoiceNotice({
          title: "声音模型设置未保存",
          message: saveResult.message,
          showSettingsAction: true
        });
      }

      if (saveResult?.ok) {
        await onVoiceConnected?.();
      }
    } catch {
      setVoiceNotice({
        title: "声音模型暂时不可用",
        message: "声音功能运行时发生异常。请前往“编辑 → 对话 → 声音模型”检查配置后重试。",
        showSettingsAction: true
      });
    } finally {
      setVoiceConnecting(false);
    }
  };

  return (
    <section className="stagePane" aria-label="桌宠显示">
      <div className="stageToolbar">
        <div>
          <p className="eyebrow">Current Pet</p>
          <h2>{pet.name}</h2>
        </div>
        <div className="toolbarActions">
          <button
            className="iconButton"
            type="button"
            title="关闭详情"
            aria-label="关闭详情"
            onClick={onCloseDetails}
          >
            <X size={18} />
          </button>
        </div>
      </div>

      <div className="stageSurface">
        {hasModel ? (
          <div className="stageLive2dPreview" aria-label={`${pet.name} Live2D 正面预览`}>
            <Live2DCanvas
              key={`${pet.id}-${pet.modelPath}-${pet.live2dSettings?.format ?? "auto"}`}
              modelPath={pet.modelPath}
              fallbackText={pet.avatar ?? pet.name.slice(0, 2).toUpperCase()}
              expressions={pet.expressions}
              expressionEffects={pet.expressionEffects}
              neutralPreview
              fitMode="previewContain"
            />
          </div>
        ) : (
          <div className="stageModelPlaceholder" aria-label={`${pet.name} 尚未导入 Live2D 模型`}>
            <span className="stageModelAvatar">
              {pet.avatarImage ? <img src={pet.avatarImage} alt="" /> : <span>{pet.avatar ?? pet.name.slice(0, 2).toUpperCase()}</span>}
            </span>
            <strong>待导入 Live2D 模型</strong>
            <small>进入编辑器选择模型文件夹后即可启用桌宠。</small>
          </div>
        )}
        <div className="subtitlePreview">
          <Subtitles size={18} />
          <span>
            {!hasModel
              ? `${pet.name} 待导入模型`
              : isActive && petWindowState.visible
              ? `${pet.name} 正在桌面显示`
              : `${pet.name} 待启用`}
          </span>
        </div>
      </div>

      <div className="stageActions">
        <button
          className={isActive ? "primaryAction danger" : "primaryAction"}
          type="button"
          onClick={() => void (hasModel ? (isActive ? onDeactivate() : onActivate()) : onEditPet())}
        >
          {isActive ? <Pause size={18} /> : hasModel ? <Play size={18} /> : <Pencil size={18} />}
          {isActive ? "关闭桌宠" : hasModel ? "启用桌宠" : "导入模型"}
        </button>
        <button className="secondaryAction" type="button" onClick={() => onEditPet()}>
          <Pencil size={17} />
          编辑
        </button>
        <button className="secondaryAction memoryStageAction" type="button" onClick={onOpenMemoryBook}>
          <BookHeart size={17} />
          记忆书
        </button>
        <button
          className={
            voiceModelSettings?.connected
              ? "secondaryAction voiceStageAction connected"
              : voiceReadiness.ready
                ? "secondaryAction voiceStageAction ready"
                : "secondaryAction voiceStageAction"
          }
          type="button"
          disabled={voiceConnecting}
          onClick={() => void toggleVoiceModel()}
        >
          <Volume2 size={17} />
          {voiceConnecting ? "处理中" : voiceModelSettings?.connected ? "关闭声音" : "声音模型"}
        </button>
        <button className="secondaryAction dangerText" type="button" onClick={() => void onDeletePet()}>
          <Trash2 size={17} />
          删除
        </button>
      </div>

      <div className={voiceReadiness.ready ? "stageVoiceSummary ready" : "stageVoiceSummary"}>
        <Volume2 size={17} />
        <span>
          <strong>声音模型</strong>
          <small>
            {voiceReadiness.text}
            {voiceModelSettings?.sovitsModelPath ? ` · ${getFileName(voiceModelSettings.sovitsModelPath)}` : ""}
            {voiceModelSettings?.referenceAudioPath ? ` · ${getFileName(voiceModelSettings.referenceAudioPath)}` : ""}
          </small>
        </span>
        {voiceResult ? (
          <em className={voiceResult.ok ? "ok" : "error"}>
            {voiceResult.ok ? <CheckCircle2 size={14} /> : <XCircle size={14} />}
            {voiceResult.message}
          </em>
        ) : null}
      </div>

      <div className={`stageThemeSummary theme-${uiTheme}`} style={customThemeStyle}>
        <Palette size={17} />
        <span>
          <strong>主题风格</strong>
          <small>{uiThemeLabel} · 右键菜单 / 聊天框 / 字幕气泡</small>
        </span>
      </div>

      <div className="petInfoPanel" aria-label={`${pet.name} 详细信息及功能`}>
        <div className="infoHeader">
          <Sparkles size={18} />
          <h3>桌宠详情</h3>
        </div>

        <p className="infoLead">{detailRole}</p>
        <p className="infoText">{detailPersonality}</p>

        <div className="sceneList" aria-label="适合场景">
          {detailScenes.map((scene) => (
            <span className="scenePill" key={scene}>
              {scene}
            </span>
          ))}
        </div>

      </div>

      {voiceNotice ? (
        <div className="stageNoticeBackdrop" role="presentation">
          <div className="stageNoticeDialog" role="dialog" aria-modal="true" aria-label={voiceNotice.title}>
            <span className="stageNoticeIcon" aria-hidden="true">
              <Volume2 size={21} />
            </span>
            <div className="stageNoticeCopy">
              <h3>{voiceNotice.title}</h3>
              <p>{voiceNotice.message}</p>
            </div>
            <div className="stageNoticeActions">
              <button className="secondaryAction" type="button" onClick={() => setVoiceNotice(undefined)}>
                知道了
              </button>
              {voiceNotice.showSettingsAction ? (
                <button className="primaryAction" type="button" onClick={() => onEditPet("voiceReply")}>
                  去声音模型设置
                </button>
              ) : null}
            </div>
          </div>
        </div>
      ) : null}
    </section>
  );
}
