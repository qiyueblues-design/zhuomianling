import { app, Menu, nativeImage, Tray, type BrowserWindow } from "electron";
import {
  closePetWindow,
  getPetWindowState,
  setPetWindowClickThrough,
  showExistingPetWindow
} from "./petWindow";
import { getAppIconPath } from "./appIcon";

let tray: Tray | null = null;

function createTrayIcon(): Electron.NativeImage {
  return nativeImage.createFromPath(getAppIconPath()).resize({ width: 16, height: 16 });
}

export function createAppTray(getMainWindow: () => BrowserWindow | null): Tray {
  if (tray) {
    return tray;
  }

  tray = new Tray(createTrayIcon());
  tray.setToolTip("桌面灵");

  const refreshMenu = (): void => {
    const state = getPetWindowState();
    const mainWindow = getMainWindow();

    const contextMenu = Menu.buildFromTemplate([
      {
        label: "显示选择器",
        click: () => {
          mainWindow?.show();
          mainWindow?.focus();
        }
      },
      {
        label: state.visible ? "关闭桌宠" : "显示桌宠",
        click: () => {
          if (getPetWindowState().visible) {
            void closePetWindow().then(refreshMenu);
          } else {
            showExistingPetWindow();
            refreshMenu();
          }
        }
      },
      { type: "separator" },
      {
        label: "点击穿透",
        type: "checkbox",
        checked: state.clickThrough,
        click: (menuItem) => {
          setPetWindowClickThrough(menuItem.checked);
          refreshMenu();
        }
      },
      { type: "separator" },
      {
        label: "退出",
        click: () => {
          void closePetWindow().then(() => app.quit());
        }
      }
    ]);

    tray?.setContextMenu(contextMenu);
  };

  tray.on("click", () => {
    const mainWindow = getMainWindow();

    if (!mainWindow) {
      return;
    }

    if (mainWindow.isVisible()) {
      mainWindow.hide();
    } else {
      mainWindow.show();
      mainWindow.focus();
    }

    refreshMenu();
  });

  refreshMenu();

  return tray;
}
