import { Plus, X } from "lucide-react";
import { useEffect, useState, type PointerEvent, type WheelEvent } from "react";
import type { LocalPetBasicInfoDraft, LocalPetSaveResult, PetDefinition } from "../../../shared/types/pet";
import { PanelSaveActions } from "./EditorShared";
import { commonSceneTags } from "./editorNavigation";
import {
  createBasicInfoDraft,
  normalizeBasicInfoDraft
} from "./petEditorDrafts";

interface AvatarCropState {
  sourceImage: string;
  naturalWidth: number;
  naturalHeight: number;
  x: number;
  y: number;
  size: number;
}

interface AvatarCropDragState {
  pointerId: number;
  startClientX: number;
  startClientY: number;
  startX: number;
  startY: number;
}

export function BasicPanel({
  pet,
  onSavedPet,
  onDirtyChange
}: {
  pet: PetDefinition;
  onSavedPet?: (pet: PetDefinition) => void;
  onDirtyChange: (dirty: boolean) => void;
}): JSX.Element {
  const [savedDraft, setSavedDraft] = useState<LocalPetBasicInfoDraft>(() => createBasicInfoDraft(pet));
  const [draft, setDraft] = useState<LocalPetBasicInfoDraft>(() => createBasicInfoDraft(pet));
  const [customScene, setCustomScene] = useState("");
  const [saving, setSaving] = useState(false);
  const [result, setResult] = useState<LocalPetSaveResult | undefined>();
  const [cropState, setCropState] = useState<AvatarCropState | undefined>();
  const [previewAvatarImage, setPreviewAvatarImage] = useState<string | undefined>();
  const [transientAvatarImage, setTransientAvatarImage] = useState<string | undefined>();
  const displayedAvatarImage = transientAvatarImage ?? draft.avatarImage;

  const updateDraft = (field: keyof LocalPetBasicInfoDraft, value: string | string[]): void => {
    setResult(undefined);
    setDraft((currentDraft) => {
      const nextDraft = {
        ...currentDraft,
        [field]: value
      };

      onDirtyChange(normalizeBasicInfoDraft(nextDraft) !== normalizeBasicInfoDraft(savedDraft));

      return nextDraft;
    });
  };

  const toggleScene = (scene: string): void => {
    setResult(undefined);
    setDraft((currentDraft) => {
      const exists = currentDraft.scenes.includes(scene);

      const nextDraft = {
        ...currentDraft,
        scenes: exists
          ? currentDraft.scenes.filter((currentScene) => currentScene !== scene)
          : [...currentDraft.scenes, scene]
      };

      onDirtyChange(normalizeBasicInfoDraft(nextDraft) !== normalizeBasicInfoDraft(savedDraft));

      return nextDraft;
    });
  };

  const addCustomScene = (): void => {
    const nextScene = customScene.trim();

    if (!nextScene) {
      return;
    }

    setDraft((currentDraft) => {
      const nextDraft = {
        ...currentDraft,
        scenes: currentDraft.scenes.includes(nextScene)
          ? currentDraft.scenes
          : [...currentDraft.scenes, nextScene]
      };

      onDirtyChange(normalizeBasicInfoDraft(nextDraft) !== normalizeBasicInfoDraft(savedDraft));

      return nextDraft;
    });
    setCustomScene("");
    setResult(undefined);
  };

  const importAvatar = async (): Promise<void> => {
    const importResult = await window.desktopPet?.petConfig.importAvatar(draft.id);

    if (!importResult) {
      return;
    }

    if (importResult.ok && importResult.sourceImage) {
      const image = new window.Image();

      image.onload = () => {
        const size = Math.min(image.naturalWidth, image.naturalHeight);
        setCropState({
          sourceImage: importResult.sourceImage ?? "",
          naturalWidth: image.naturalWidth,
          naturalHeight: image.naturalHeight,
          x: Math.round((image.naturalWidth - size) / 2),
          y: Math.round((image.naturalHeight - size) / 2),
          size
        });
      };
      image.onerror = () => {
        setResult({
          ok: false,
          message: "图片加载失败，请换一张头像。"
        });
      };
      image.src = importResult.sourceImage;
      return;
    }

    setResult({
      ok: false,
      message: importResult.message
    });
  };

  const saveAvatarCrop = async (dataUrl: string): Promise<void> => {
    setTransientAvatarImage(dataUrl);
    setResult(undefined);

    const cropResult = await window.desktopPet?.petConfig.saveAvatarCrop({
      petId: draft.id,
      dataUrl
    });

    if (!cropResult) {
      setTransientAvatarImage(undefined);
      return;
    }

    if (cropResult.ok && cropResult.avatarImage) {
      updateDraft("avatarImage", cropResult.avatarImage);
      setCropState(undefined);
      return;
    }

    setResult({
      ok: false,
      message: cropResult.message
    });
    setTransientAvatarImage(undefined);
  };

  const saveBasicInfo = async (): Promise<void> => {
    setSaving(true);

    try {
      const saveResult = await window.desktopPet?.petConfig.saveBasicInfo(draft);

      if (!saveResult) {
        return;
      }

      setResult(saveResult);

      if (saveResult.ok && saveResult.pet) {
        const nextSavedDraft = createBasicInfoDraft(saveResult.pet);
        setSavedDraft(nextSavedDraft);
        setDraft(nextSavedDraft);
        setTransientAvatarImage(undefined);
        onDirtyChange(false);
        onSavedPet?.(saveResult.pet);
      }
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="editorPanel basicInfoPanel">
      <div className="panelTitleRow">
        <div>
          <h2>基础信息</h2>
          <p>这些信息会显示在桌宠选择器和详情区。</p>
        </div>
      </div>

      <div className="basicEditorLayout">
        <div className="avatarEditorColumn">
          <button
            className="avatarPickerFrame"
            type="button"
            aria-label={displayedAvatarImage ? "预览头像" : "选择头像"}
            title={displayedAvatarImage ? "预览头像" : "选择头像"}
            onClick={() => {
              if (displayedAvatarImage) {
                setPreviewAvatarImage(displayedAvatarImage);
                return;
              }

              void importAvatar();
            }}
          >
            {displayedAvatarImage ? (
              <img src={displayedAvatarImage} alt="" />
            ) : (
              <span className="avatarPickerPlaceholder">
                <Plus size={24} />
              </span>
            )}
          </button>
          <p className="avatarFormatHint">支持 PNG、JPG、JPEG、WebP</p>
          {displayedAvatarImage ? (
            <button className="avatarChangeButton" type="button" onClick={() => void importAvatar()}>
              修改头像
            </button>
          ) : null}
          <label className="formField avatarNameField">
            <span>名称</span>
            <input
              value={draft.name}
              onChange={(event) => updateDraft("name", event.target.value)}
              placeholder="给桌宠起个名字"
            />
          </label>
        </div>

        <div className="formGrid basicTextFields">
          <label className="formField">
            <span>简介</span>
            <textarea
              rows={2}
              value={draft.description}
              onChange={(event) => updateDraft("description", event.target.value)}
              placeholder="非必填。一句话介绍这个桌宠，例如：安静陪你学习的猫耳桌宠。"
            />
          </label>
          <label className="formField">
            <span>角色定位</span>
            <textarea
              rows={2}
              value={draft.role}
              onChange={(event) => updateDraft("role", event.target.value)}
              placeholder="非必填。描述它在桌面上的身份和用途，例如：学习陪伴、工作提醒、聊天伙伴。"
            />
          </label>
          <label className="formField">
            <span>性格描述</span>
            <textarea
              rows={2}
              value={draft.personality}
              onChange={(event) => updateDraft("personality", event.target.value)}
              placeholder="非必填。写下它的说话风格、情绪特点和互动方式，例如：温柔、容易害羞、会小声鼓励用户。"
            />
          </label>
        </div>
      </div>

      <div className="sceneList editorSceneList" aria-label="适合场景">
        {commonSceneTags.map((scene) => (
          <button
            className={draft.scenes.includes(scene) ? "scenePill selected" : "scenePill"}
            type="button"
            key={scene}
            onClick={() => toggleScene(scene)}
          >
            {scene}
          </button>
        ))}
        {draft.scenes
          .filter((scene) => !commonSceneTags.includes(scene))
          .map((scene) => (
            <button
              className="scenePill selected"
              type="button"
              key={scene}
              onClick={() => toggleScene(scene)}
            >
              {scene}
            </button>
          ))}
        <div className="customSceneControl">
          <input
            value={customScene}
            onChange={(event) => setCustomScene(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                addCustomScene();
              }
            }}
            placeholder="自定义标签"
          />
          <button className="pillAddButton" type="button" onClick={addCustomScene}>
            <Plus size={14} />
            添加场景
          </button>
        </div>
      </div>

      <PanelSaveActions
        onSave={() => void saveBasicInfo()}
        saving={saving}
        result={result}
        saved={Boolean(result?.ok)}
      />

      {cropState ? (
        <AvatarCropModal
          cropState={cropState}
          onCancel={() => setCropState(undefined)}
          onConfirm={(dataUrl) => void saveAvatarCrop(dataUrl)}
        />
      ) : null}

      {previewAvatarImage ? (
        <AvatarPreviewModal
          image={previewAvatarImage}
          name={draft.name || pet.name || "桌宠"}
          onClose={() => setPreviewAvatarImage(undefined)}
        />
      ) : null}
    </div>
  );
}

function AvatarPreviewModal({
  image,
  name,
  onClose
}: {
  image: string;
  name: string;
  onClose: () => void;
}): JSX.Element {
  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        onClose();
      }
    };

    window.addEventListener("keydown", closeOnEscape);

    return () => {
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [onClose]);

  return (
    <div className="avatarPreviewOverlay" role="dialog" aria-modal="true" aria-label="预览头像" onClick={onClose}>
      <div className="avatarPreviewDialog" onClick={(event) => event.stopPropagation()}>
        <div className="avatarPreviewHeader">
          <div>
            <h2>头像预览</h2>
            <p>{name}</p>
          </div>
          <button className="iconButton" type="button" title="关闭预览" aria-label="关闭预览" onClick={onClose}>
            <X size={17} />
          </button>
        </div>
        <div className="avatarPreviewImageFrame">
          <img src={image} alt={`${name} 头像预览`} />
        </div>
      </div>
    </div>
  );
}

function AvatarCropModal({
  cropState: initialCropState,
  onCancel,
  onConfirm
}: {
  cropState: AvatarCropState;
  onCancel: () => void;
  onConfirm: (dataUrl: string) => void;
}): JSX.Element {
  const [cropState, setCropState] = useState<AvatarCropState>(initialCropState);
  const [dragState, setDragState] = useState<AvatarCropDragState | undefined>();
  const previewSize = Math.round(
    Math.min(320, Math.max(240, Math.min(window.innerWidth - 160, window.innerHeight - 210)))
  );
  const scale = previewSize / Math.max(cropState.naturalWidth, cropState.naturalHeight);
  const imageWidth = Math.round(cropState.naturalWidth * scale);
  const imageHeight = Math.round(cropState.naturalHeight * scale);
  const frameLeft = Math.round(cropState.x * scale);
  const frameTop = Math.round(cropState.y * scale);
  const frameSize = Math.round(cropState.size * scale);
  const minSize = Math.max(32, Math.floor(Math.min(cropState.naturalWidth, cropState.naturalHeight) * 0.18));

  const updateCrop = (partialState: Partial<AvatarCropState>): void => {
    setCropState((currentState) => {
      const nextState = {
        ...currentState,
        ...partialState
      };
      const size = Math.min(
        Math.max(nextState.size, minSize),
        Math.min(nextState.naturalWidth, nextState.naturalHeight)
      );
      const x = Math.min(Math.max(nextState.x, 0), Math.max(0, nextState.naturalWidth - size));
      const y = Math.min(Math.max(nextState.y, 0), Math.max(0, nextState.naturalHeight - size));

      return {
        ...nextState,
        x,
        y,
        size
      };
    });
  };

  const moveCrop = (event: PointerEvent<HTMLDivElement>): void => {
    if (!dragState || event.pointerId !== dragState.pointerId) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    updateCrop({
      x: Math.round(dragState.startX + (event.clientX - dragState.startClientX) / scale),
      y: Math.round(dragState.startY + (event.clientY - dragState.startClientY) / scale)
    });
  };

  const endCropDrag = (event: PointerEvent<HTMLDivElement>): void => {
    if (!dragState || event.pointerId !== dragState.pointerId) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    setDragState(undefined);
  };

  const zoomCrop = (event: WheelEvent<HTMLDivElement>): void => {
    event.preventDefault();
    event.stopPropagation();

    const delta = event.deltaY > 0 ? 1.08 : 0.92;
    const nextSize = Math.round(cropState.size * delta);
    const centerX = cropState.x + cropState.size / 2;
    const centerY = cropState.y + cropState.size / 2;

    updateCrop({
      size: nextSize,
      x: Math.round(centerX - nextSize / 2),
      y: Math.round(centerY - nextSize / 2)
    });
  };

  const confirmCrop = async (): Promise<void> => {
    const image = new window.Image();

    image.onload = () => {
      const canvas = document.createElement("canvas");
      const outputSize = 512;
      const context = canvas.getContext("2d");

      if (!context) {
        return;
      }

      canvas.width = outputSize;
      canvas.height = outputSize;
      context.drawImage(
        image,
        cropState.x,
        cropState.y,
        cropState.size,
        cropState.size,
        0,
        0,
        outputSize,
        outputSize
      );
      onConfirm(canvas.toDataURL("image/png"));
    };
    image.src = cropState.sourceImage;
  };

  return (
    <div className="cropOverlay" role="dialog" aria-modal="true" aria-label="裁剪头像">
      <div className="cropPanel">
        <div className="panelTitleRow">
          <div>
            <h2>裁剪头像</h2>
            <p>按住拖动移动裁剪区域，滚轮缩放大小。</p>
          </div>
        </div>

        <div
          className="cropPreviewStage"
          style={{ width: previewSize, height: previewSize }}
          onPointerMove={moveCrop}
          onPointerUp={endCropDrag}
          onPointerCancel={endCropDrag}
          onWheel={zoomCrop}
        >
          <div className="cropImageBounds" style={{ width: imageWidth, height: imageHeight }}>
            <img src={cropState.sourceImage} alt="" draggable={false} />
            <div
              className="cropFrame"
              style={{
                transform: `translate(${frameLeft}px, ${frameTop}px)`,
                width: frameSize,
                height: frameSize
              }}
              onPointerDown={(event) => {
                event.preventDefault();
                event.stopPropagation();
                event.currentTarget.setPointerCapture(event.pointerId);
                setDragState({
                  pointerId: event.pointerId,
                  startClientX: event.clientX,
                  startClientY: event.clientY,
                  startX: cropState.x,
                  startY: cropState.y
                });
              }}
            />
          </div>
        </div>

        <p className="cropHint">拖动蓝色方框调整位置，滚动鼠标滚轮调整方框大小。</p>

        <div className="settingsActions">
          <button className="secondaryAction" type="button" onClick={onCancel}>
            取消
          </button>
          <button className="primaryAction" type="button" onClick={() => void confirmCrop()}>
            保存头像
          </button>
        </div>
      </div>
    </div>
  );
}
