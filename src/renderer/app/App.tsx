import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, FolderOpen, MousePointer2, Plus, Sparkles, Trash2 } from "lucide-react";
import type { PetDefinition } from "../../shared/types/pet";
import type { PetWindowState } from "../../shared/types/window";
import { PetEditor } from "../components/PetEditor/PetEditor";
import { PetSelector } from "../components/PetSelector/PetSelector";
import { PetStage } from "../components/PetStage/PetStage";
import { StartupSplash } from "../components/StartupSplash/StartupSplash";
import { hasUsableLive2DModel, loadAvailablePets } from "../pets/petSources";

type AppView = "selector" | "editor";

const MIN_STARTUP_SPLASH_MS = 2000;
const STARTUP_SPLASH_EXIT_MS = 360;
const HOME_ICON_SRC = "./icons/home-icon.jpg";

interface EditorPageOptions {
  mode?: "create" | "edit";
  petId?: string;
}

function DeletePetDialog({
  pet,
  step,
  deleting,
  onCancel,
  onContinue,
  onConfirm
}: {
  pet: PetDefinition;
  step: 1 | 2;
  deleting: boolean;
  onCancel: () => void;
  onContinue: () => void;
  onConfirm: () => void | Promise<void>;
}): JSX.Element {
  const finalStep = step === 2;

  return (
    <div className="unsavedOverlay" role="dialog" aria-modal="true" aria-label={`删除 ${pet.name}`}>
      <div className="unsavedDialog deletePetDialog">
        <span className="unsavedIcon deletePetIcon" aria-hidden="true">
          {finalStep ? <AlertTriangle size={22} /> : <Trash2 size={21} />}
        </span>
        <div className="unsavedText deletePetText">
          <h2>{finalStep ? "最后确认删除" : "删除这只桌宠？"}</h2>
          <p>
            {finalStep
              ? "删除后会清理它的本地配置、头像和已导入资源，无法从软件内恢复。"
              : "这会移除这只本地桌宠和它关联的本机配置。"}
          </p>
          <strong className="deletePetName">{pet.name}</strong>
        </div>
        <div className="unsavedActions">
          <button className="secondaryAction" type="button" disabled={deleting} onClick={onCancel}>
            取消
          </button>
          <button
            className={finalStep ? "primaryAction danger" : "secondaryAction danger"}
            type="button"
            disabled={deleting}
            onClick={() => {
              if (finalStep) {
                void onConfirm();
                return;
              }

              onContinue();
            }}
          >
            {deleting ? "删除中" : finalStep ? "确认删除" : "继续"}
          </button>
        </div>
      </div>
    </div>
  );
}

function SelectorGuideStage({
  hasPets,
  onCreatePet
}: {
  hasPets: boolean;
  onCreatePet: () => void;
}): JSX.Element {
  return (
    <section className="stagePane selectorGuideStage" aria-label={hasPets ? "桌宠详情占位" : "创建桌宠"}>
      <div className="selectorGuideVisual" aria-hidden="true">
        <span className="selectorGuideScreen">
          <Sparkles size={24} />
        </span>
        <span className="selectorGuidePet">
          {hasPets ? <MousePointer2 size={24} /> : <Plus size={26} />}
        </span>
      </div>

      <div className="selectorGuideCopy">
        <h2>{hasPets ? "选择一只桌宠" : "还没有桌宠"}</h2>
        <p>
          {hasPets
            ? "点选左侧列表后，这里会显示预览、启用状态和编辑入口。"
            : "创建后可以导入 Live2D 模型，并为它配置对话、表现和声音。"}
        </p>
      </div>

      <div className="selectorGuideActions">
        {hasPets ? (
          <span className="selectorGuideHint">
            <FolderOpen size={16} />
            等待选择
          </span>
        ) : null}
        <button className="primaryAction" type="button" onClick={onCreatePet}>
          <Plus size={17} />
          {hasPets ? "创建新桌宠" : "创建第一只桌宠"}
        </button>
      </div>
    </section>
  );
}

const createBlankPetDraft = (): PetDefinition => ({
  id: "new-pet",
  name: "",
  description: "",
  modelPath: "",
  avatar: "",
  personaPrompt: "",
  capabilities: {
    chat: false,
    voiceOutput: false,
    subtitles: true
  },
  details: {
    role: "",
    personality: "",
    scenes: [],
    features: []
  },
  expressions: {},
  expressionDescriptions: {},
  uiSettings: {
    theme: "soft"
  },
  lines: {},
  subtitleStyle: {
    tone: "soft"
  }
});

export function App(): JSX.Element {
  const [availablePets, setAvailablePets] = useState<PetDefinition[]>([]);
  const [selectedPetId, setSelectedPetId] = useState<string | undefined>();
  const [activePetId, setActivePetId] = useState<string | undefined>();
  const [currentView, setCurrentView] = useState<AppView>("selector");
  const [editorOptions, setEditorOptions] = useState<EditorPageOptions>({});
  const [isStartupSplashVisible, setIsStartupSplashVisible] = useState(true);
  const [isStartupSplashLeaving, setIsStartupSplashLeaving] = useState(false);
  const [hasInitialPetsLoaded, setHasInitialPetsLoaded] = useState(false);
  const [hasMainWindowBeenShown, setHasMainWindowBeenShown] = useState(() => !window.desktopPet?.appWindow);
  const [hasStartupSurfaceReady, setHasStartupSurfaceReady] = useState(
    () => !window.desktopPet?.appWindow || window.__desktopPetStartupSurfaceReady === true
  );
  const [toastText, setToastText] = useState<string | undefined>();
  const [deleteTargetPet, setDeleteTargetPet] = useState<PetDefinition | undefined>();
  const [deleteConfirmStep, setDeleteConfirmStep] = useState<1 | 2>(1);
  const [deletingPet, setDeletingPet] = useState(false);
  const [petWindowState, setPetWindowState] = useState<PetWindowState>({
    visible: false,
    clickThrough: false
  });
  const currentViewRef = useRef<AppView>(currentView);

  useEffect(() => {
    currentViewRef.current = currentView;
  }, [currentView]);

  const selectedPet = useMemo<PetDefinition | undefined>(() => {
    return availablePets.find((pet) => pet.id === selectedPetId);
  }, [availablePets, selectedPetId]);

  const refreshPets = useCallback(async (): Promise<void> => {
    setAvailablePets(await loadAvailablePets());
  }, []);

  useEffect(() => {
    let isMounted = true;

    const loadInitialPets = async (): Promise<void> => {
      try {
        await refreshPets();
      } catch (error) {
        console.error("Failed to load desktop pets on startup.", error);
      } finally {
        if (isMounted) {
          setHasInitialPetsLoaded(true);
        }
      }
    };

    void loadInitialPets();

    const handleFocus = (): void => {
      if (currentViewRef.current === "editor") {
        return;
      }

      void refreshPets();
    };
    const unsubscribePetConfig = window.desktopPet?.petConfig.onChanged(() => {
      if (currentViewRef.current === "editor") {
        return;
      }

      void refreshPets();
    });

    window.addEventListener("focus", handleFocus);

    return () => {
      isMounted = false;
      window.removeEventListener("focus", handleFocus);
      unsubscribePetConfig?.();
    };
  }, [refreshPets]);

  useEffect(() => {
    const markWindowShown = (): void => {
      setHasMainWindowBeenShown(true);
    };

    if (!window.desktopPet?.appWindow) {
      markWindowShown();
      return;
    }

    const unsubscribeShown = window.desktopPet.appWindow.onShown(markWindowShown);

    void window.desktopPet.appWindow
      .isShown()
      .then((isShown) => {
        if (isShown) {
          markWindowShown();
        }
      })
      .catch((error) => {
        console.error("Failed to read main window visibility.", error);
        markWindowShown();
      });

    return () => {
      unsubscribeShown();
    };
  }, []);

  useEffect(() => {
    if (hasStartupSurfaceReady) {
      return;
    }

    const setStartupSurfaceReadyState = (): void => {
      setHasStartupSurfaceReady(true);
    };

    if (window.__desktopPetStartupSurfaceReady === true) {
      setStartupSurfaceReadyState();
      return;
    }

    const fallbackTimer = window.setTimeout(() => {
      setStartupSurfaceReadyState();
    }, 3000);

    window.addEventListener("desktop-pet-startup-surface-ready", setStartupSurfaceReadyState, {
      once: true
    });

    return () => {
      window.clearTimeout(fallbackTimer);
      window.removeEventListener("desktop-pet-startup-surface-ready", setStartupSurfaceReadyState);
    };
  }, [hasStartupSurfaceReady]);

  useEffect(() => {
    if (
      !isStartupSplashVisible ||
      isStartupSplashLeaving ||
      !hasInitialPetsLoaded ||
      !hasMainWindowBeenShown ||
      !hasStartupSurfaceReady
    ) {
      return;
    }

    const splashTimer = window.setTimeout(() => {
      setIsStartupSplashLeaving(true);
    }, MIN_STARTUP_SPLASH_MS);

    return () => {
      window.clearTimeout(splashTimer);
    };
  }, [
    hasInitialPetsLoaded,
    hasMainWindowBeenShown,
    hasStartupSurfaceReady,
    isStartupSplashLeaving,
    isStartupSplashVisible
  ]);

  useEffect(() => {
    if (!isStartupSplashLeaving) {
      return;
    }

    const splashExitTimer = window.setTimeout(() => {
      setIsStartupSplashVisible(false);
    }, STARTUP_SPLASH_EXIT_MS);

    return () => {
      window.clearTimeout(splashExitTimer);
    };
  }, [isStartupSplashLeaving]);

  useEffect(() => {
    return window.desktopPet?.petWindow.onStateChanged((nextState) => {
      setPetWindowState(nextState);

      if (!nextState.visible) {
        setActivePetId(undefined);
      }
    });
  }, []);

  useEffect(() => {
    if (!toastText) {
      return;
    }

    const timer = window.setTimeout(() => {
      setToastText(undefined);
    }, 1800);

    return () => {
      window.clearTimeout(timer);
    };
  }, [toastText]);

  const blankPetDraft = useMemo(createBlankPetDraft, []);
  const isCreateMode = currentView === "editor" && editorOptions.mode === "create";
  const editorPets = useMemo(() => {
    return isCreateMode ? [blankPetDraft, ...availablePets] : availablePets;
  }, [availablePets, blankPetDraft, isCreateMode]);
  const editorSelectedPetId = useMemo(() => {
    if (isCreateMode) {
      return blankPetDraft.id;
    }

    if (editorOptions.petId && availablePets.some((pet) => pet.id === editorOptions.petId)) {
      return editorOptions.petId;
    }

    return availablePets[0]?.id ?? "";
  }, [availablePets, blankPetDraft.id, editorOptions.petId, isCreateMode]);

  const openEditorPage = (options: EditorPageOptions): void => {
    setEditorOptions(options);
    setCurrentView("editor");
  };

  const closeEditorPage = (): void => {
    setCurrentView("selector");
    setEditorOptions({});
    void refreshPets();
  };

  const handleEditorSavedPet = (pet: PetDefinition): void => {
    setAvailablePets((currentPets) => {
      const withoutSaved = currentPets.filter((currentPet) => currentPet.id !== pet.id);

      return [pet, ...withoutSaved];
    });
    setSelectedPetId(pet.id);
    setEditorOptions({ mode: "edit", petId: pet.id });
  };

  const activatePet = async (petId: string): Promise<void> => {
    const targetPet = availablePets.find((pet) => pet.id === petId);

    if (!targetPet) {
      return;
    }

    setSelectedPetId(petId);

    if (!hasUsableLive2DModel(targetPet)) {
      setActivePetId(undefined);
      setToastText("请先导入 Live2D 模型。");
      return;
    }

    setActivePetId(petId);

    const nextState = await window.desktopPet?.petWindow.show({
      id: targetPet.id,
      name: targetPet.name,
      modelPath: targetPet.modelPath,
      avatar: targetPet.avatar,
      definition: targetPet
    });

    if (nextState) {
      setPetWindowState(nextState);
    }

    setToastText(`${targetPet.name} 已上线`);
  };

  const deactivatePet = async (): Promise<void> => {
    setActivePetId(undefined);
    const nextState = await window.desktopPet?.petWindow.close();

    if (nextState) {
      setPetWindowState(nextState);
    }
  };

  const togglePet = async (petId: string): Promise<void> => {
    if (activePetId === petId) {
      await deactivatePet();
      return;
    }

    await activatePet(petId);
  };

  const deletePet = async (pet: PetDefinition): Promise<void> => {
    if (!pet.isLocal) {
      setToastText("只能删除本地桌宠");
      return;
    }

    setDeleteTargetPet(pet);
    setDeleteConfirmStep(1);
  };

  const confirmDeletePet = async (): Promise<void> => {
    const pet = deleteTargetPet;

    if (!pet || deletingPet) {
      return;
    }

    setDeletingPet(true);
    if (activePetId === pet.id) {
      await deactivatePet();
    }

    const result = await window.desktopPet?.petConfig.delete(pet.id);

    if (!result) {
      setDeletingPet(false);
      return;
    }

    setToastText(result.message);
    setDeletingPet(false);
    setDeleteTargetPet(undefined);
    setDeleteConfirmStep(1);

    if (result.ok) {
      setSelectedPetId(undefined);
      await refreshPets();
    }
  };

  if (currentView === "editor") {
    return (
      <main className="appShell editorViewShell">
        <PetEditor
          pets={editorPets}
          selectedPetId={editorSelectedPetId}
          onSavedPet={handleEditorSavedPet}
          onBack={closeEditorPage}
        />
        {toastText ? <div className="launchToast">{toastText}</div> : null}
        {isStartupSplashVisible ? <StartupSplash leaving={isStartupSplashLeaving} /> : null}
      </main>
    );
  }

  return (
    <main className="appShell">
      <header className="appTopbar">
        <div className="brandBlock">
          <span className="brandMark" aria-hidden="true">
            <img src={HOME_ICON_SRC} alt="" />
          </span>
          <span>主页</span>
        </div>
        <div className="statusBlock">
          <span className={activePetId ? "statusDot online" : "statusDot"} />
          <span>{activePetId ? "桌宠运行中" : "未启用"}</span>
        </div>
      </header>

      <div className="workspace detailsOpen">
        <PetSelector
          pets={availablePets}
          selectedPetId={selectedPet?.id}
          activePetId={activePetId}
          onSelectPet={setSelectedPetId}
          onTogglePet={togglePet}
          onCreatePet={() => {
            openEditorPage({ mode: "create" });
          }}
        />

        <div className="rightColumn">
          {selectedPet ? (
            <PetStage
              pet={selectedPet}
              isActive={selectedPet.id === activePetId}
              petWindowState={petWindowState}
              onActivate={() => activatePet(selectedPet.id)}
              onDeactivate={deactivatePet}
              onEditPet={() => openEditorPage({ mode: "edit", petId: selectedPet.id })}
              onDeletePet={() => deletePet(selectedPet)}
              onCloseDetails={() => setSelectedPetId(undefined)}
              onVoiceConnected={refreshPets}
            />
          ) : (
            <SelectorGuideStage
              hasPets={Boolean(availablePets.length)}
              onCreatePet={() => {
                openEditorPage({ mode: "create" });
              }}
            />
          )}
        </div>
      </div>

      {toastText ? <div className="launchToast">{toastText}</div> : null}
      {deleteTargetPet ? (
        <DeletePetDialog
          pet={deleteTargetPet}
          step={deleteConfirmStep}
          deleting={deletingPet}
          onCancel={() => {
            if (deletingPet) {
              return;
            }

            setDeleteTargetPet(undefined);
            setDeleteConfirmStep(1);
          }}
          onContinue={() => setDeleteConfirmStep(2)}
          onConfirm={confirmDeletePet}
        />
      ) : null}
      {isStartupSplashVisible ? <StartupSplash leaving={isStartupSplashLeaving} /> : null}
    </main>
  );
}
