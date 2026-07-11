import { contextBridge, ipcRenderer, webUtils } from "electron";
import type {
  AiConnectionDraft,
  AiModelListResult,
  AiConnectionSaveResult,
  AiConnectionSummary
} from "../shared/types/ai";
import type {
  DesktopPetPayload,
  PetWindowCloseOptions,
  PetWindowState
} from "../shared/types/window";
import type {
  LocalPetAvatarImportResult,
  LocalPetAvatarCropSaveRequest,
  LocalPetBasicInfoDraft,
  LocalPetDeleteResult,
  LocalPetListResult,
  LocalPetEventSettingsDraft,
  LocalPetExpressionMappingDraft,
  LocalPetPersonaDraft,
  LocalPetUiSettingsDraft,
  LocalPetVoiceInputDraft,
  LocalPetVoiceModelConnectionResult,
  LocalPetVoiceModelDraft,
  LocalPetVoiceModelFilePickResult,
  LocalPetVoiceResourceKind,
  LocalPetSaveResult,
  PetCustomThemeImportResult,
  PetCustomThemeListResult,
  PetDefinition
} from "../shared/types/pet";
import type {
  Live2DFolderScanResult,
  Live2DFolderSelectResult,
  Live2DGeneratedEntryResult,
  Live2DImportedSourceScanResult,
  Live2DModelImportRequest,
  Live2DModelImportResult,
  Live2DPreviewModelResult
} from "../shared/types/live2dImport";

const desktopPetApi = {
  getAppVersion: () => ipcRenderer.invoke("app:get-version") as Promise<string>,
  minimize: () => ipcRenderer.send("window:minimize"),
  close: () => ipcRenderer.send("window:close"),
  appWindow: {
    isShown: () => ipcRenderer.invoke("app-window:is-shown") as Promise<boolean>,
    revealStartupSurface: (reason?: string) =>
      ipcRenderer.send("app-window:startup-surface-ready", reason),
    onShown: (callback: () => void) => {
      const listener = (): void => {
        callback();
      };

      ipcRenderer.on("app-window:shown", listener);

      return () => {
        ipcRenderer.off("app-window:shown", listener);
      };
    }
  },
  petConfig: {
    listLocal: () => ipcRenderer.invoke("pet-config:list-local") as Promise<LocalPetListResult>,
    restoreBackup: (petId: string) =>
      ipcRenderer.invoke("pet-config:restore-backup", petId) as Promise<LocalPetSaveResult>,
    listUiThemes: () =>
      ipcRenderer.invoke("pet-config:list-ui-themes") as Promise<PetCustomThemeListResult>,
    importUiTheme: () =>
      ipcRenderer.invoke("pet-config:import-ui-theme") as Promise<PetCustomThemeImportResult>,
    saveBasicInfo: (draft: LocalPetBasicInfoDraft) =>
      ipcRenderer.invoke("pet-config:save-basic-info", draft) as Promise<LocalPetSaveResult>,
    savePersona: (draft: LocalPetPersonaDraft) =>
      ipcRenderer.invoke("pet-config:save-persona", draft) as Promise<LocalPetSaveResult>,
    saveExpressionMappings: (draft: LocalPetExpressionMappingDraft) =>
      ipcRenderer.invoke("pet-config:save-expression-mappings", draft) as Promise<LocalPetSaveResult>,
    saveEventSettings: (draft: LocalPetEventSettingsDraft) =>
      ipcRenderer.invoke("pet-config:save-event-settings", draft) as Promise<LocalPetSaveResult>,
    saveUiSettings: (draft: LocalPetUiSettingsDraft) =>
      ipcRenderer.invoke("pet-config:save-ui-settings", draft) as Promise<LocalPetSaveResult>,
    saveVoiceInput: (draft: LocalPetVoiceInputDraft) =>
      ipcRenderer.invoke("pet-config:save-voice-input", draft) as Promise<LocalPetSaveResult>,
    pickVoiceModelFile: (kind: LocalPetVoiceResourceKind) =>
      ipcRenderer.invoke("pet-config:pick-voice-model-file", kind) as Promise<LocalPetVoiceModelFilePickResult>,
    testVoiceModelConnection: (draft: LocalPetVoiceModelDraft) =>
      ipcRenderer.invoke("pet-config:test-voice-model-connection", draft) as Promise<LocalPetVoiceModelConnectionResult>,
    disconnectVoiceModel: () =>
      ipcRenderer.invoke("pet-config:disconnect-voice-model") as Promise<LocalPetVoiceModelConnectionResult>,
    saveVoiceModel: (draft: LocalPetVoiceModelDraft) =>
      ipcRenderer.invoke("pet-config:save-voice-model", draft) as Promise<LocalPetSaveResult>,
    importAvatar: (petId?: string) =>
      ipcRenderer.invoke("pet-config:import-avatar", petId) as Promise<LocalPetAvatarImportResult>,
    saveAvatarCrop: (request: LocalPetAvatarCropSaveRequest) =>
      ipcRenderer.invoke("pet-config:save-avatar-crop", request) as Promise<LocalPetAvatarImportResult>,
    delete: (petId: string) =>
      ipcRenderer.invoke("pet-config:delete", petId) as Promise<LocalPetDeleteResult>,
    onChanged: (callback: (pet?: PetDefinition) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, pet?: PetDefinition): void => {
        callback(pet);
      };

      ipcRenderer.on("pet-config:changed", listener);

      return () => {
        ipcRenderer.off("pet-config:changed", listener);
      };
    }
  },
  live2dImport: {
    selectFolder: () =>
      ipcRenderer.invoke("live2d-import:select-folder") as Promise<Live2DFolderSelectResult>,
    validateFolder: (folderPath: string) =>
      ipcRenderer.invoke("live2d-import:validate-folder", folderPath) as Promise<Live2DFolderScanResult>,
    generateEntry: (folderPath: string) =>
      ipcRenderer.invoke("live2d-import:generate-entry", folderPath) as Promise<Live2DGeneratedEntryResult>,
    createPreviewModel: (folderPath: string) =>
      ipcRenderer.invoke("live2d-import:create-preview-model", folderPath) as Promise<Live2DPreviewModelResult>,
    importModel: (request: Live2DModelImportRequest) =>
      ipcRenderer.invoke("live2d-import:import-model", request) as Promise<Live2DModelImportResult>,
    scanImportedSources: (petId: string) =>
      ipcRenderer.invoke("live2d-import:scan-imported-sources", petId) as Promise<Live2DImportedSourceScanResult>,
    scanPreviewSources: (folderPath: string) =>
      ipcRenderer.invoke("live2d-import:scan-preview-sources", folderPath) as Promise<Live2DImportedSourceScanResult>,
    getDroppedFolderPath: (file: File) => webUtils.getPathForFile(file)
  },
  aiSettings: {
    list: () => ipcRenderer.invoke("ai-settings:list") as Promise<AiConnectionSummary[]>,
    get: (petId: string) =>
      ipcRenderer.invoke("ai-settings:get", petId) as Promise<AiConnectionSummary | undefined>,
    listModels: (draft: AiConnectionDraft) =>
      ipcRenderer.invoke("ai-settings:list-models", draft) as Promise<AiModelListResult>,
    save: (draft: AiConnectionDraft) =>
      ipcRenderer.invoke("ai-settings:save", draft) as Promise<AiConnectionSaveResult>
  },
  petWindow: {
    show: (payload: DesktopPetPayload) =>
      ipcRenderer.invoke("pet-window:show", payload) as Promise<PetWindowState>,
    close: (options?: PetWindowCloseOptions) =>
      ipcRenderer.invoke("pet-window:close", options) as Promise<PetWindowState>,
    getState: () => ipcRenderer.invoke("pet-window:get-state") as Promise<PetWindowState>,
    onStateChanged: (callback: (state: PetWindowState) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, state: PetWindowState): void => {
        callback(state);
      };

      ipcRenderer.on("pet-window:state-changed", listener);

      return () => {
        ipcRenderer.off("pet-window:state-changed", listener);
      };
    }
  }
};

contextBridge.exposeInMainWorld("desktopPet", desktopPetApi);

export type MainDesktopPetApi = typeof desktopPetApi;
