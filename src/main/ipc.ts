import type { IpcMain, IpcMainEvent, IpcMainInvokeEvent } from "electron";
import { app, BrowserWindow } from "electron";
import type {
  AiChatStreamCancelRequest,
  AiChatStreamRequest,
  AiConnectionDraft
} from "../shared/types/ai";
import type {
  LocalPetAvatarCropSaveRequest,
  LocalPetBasicInfoDraft,
  LocalPetEventSettingsDraft,
  LocalPetExpressionMappingDraft,
  LocalPetPersonaDraft,
  LocalPetUiSettingsDraft,
  LocalPetVoiceInputDraft,
  LocalPetVoiceModelDraft,
  LocalPetVoiceResourceKind
} from "../shared/types/pet";
import type {
  SpeechStreamAudioChunk,
  SpeechStreamStartRequest,
  SpeechStreamStopRequest,
  SpeechToTextRequest,
  TextToSpeechRequest,
  TextToSpeechStopRequest
} from "../shared/types/speech";
import type {
  DesktopPetPayload,
  PetWindowDragPoint,
  PetWindowSourcePreviewRequest
} from "../shared/types/window";
import type { PetWindowCloseOptions } from "../shared/types/window";
import type { Live2DModelImportRequest } from "../shared/types/live2dImport";
import { cancelAiChatStreams, startAiChatStream } from "./services/ai/aiChat";
import {
  getAiConnectionSummary,
  deleteAiConnection,
  listAiModels,
  listAiConnectionSummaries,
  saveAiConnection
} from "./services/ai/aiSettings";
import {
  getPetWindowState,
  getCurrentPetWindowPayload,
  clearCurrentPetWindowPayload,
  closePetWindow,
  endPetWindowDrag,
  movePetWindowDrag,
  onPetWindowStateChanged,
  setPetWindowClickThroughControlInteractive,
  setPetWindowClickThrough,
  showPetWindow,
  startPetWindowDrag,
  togglePetWindowClickThrough,
  updateCurrentPetWindowPayload,
  isPetWindowWebContents,
  previewPetWindowSource,
  consumePendingPetWindowSourcePreview,
  completePetWindowSourcePreview
} from "./petWindow";
import {
  sendSpeechStreamAudio,
  startSpeechStream,
  stopSpeechStream,
  transcribeSpeech
} from "./services/speech/speechToText";
import { speakText, stopSpeechPlayback } from "./services/speech/textToSpeech";
import {
  importLocalPetAvatar,
  deleteLocalPet,
  importLocalUiTheme,
  listLocalUiThemes,
  listLocalPets,
  scanLocalPetsForRecovery,
  saveLocalPetAvatarCrop,
  saveLocalPetBasicInfo,
  saveLocalPetEventSettings,
  saveLocalPetExpressionMappings,
  saveLocalPetPersona,
  saveLocalPetUiSettings,
  saveLocalPetVoiceInput,
  saveLocalPetVoiceModel,
  pickLocalPetVoiceModelFile,
  resetLocalPetVoiceRuntimeState,
  restoreLocalPetConfigBackup,
  stopManagedGptSoVitsApi,
  testLocalPetVoiceModelConnection,
  toPublicPetDefinition
} from "./services/config/petConfigStore";
import {
  createLive2DPreviewModel,
  generateLive2DEntry,
  importLive2DModel,
  scanImportedLive2DSources,
  scanLive2DPreviewSources,
  selectLive2DFolder,
  validateLive2DFolder
} from "./services/config/live2dImportService";
import { revealMainWindowStartupSurface } from "./window";
import { validateIpcArguments } from "./ipcValidation";
import { assertIpcSenderAllowed, type IpcAccess } from "./ipcAccess";

export function registerIpc(ipcMain: IpcMain, getMainWindow: () => BrowserWindow | null): void {
  const assertSenderAllowed = (
    channel: string,
    event: IpcMainEvent | IpcMainInvokeEvent,
    access: IpcAccess
  ): void => {
    assertIpcSenderAllowed(
      channel,
      access,
      event.sender,
      getMainWindow()?.webContents,
      isPetWindowWebContents(event.sender)
    );
  };

  const handle = <Args extends unknown[], Result>(
    channel: string,
    access: IpcAccess,
    listener: (event: IpcMainInvokeEvent, ...args: Args) => Result
  ): void => {
    ipcMain.handle(channel, (event, ...args) => {
      assertSenderAllowed(channel, event, access);
      validateIpcArguments(channel, args);
      return listener(event, ...(args as unknown as Args));
    });
  };

  const on = <Args extends unknown[]>(
    channel: string,
    access: IpcAccess,
    listener: (event: IpcMainEvent, ...args: Args) => void
  ): void => {
    ipcMain.on(channel, (event, ...args) => {
      try {
        assertSenderAllowed(channel, event, access);
        validateIpcArguments(channel, args);
        listener(event, ...(args as unknown as Args));
      } catch (error: unknown) {
        console.warn(
          `Rejected one-way IPC ${channel}.`,
          error instanceof Error ? error.message : "Unknown IPC validation error."
        );
      }
    });
  };

  const emitPetConfigChanged = (pet?: DesktopPetPayload["definition"]): void => {
    const publicPet = pet ? toPublicPetDefinition(pet) : undefined;

    if (publicPet) {
      updateCurrentPetWindowPayload({
        id: publicPet.id,
        name: publicPet.name,
        modelPath: publicPet.modelPath,
        avatar: publicPet.avatar,
        definition: publicPet
      });
    }

    for (const targetWindow of BrowserWindow.getAllWindows()) {
      targetWindow.webContents.send("pet-config:changed", publicPet);
    }
  };

  onPetWindowStateChanged((state) => {
    for (const targetWindow of BrowserWindow.getAllWindows()) {
      targetWindow.webContents.send("pet-window:state-changed", state);
    }
  });

  handle("app:get-version", "main", () => app.getVersion());

  handle("app-window:is-shown", "main", () => getMainWindow()?.isVisible() ?? false);

  on("app-window:startup-surface-ready", "main", (event, reason?: string) => {
    const safeReason = typeof reason === "string" ? reason.slice(0, 120) : "renderer";

    revealMainWindowStartupSurface(safeReason);
  });

  handle("pet-config:list-local", "main", async () => {
    const result = await scanLocalPetsForRecovery();
    const corruption = result.corruptions[0];

    return {
      ok: !corruption,
      pets: result.pets,
      corruption: corruption
        ? {
            code: corruption.code,
            petId: corruption.petId,
            backupAvailable: corruption.backupAvailable,
            message: corruption.message
          }
        : undefined
    };
  });

  handle("pet-config:restore-backup", "main", async (_event, petId: string) => {
    const result = await restoreLocalPetConfigBackup(petId);

    if (result.ok) {
      emitPetConfigChanged(result.pet);
    }

    return result;
  });

  handle("pet-config:list-ui-themes", "main", () => listLocalUiThemes());

  handle("pet-config:import-ui-theme", "main", () => importLocalUiTheme());

  handle("pet-config:save-basic-info", "main", async (_event, draft: LocalPetBasicInfoDraft) => {
    const result = await saveLocalPetBasicInfo(draft);

    if (result.ok) {
      emitPetConfigChanged(result.pet);
    }

    return result;
  });

  handle("pet-config:save-persona", "main", async (_event, draft: LocalPetPersonaDraft) => {
    const result = await saveLocalPetPersona(draft);

    if (result.ok) {
      emitPetConfigChanged(result.pet);
    }

    return result;
  });

  handle("pet-config:save-expression-mappings", "main", async (_event, draft: LocalPetExpressionMappingDraft) => {
    const result = await saveLocalPetExpressionMappings(draft);

    if (result.ok) {
      emitPetConfigChanged(result.pet);
    }

    return result;
  });

  handle("pet-config:save-event-settings", "main", async (_event, draft: LocalPetEventSettingsDraft) => {
    const result = await saveLocalPetEventSettings(draft);

    if (result.ok) {
      emitPetConfigChanged(result.pet);
    }

    return result;
  });

  handle("pet-config:save-ui-settings", "main", async (_event, draft: LocalPetUiSettingsDraft) => {
    const result = await saveLocalPetUiSettings(draft);

    if (result.ok) {
      emitPetConfigChanged(result.pet);
    }

    return result;
  });

  handle("pet-config:save-voice-input", "main", async (_event, draft: LocalPetVoiceInputDraft) => {
    const result = await saveLocalPetVoiceInput(draft);

    if (result.ok) {
      emitPetConfigChanged(result.pet);
    }

    return result;
  });

  handle("pet-config:pick-voice-model-file", "main", (_event, kind: LocalPetVoiceResourceKind) =>
    pickLocalPetVoiceModelFile(kind)
  );

  handle("pet-config:test-voice-model-connection", "main", (_event, draft: LocalPetVoiceModelDraft) =>
    testLocalPetVoiceModelConnection(draft)
  );

  handle("pet-config:disconnect-voice-model", "main", async () => {
    stopManagedGptSoVitsApi();
    await resetLocalPetVoiceRuntimeState();

    emitPetConfigChanged();

    return {
      ok: true,
      message: "已断开连接。"
    };
  });

  handle("pet-config:save-voice-model", "main", async (_event, draft: LocalPetVoiceModelDraft) => {
    const result = await saveLocalPetVoiceModel(draft);

    if (result.ok) {
      emitPetConfigChanged(result.pet);
    }

    return result;
  });

  handle("pet-config:import-avatar", "main", (_event, petId?: string) =>
    importLocalPetAvatar(petId)
  );

  handle("pet-config:save-avatar-crop", "main", (_event, request: LocalPetAvatarCropSaveRequest) =>
    saveLocalPetAvatarCrop(request)
  );

  handle("pet-config:delete", "main", async (_event, petId: string) => {
    const currentPayload = getCurrentPetWindowPayload();

    if (currentPayload?.id === petId) {
      const closeState = await closePetWindow({ playEffect: false });

      if (closeState.visible && closeState.petId === petId) {
        return {
          ok: false,
          message: "桌宠窗口尚未关闭，未执行删除。请重试。",
          petId
        };
      }
    }

    const result = await deleteLocalPet(petId);

    if (result.ok) {
      await deleteAiConnection(result.petId);
      clearCurrentPetWindowPayload(result.petId);
      emitPetConfigChanged();
    }

    return result;
  });

  handle("live2d-import:select-folder", "main", () => selectLive2DFolder());

  handle("live2d-import:validate-folder", "main", (_event, folderPath: string) =>
    validateLive2DFolder(folderPath)
  );

  handle("live2d-import:generate-entry", "main", (_event, folderPath: string) =>
    generateLive2DEntry(folderPath)
  );

  handle("live2d-import:create-preview-model", "main", (_event, folderPath: string) =>
    createLive2DPreviewModel(folderPath)
  );

  handle("live2d-import:import-model", "main", async (_event, request: Live2DModelImportRequest) => {
    const result = await importLive2DModel(request);
    const publicResult = result.pet
      ? {
          ...result,
          pet: toPublicPetDefinition(result.pet)
        }
      : result;

    if (publicResult.ok) {
      emitPetConfigChanged(publicResult.pet);
    }

    return publicResult;
  });

  handle("live2d-import:scan-imported-sources", "main", (_event, petId: string) =>
    scanImportedLive2DSources(petId)
  );

  handle("live2d-import:scan-preview-sources", "main", (_event, folderPath: string) =>
    scanLive2DPreviewSources(folderPath)
  );

  handle("ai-settings:list", "main", () => listAiConnectionSummaries());

  handle("ai-settings:get", "main", (_event, petId: string) => getAiConnectionSummary(petId));

  handle("ai-settings:list-models", "main", (_event, draft: AiConnectionDraft) =>
    listAiModels(draft)
  );

  handle("ai-settings:save", "main", (_event, draft: AiConnectionDraft) =>
    saveAiConnection(draft)
  );

  handle("ai-chat:stream", "pet", (event, request: AiChatStreamRequest) => {
    if (
      !request ||
      typeof request.requestId !== "string" ||
      !/^[A-Za-z0-9._:-]{1,128}$/.test(request.requestId)
    ) {
      return {
        ok: false,
        message: "AI 请求标识无效。"
      };
    }

    const streamId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    void startAiChatStream(event.sender, request, streamId);

    return {
      ok: true,
      message: "ok",
      requestId: request.requestId,
      streamId
    };
  });

  handle("ai-chat:cancel", "pet", (event, request?: AiChatStreamCancelRequest) =>
    cancelAiChatStreams(event.sender, request)
  );

  handle("speech-to-text:transcribe", "pet", (_event, request: SpeechToTextRequest) =>
    transcribeSpeech(request)
  );

  handle("text-to-speech:speak", "pet", (event, request: TextToSpeechRequest) => {
    if (
      !request ||
      typeof request.requestId !== "string" ||
      !/^[A-Za-z0-9._:-]{1,128}$/.test(request.requestId)
    ) {
      return {
        ok: false,
        message: "语音请求标识无效。"
      };
    }

    return speakText(event.sender, request);
  });

  handle("text-to-speech:stop", "pet", (event, request?: TextToSpeechStopRequest) =>
    stopSpeechPlayback(event.sender, request)
  );

  handle("speech-stream:start", "pet", (event, request: SpeechStreamStartRequest) =>
    startSpeechStream(event.sender, request)
  );

  on("speech-stream:audio", "pet", (_event, chunk: SpeechStreamAudioChunk) => {
    sendSpeechStreamAudio(chunk);
  });

  on("speech-stream:stop", "pet", (_event, request: SpeechStreamStopRequest) => {
    stopSpeechStream(request);
  });

  on("window:minimize", "main", () => {
    getMainWindow()?.minimize();
  });

  on("window:close", "main", () => {
    getMainWindow()?.close();
  });

  handle("pet-window:show", "main", (_event, payload: DesktopPetPayload) =>
    showPetWindow({
      ...payload,
      definition: payload.definition ? toPublicPetDefinition(payload.definition) : undefined
    })
  );

  handle("pet-window:close", "both", (_event, options?: PetWindowCloseOptions) =>
    closePetWindow(options)
  );

  handle("pet-window:toggle-click-through", "pet", () => togglePetWindowClickThrough());

  handle("pet-window:set-click-through", "pet", (_event, value: boolean) =>
    setPetWindowClickThrough(value)
  );

  handle("pet-window:set-click-through-control-interactive", "pet", (_event, value: boolean) =>
    setPetWindowClickThroughControlInteractive(value)
  );

  handle("pet-window:start-drag", "pet", (_event, point: PetWindowDragPoint) =>
    startPetWindowDrag(point)
  );

  handle("pet-window:move-drag", "pet", (_event, point: PetWindowDragPoint) =>
    movePetWindowDrag(point)
  );

  handle("pet-window:end-drag", "pet", () => endPetWindowDrag());

  handle("pet-window:get-state", "both", () => getPetWindowState());

  handle("pet-window:get-payload", "pet", () => getCurrentPetWindowPayload());

  handle("pet-window:consume-pending-source-preview", "pet", () =>
    consumePendingPetWindowSourcePreview()
  );

  handle("pet-window:complete-source-preview", "pet", (event, previewId: number) =>
    completePetWindowSourcePreview(event.sender, previewId)
  );

  handle("pet-window:preview-source", "main", async (_event, request: PetWindowSourcePreviewRequest) => {
    const pet = (await listLocalPets()).find((candidate) => candidate.id === request.petId);

    if (!pet?.modelPath) {
      return {
        ok: false,
        message: "当前桌宠还没有可预览的 Live2D 模型。",
        state: getPetWindowState()
      };
    }

    return previewPetWindowSource(
      {
        id: pet.id,
        name: pet.name,
        modelPath: pet.modelPath,
        avatar: pet.avatar,
        definition: toPublicPetDefinition(pet)
      },
      {
        sourceKind: request.source.sourceKind,
        sourceFileName: request.source.sourceFileName,
        runtimeName: request.source.runtimeName
      }
    );
  });
}
