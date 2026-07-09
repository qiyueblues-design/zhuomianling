import { CheckCircle2, Palette, Pause, Pencil, Play, Sparkles, Subtitles, Trash2, Volume2, X, XCircle } from "lucide-react";
import { useMemo, useState } from "react";
import type { CSSProperties } from "react";
import type { BuiltInPetUiTheme, LocalPetSaveResult, LocalPetVoiceModelDraft, PetCustomTheme, PetDefinition } from "../../../shared/types/pet";
import type { PetWindowState } from "../../../shared/types/window";
import { Live2DCanvas } from "../../live2d/Live2DCanvas";
import { hasUsableLive2DModel } from "../../pets/petSources";

interface PetStageProps {
  pet: PetDefinition;
  isActive: boolean;
  petWindowState: PetWindowState;
  onActivate: () => void | Promise<void>;
  onDeactivate: () => void | Promise<void>;
  onEditPet: () => void;
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
  if (!theme) {
    return undefined;
  }

  const { tokens } = theme;

  return {
    "--custom-theme-background": tokens.background,
    "--custom-theme-surface": tokens.surface,
    "--custom-theme-text": tokens.text,
    "--custom-theme-muted": tokens.mutedText,
    "--custom-theme-accent": tokens.accent,
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
  onDeletePet,
  onCloseDetails,
  onVoiceConnected
}: PetStageProps): JSX.Element {
  const [voiceConnecting, setVoiceConnecting] = useState(false);
  const [voiceResult, setVoiceResult] = useState<LocalPetSaveResult | undefined>();
  const voiceModelSettings = pet.voiceModelSettings;
  const uiTheme = pet.uiSettings?.theme ?? "soft";
  const uiThemeLabel = uiTheme === "custom"
    ? pet.uiSettings?.customTheme?.name ?? "自定义主题"
    : uiThemeLabels[uiTheme];
  const customThemeStyle = getCustomThemeStyle(pet.uiSettings?.customTheme);
  const hasModel = hasUsableLive2DModel(pet);
  const voiceReadiness = useMemo(() => {
    const hasRootPath = Boolean(voiceModelSettings?.gptSoVitsRootPath?.trim());
    const hasModels = Boolean(voiceModelSettings?.sovitsModelPath && voiceModelSettings.gptModelPath);
    const hasReference = Boolean(
      voiceModelSettings?.referenceAudioPath && voiceModelSettings.referenceText.trim()
    );

    if (!hasRootPath) {
      return { ready: false, text: "未配置本地路径" };
    }

    if (!hasModels) {
      return { ready: false, text: "未选择模型文件" };
    }

    if (!hasReference) {
      return { ready: false, text: "未配置参考音频" };
    }

    return { ready: true, text: voiceModelSettings?.connected ? "已连接" : "可连接" };
  }, [voiceModelSettings]);

  const buildVoiceDraft = (enabled: boolean, connected: boolean): LocalPetVoiceModelDraft | undefined => {
    if (
      !voiceModelSettings?.gptSoVitsRootPath ||
      !voiceModelSettings.sovitsModelPath ||
      !voiceModelSettings.gptModelPath ||
      !voiceModelSettings.referenceAudioPath ||
      !voiceModelSettings.referenceText.trim()
    ) {
      return undefined;
    }

    return {
      petId: pet.id,
      enabled,
      connected,
      gptSoVitsRootPath: voiceModelSettings.gptSoVitsRootPath,
      sovitsModelPath: voiceModelSettings.sovitsModelPath,
      gptModelPath: voiceModelSettings.gptModelPath,
      referenceAudioPath: voiceModelSettings.referenceAudioPath,
      referenceText: voiceModelSettings.referenceText,
      language: voiceModelSettings.language,
      playMode: "sentence",
      inferenceDevice: voiceModelSettings.inferenceDevice ?? "auto",
      halfPrecision: voiceModelSettings.halfPrecision ?? true,
      syncTextWithVoice: voiceModelSettings.syncTextWithVoice ?? false
    };
  };

  const toggleVoiceModel = async (): Promise<void> => {
    const draft = buildVoiceDraft(true, false);

    if (!draft) {
      setVoiceResult({
        ok: false,
        message: "请先在编辑器中配置 GPT-SoVITS 路径、模型文件、参考音频和参考文本。"
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

        if (saveResult?.ok) {
          await onVoiceConnected?.();
        }
        return;
      }

      const connectionResult = await window.desktopPet?.petConfig.testVoiceModelConnection(draft);

      if (!connectionResult?.ok) {
        setVoiceResult({
          ok: false,
          message: connectionResult?.message ?? "声音模型连接失败。"
        });
        return;
      }

      const saveResult = await window.desktopPet?.petConfig.saveVoiceModel({
        ...draft,
        connected: true,
        enabled: true
      });

      setVoiceResult(saveResult);

      if (saveResult?.ok) {
        await onVoiceConnected?.();
      }
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
        <button className="secondaryAction" type="button" onClick={onEditPet}>
          <Pencil size={17} />
          编辑
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
          disabled={!voiceReadiness.ready || voiceConnecting}
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
          <strong>界面主题</strong>
          <small>{uiThemeLabel} · 右键菜单 / 聊天框 / 字幕气泡</small>
        </span>
      </div>

      <div className="petInfoPanel" aria-label={`${pet.name} 详细信息及功能`}>
        <div className="infoHeader">
          <Sparkles size={18} />
          <h3>桌宠详情</h3>
        </div>

        <p className="infoLead">{pet.details.role}</p>
        <p className="infoText">{pet.details.personality}</p>

        <div className="sceneList" aria-label="适合场景">
          {pet.details.scenes.map((scene) => (
            <span className="scenePill" key={scene}>
              {scene}
            </span>
          ))}
        </div>

      </div>
    </section>
  );
}
