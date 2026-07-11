import { contextBridge, ipcRenderer } from "electron";
import type {
  AiChatStreamCancelRequest,
  AiChatStreamCancelResult,
  AiChatStreamEvent,
  AiChatStreamRequest,
  AiChatStreamStartResult
} from "../shared/types/ai";
import type { PetDefinition } from "../shared/types/pet";
import type {
  SpeechStreamAudioChunk,
  SpeechStreamResultEvent,
  SpeechStreamStartRequest,
  SpeechStreamStartResult,
  SpeechStreamStopRequest,
  TextToSpeechRequest,
  TextToSpeechResponse,
  TextToSpeechStopRequest,
  TextToSpeechStopResponse
} from "../shared/types/speech";
import type {
  DesktopPetPayload,
  PetWindowCloseOptions,
  PetWindowCursorPoint,
  PetWindowDragPoint,
  PetWindowState
} from "../shared/types/window";

const petDesktopApi = {
  petConfig: {
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
  aiChat: {
    stream: (request: AiChatStreamRequest) =>
      ipcRenderer.invoke("ai-chat:stream", request) as Promise<AiChatStreamStartResult>,
    cancel: (request?: AiChatStreamCancelRequest) =>
      ipcRenderer.invoke("ai-chat:cancel", request) as Promise<AiChatStreamCancelResult>,
    onStreamEvent: (callback: (event: AiChatStreamEvent) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, result: AiChatStreamEvent): void => {
        callback(result);
      };

      ipcRenderer.on("ai-chat:stream-event", listener);
      return () => {
        ipcRenderer.off("ai-chat:stream-event", listener);
      };
    }
  },
  textToSpeech: {
    speak: (request: TextToSpeechRequest) =>
      ipcRenderer.invoke("text-to-speech:speak", request) as Promise<TextToSpeechResponse>,
    stop: (request?: TextToSpeechStopRequest) =>
      ipcRenderer.invoke("text-to-speech:stop", request) as Promise<TextToSpeechStopResponse>
  },
  speechStream: {
    start: (request: SpeechStreamStartRequest) =>
      ipcRenderer.invoke("speech-stream:start", request) as Promise<SpeechStreamStartResult>,
    audio: (chunk: SpeechStreamAudioChunk) => ipcRenderer.send("speech-stream:audio", chunk),
    stop: (request: SpeechStreamStopRequest) => ipcRenderer.send("speech-stream:stop", request),
    onResult: (callback: (event: SpeechStreamResultEvent) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, result: SpeechStreamResultEvent): void => {
        callback(result);
      };

      ipcRenderer.on("speech-stream:result", listener);
      return () => {
        ipcRenderer.off("speech-stream:result", listener);
      };
    }
  },
  petWindow: {
    close: (options?: PetWindowCloseOptions) =>
      ipcRenderer.invoke("pet-window:close", options) as Promise<PetWindowState>,
    toggleClickThrough: () =>
      ipcRenderer.invoke("pet-window:toggle-click-through") as Promise<PetWindowState>,
    setClickThroughControlInteractive: (value: boolean) =>
      ipcRenderer.invoke("pet-window:set-click-through-control-interactive", value) as Promise<PetWindowState>,
    startDrag: (point: PetWindowDragPoint) =>
      ipcRenderer.invoke("pet-window:start-drag", point) as Promise<void>,
    moveDrag: (point: PetWindowDragPoint) =>
      ipcRenderer.invoke("pet-window:move-drag", point) as Promise<void>,
    endDrag: () => ipcRenderer.invoke("pet-window:end-drag") as Promise<void>,
    getState: () => ipcRenderer.invoke("pet-window:get-state") as Promise<PetWindowState>,
    getPayload: () =>
      ipcRenderer.invoke("pet-window:get-payload") as Promise<DesktopPetPayload | undefined>,
    onStateChanged: (callback: (state: PetWindowState) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, state: PetWindowState): void => {
        callback(state);
      };

      ipcRenderer.on("pet-window:state-changed", listener);
      return () => {
        ipcRenderer.off("pet-window:state-changed", listener);
      };
    },
    onCursorMoved: (callback: (point: PetWindowCursorPoint) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, point: PetWindowCursorPoint): void => {
        callback(point);
      };

      ipcRenderer.on("pet-window:cursor-moved", listener);
      return () => {
        ipcRenderer.off("pet-window:cursor-moved", listener);
      };
    },
    onCloseEffect: (callback: () => void) => {
      const listener = (): void => {
        callback();
      };

      ipcRenderer.on("pet-window:play-close-effect", listener);
      return () => {
        ipcRenderer.off("pet-window:play-close-effect", listener);
      };
    }
  }
};

contextBridge.exposeInMainWorld("desktopPet", petDesktopApi);

export type PetDesktopPetApi = typeof petDesktopApi;
