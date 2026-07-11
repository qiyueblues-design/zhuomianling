import type { BrowserWindow } from "electron";

/**
 * Renderer navigation is never part of the desktop-pet workflow. Keep every
 * BrowserWindow on the URL selected by the main process and deny auxiliary
 * browsing surfaces that would inherit a preload or privileged session.
 */
export function hardenWindowNavigation(targetWindow: BrowserWindow): void {
  const { webContents } = targetWindow;

  webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  webContents.on("will-navigate", (event) => {
    event.preventDefault();
  });
  webContents.on("will-redirect", (event) => {
    event.preventDefault();
  });
  webContents.on("will-attach-webview", (event) => {
    event.preventDefault();
  });
}
