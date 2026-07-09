import { app, BrowserWindow, ipcMain, protocol } from "electron";
import path from "node:path";
import { createMainWindow } from "./window";
import { registerIpc } from "./ipc";
import { closePetWindow } from "./petWindow";
import { createAppTray } from "./tray";
import {
  petResourceProtocol,
  registerPetResourceProtocol
} from "./services/config/petResourceProtocol";
import {
  resetLocalPetVoiceRuntimeState,
  stopManagedGptSoVitsApi
} from "./services/config/petConfigStore";

let mainWindow: Electron.BrowserWindow | null = null;
let isQuitting = false;

app.setName("桌面灵");

const userDataDirectoryName = "zhuomianling";

app.setPath("userData", path.join(app.getPath("appData"), userDataDirectoryName));

const gotLock = app.requestSingleInstanceLock();
protocol.registerSchemesAsPrivileged([
  {
    scheme: petResourceProtocol,
    privileges: {
      corsEnabled: true,
      secure: true,
      standard: true,
      supportFetchAPI: true
    }
  }
]);

if (!gotLock) {
  app.quit();
} else {
  app.on("before-quit", () => {
    stopManagedGptSoVitsApi();
    void resetLocalPetVoiceRuntimeState();
  });

  app.on("second-instance", () => {
    if (!mainWindow) {
      return;
    }

    if (mainWindow.isMinimized()) {
      mainWindow.restore();
    }

    mainWindow.focus();
  });

  app.whenReady().then(async () => {
    await resetLocalPetVoiceRuntimeState();
    registerPetResourceProtocol();
    mainWindow = createMainWindow();
    registerIpc(ipcMain, () => mainWindow);
    createAppTray(() => mainWindow);

    mainWindow.on("close", (event) => {
      if (isQuitting) {
        return;
      }

      event.preventDefault();
      isQuitting = true;
      void closePetWindow({ playEffect: false })
        .then(() => resetLocalPetVoiceRuntimeState())
        .finally(() => app.quit());
    });

    mainWindow.on("closed", () => {
      mainWindow = null;
    });
  });

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      mainWindow = createMainWindow();
    }
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") {
      isQuitting = true;
      void closePetWindow({ playEffect: false })
        .then(() => resetLocalPetVoiceRuntimeState())
        .finally(() => app.quit());
    }
  });
}
