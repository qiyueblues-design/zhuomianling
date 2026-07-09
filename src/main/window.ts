import { BrowserWindow, Menu } from "electron";
import path from "node:path";
import { getAppIconPath } from "./appIcon";

let startupSurfaceWindow: BrowserWindow | undefined;
let hasRevealedStartupSurface = false;
let hasSentStartupShownEvent = false;

export function revealMainWindowStartupSurface(_reason?: string): void {
  const targetWindow = startupSurfaceWindow;

  if (!targetWindow || targetWindow.isDestroyed() || hasRevealedStartupSurface) {
    return;
  }

  hasRevealedStartupSurface = true;

  targetWindow.setOpacity(1);

  if (!targetWindow.isVisible()) {
    targetWindow.show();
  }

  if (!hasSentStartupShownEvent && targetWindow.isVisible()) {
    hasSentStartupShownEvent = true;
    targetWindow.webContents.send("app-window:shown");
  }
}

export function createMainWindow(): BrowserWindow {
  Menu.setApplicationMenu(null);

  const preloadPath = path.join(__dirname, "../preload/index.js");

  const mainWindow = new BrowserWindow({
    width: 1040,
    height: 720,
    minWidth: 920,
    minHeight: 600,
    show: false,
    opacity: 0,
    title: "桌面灵",
    icon: getAppIconPath(),
    backgroundColor: "#f5f7fb",
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  startupSurfaceWindow = mainWindow;
  hasRevealedStartupSurface = false;
  hasSentStartupShownEvent = false;

  mainWindow.once("closed", () => {
    if (startupSurfaceWindow === mainWindow) {
      startupSurfaceWindow = undefined;
    }
  });

  let fallbackShowTimer: NodeJS.Timeout | undefined;
  const forceShowMainWindow = (): void => {
    if (fallbackShowTimer) {
      clearTimeout(fallbackShowTimer);
      fallbackShowTimer = undefined;
    }

    if (mainWindow.isDestroyed()) {
      return;
    }

    if (!mainWindow.isVisible()) {
      mainWindow.show();
    }

    if (!hasSentStartupShownEvent && mainWindow.isVisible()) {
      hasSentStartupShownEvent = true;
      mainWindow.webContents.send("app-window:shown");
    }
  };

  fallbackShowTimer = setTimeout(() => {
    forceShowMainWindow();
    revealMainWindowStartupSurface("show fallback");
  }, 3000);

  const devServerUrl = process.env.VITE_DEV_SERVER_URL;

  if (devServerUrl) {
    void mainWindow.loadURL(devServerUrl);
  } else {
    const indexPath = path.join(__dirname, "../renderer/index.html");
    void mainWindow.loadFile(indexPath);
  }

  return mainWindow;
}
