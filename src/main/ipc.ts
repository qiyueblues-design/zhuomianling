import type { IpcMain } from "electron";
import { app, BrowserWindow } from "electron";
import type { AiChatRequest, AiConnectionDraft } from "../shared/types/ai";
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
  TextToSpeechRequest
} from "../shared/types/speech";
import type { DesktopPetPayload, PetWindowDragPoint } from "../shared/types/window";
import { sendAiChat, startAiChatStream } from "./services/ai/aiChat";
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
  closePetWindow,
  endPetWindowDrag,
  movePetWindowDrag,
  onPetWindowStateChanged,
  setPetWindowClickThroughControlInteractive,
  setPetWindowClickThrough,
  showPetWindow,
  startPetWindowDrag,
  togglePetWindowClickThrough,
  updateCurrentPetWindowPayload
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
  stopManagedGptSoVitsApi,
  testLocalPetVoiceModelConnection
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

export function registerIpc(ipcMain: IpcMain, getMainWindow: () => BrowserWindow | null): void {
  const emitPetConfigChanged = (pet?: DesktopPetPayload["definition"]): void => {
    if (pet) {
      updateCurrentPetWindowPayload({
        id: pet.id,
        name: pet.name,
        modelPath: pet.modelPath,
        avatar: pet.avatar,
        definition: pet
      });
    }

    for (const targetWindow of BrowserWindow.getAllWindows()) {
      targetWindow.webContents.send("pet-config:changed", pet);
    }
  };

  onPetWindowStateChanged((state) => {
    for (const targetWindow of BrowserWindow.getAllWindows()) {
      targetWindow.webContents.send("pet-window:state-changed", state);
    }
  });

  ipcMain.handle("app:get-version", () => app.getVersion());

  ipcMain.handle("app-window:is-shown", () => getMainWindow()?.isVisible() ?? false);

  ipcMain.on("app-window:startup-surface-ready", (event, reason?: string) => {
    if (event.sender !== getMainWindow()?.webContents) {
      return;
    }

    const safeReason = typeof reason === "string" ? reason.slice(0, 120) : "renderer";

    revealMainWindowStartupSurface(safeReason);
  });

  ipcMain.handle("pet-config:list-local", () => listLocalPets());

  ipcMain.handle("pet-config:list-ui-themes", () => listLocalUiThemes());

  ipcMain.handle("pet-config:import-ui-theme", () => importLocalUiTheme());

  ipcMain.handle("pet-config:save-basic-info", async (_event, draft: LocalPetBasicInfoDraft) => {
    const result = await saveLocalPetBasicInfo(draft);

    if (result.ok) {
      emitPetConfigChanged(result.pet);
    }

    return result;
  });

  ipcMain.handle("pet-config:save-persona", async (_event, draft: LocalPetPersonaDraft) => {
    const result = await saveLocalPetPersona(draft);

    if (result.ok) {
      emitPetConfigChanged(result.pet);
    }

    return result;
  });

  ipcMain.handle("pet-config:save-expression-mappings", async (_event, draft: LocalPetExpressionMappingDraft) => {
    const result = await saveLocalPetExpressionMappings(draft);

    if (result.ok) {
      emitPetConfigChanged(result.pet);
    }

    return result;
  });

  ipcMain.handle("pet-config:save-event-settings", async (_event, draft: LocalPetEventSettingsDraft) => {
    const result = await saveLocalPetEventSettings(draft);

    if (result.ok) {
      emitPetConfigChanged(result.pet);
    }

    return result;
  });

  ipcMain.handle("pet-config:save-ui-settings", async (_event, draft: LocalPetUiSettingsDraft) => {
    const result = await saveLocalPetUiSettings(draft);

    if (result.ok) {
      emitPetConfigChanged(result.pet);
    }

    return result;
  });

  ipcMain.handle("pet-config:save-voice-input", async (_event, draft: LocalPetVoiceInputDraft) => {
    const result = await saveLocalPetVoiceInput(draft);

    if (result.ok) {
      emitPetConfigChanged(result.pet);
    }

    return result;
  });

  ipcMain.handle("pet-config:pick-voice-model-file", (_event, kind: LocalPetVoiceResourceKind) =>
    pickLocalPetVoiceModelFile(kind)
  );

  ipcMain.handle("pet-config:test-voice-model-connection", (_event, draft: LocalPetVoiceModelDraft) =>
    testLocalPetVoiceModelConnection(draft)
  );

  ipcMain.handle("pet-config:disconnect-voice-model", async () => {
    stopManagedGptSoVitsApi();
    await resetLocalPetVoiceRuntimeState();

    emitPetConfigChanged();

    return {
      ok: true,
      message: "已断开连接。"
    };
  });

  ipcMain.handle("pet-config:save-voice-model", async (_event, draft: LocalPetVoiceModelDraft) => {
    const result = await saveLocalPetVoiceModel(draft);

    if (result.ok) {
      emitPetConfigChanged(result.pet);
    }

    return result;
  });

  ipcMain.handle("pet-config:import-avatar", (_event, petId?: string) =>
    importLocalPetAvatar(petId)
  );

  ipcMain.handle("pet-config:save-avatar-crop", (_event, request: LocalPetAvatarCropSaveRequest) =>
    saveLocalPetAvatarCrop(request)
  );

  ipcMain.handle("pet-config:delete", async (_event, petId: string) => {
    const result = await deleteLocalPet(petId);

    if (result.ok) {
      await deleteAiConnection(result.petId);
      emitPetConfigChanged();
    }

    return result;
  });

  ipcMain.handle("live2d-import:select-folder", () => selectLive2DFolder());

  ipcMain.handle("live2d-import:validate-folder", (_event, folderPath: string) =>
    validateLive2DFolder(folderPath)
  );

  ipcMain.handle("live2d-import:generate-entry", (_event, folderPath: string) =>
    generateLive2DEntry(folderPath)
  );

  ipcMain.handle("live2d-import:create-preview-model", (_event, folderPath: string) =>
    createLive2DPreviewModel(folderPath)
  );

  ipcMain.handle("live2d-import:import-model", async (_event, request) => {
    const result = await importLive2DModel(request);

    if (result.ok) {
      emitPetConfigChanged(result.pet);
    }

    return result;
  });

  ipcMain.handle("live2d-import:scan-imported-sources", (_event, petId: string) =>
    scanImportedLive2DSources(petId)
  );

  ipcMain.handle("live2d-import:scan-preview-sources", (_event, folderPath: string) =>
    scanLive2DPreviewSources(folderPath)
  );

  ipcMain.handle("ai-settings:list", () => listAiConnectionSummaries());

  ipcMain.handle("ai-settings:get", (_event, petId: string) => getAiConnectionSummary(petId));

  ipcMain.handle("ai-settings:list-models", (_event, draft: AiConnectionDraft) =>
    listAiModels(draft)
  );

  ipcMain.handle("ai-settings:save", (_event, draft: AiConnectionDraft) =>
    saveAiConnection(draft)
  );

  ipcMain.handle("ai-chat:send", (_event, request: AiChatRequest) => sendAiChat(request));

  ipcMain.handle("ai-chat:stream", (event, request: AiChatRequest) => {
    const streamId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    void startAiChatStream(event.sender, request, streamId);

    return {
      ok: true,
      message: "ok",
      streamId
    };
  });

  ipcMain.handle("speech-to-text:transcribe", (_event, request: SpeechToTextRequest) =>
    transcribeSpeech(request)
  );

  ipcMain.handle("text-to-speech:speak", (_event, request: TextToSpeechRequest) =>
    speakText(request)
  );

  ipcMain.handle("text-to-speech:stop", () => stopSpeechPlayback());

  ipcMain.handle("speech-stream:start", (event, request: SpeechStreamStartRequest) =>
    startSpeechStream(event.sender, request)
  );

  ipcMain.on("speech-stream:audio", (_event, chunk: SpeechStreamAudioChunk) => {
    sendSpeechStreamAudio(chunk);
  });

  ipcMain.on("speech-stream:stop", (_event, request: SpeechStreamStopRequest) => {
    stopSpeechStream(request);
  });

  ipcMain.on("window:minimize", () => {
    getMainWindow()?.minimize();
  });

  ipcMain.on("window:close", () => {
    getMainWindow()?.close();
  });

  ipcMain.handle("pet-window:show", (_event, payload: DesktopPetPayload) => showPetWindow(payload));

  ipcMain.handle("pet-window:close", (_event, options) => closePetWindow(options));

  ipcMain.handle("pet-window:toggle-click-through", () => togglePetWindowClickThrough());

  ipcMain.handle("pet-window:set-click-through", (_event, value: boolean) =>
    setPetWindowClickThrough(value)
  );

  ipcMain.handle("pet-window:set-click-through-control-interactive", (_event, value: boolean) =>
    setPetWindowClickThroughControlInteractive(value)
  );

  ipcMain.handle("pet-window:start-drag", (_event, point: PetWindowDragPoint) =>
    startPetWindowDrag(point)
  );

  ipcMain.handle("pet-window:move-drag", (_event, point: PetWindowDragPoint) =>
    movePetWindowDrag(point)
  );

  ipcMain.handle("pet-window:end-drag", () => endPetWindowDrag());

  ipcMain.handle("pet-window:get-state", () => getPetWindowState());

  ipcMain.handle("pet-window:get-payload", () => getCurrentPetWindowPayload());
}
