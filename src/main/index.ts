import { app, BrowserWindow, ipcMain, protocol, session } from "electron";
import path from "node:path";
import { createMainWindow } from "./window";
import { registerIpc } from "./ipc";
import { closePetWindow, isPetWindowWebContents } from "./petWindow";
import { createAppTray } from "./tray";
import {
  petResourceProtocol,
  registerPetResourceProtocol
} from "./services/config/petResourceProtocol";
import {
  cleanupOrphanedAvatarDrafts,
  cleanupInterruptedPetDeletions,
  resetLocalPetVoiceRuntimeState,
  stopManagedGptSoVitsApi
} from "./services/config/petConfigStore";
import { deleteAiConnection, migrateLegacyAiConnections } from "./services/ai/aiSettings";
import { clearSafeAppCaches } from "./services/cache/appCacheCleanup";
import { shutdownAllMemorySidecars } from "./services/memory/memorySidecarRuntime";
import { configureMemoryRecallRuntime } from "./services/memory/memoryRecall";
import {
  resumeAutomaticMemoryCaptures,
  shutdownAutomaticMemoryCaptures
} from "./services/memory/memoryCapture";
import { startupProfiler } from "./startupProfiler";

let mainWindow: Electron.BrowserWindow | null = null;
let isQuitting = false;
let shutdownCleanupCompleted = false;
let shutdownCleanupPromise: Promise<void> | undefined;

app.setName("桌面灵");

const userDataDirectoryName = "zhuomianling";
const shutdownCleanupTimeoutMs = 5_000;

app.setPath("userData", path.join(app.getPath("appData"), userDataDirectoryName));
startupProfiler.markOnce("main-module-loaded", "主进程模块与 userData 路径初始化");

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

async function runShutdownCleanup(): Promise<void> {
  const cleanup = (async () => {
    stopManagedGptSoVitsApi();
    await shutdownAutomaticMemoryCaptures();
    await shutdownAllMemorySidecars();
    await resetLocalPetVoiceRuntimeState();

    try {
      await session.defaultSession.clearCache();
    } catch (error) {
      console.warn("Failed to clear Chromium HTTP cache during shutdown.", error);
    }

    await clearSafeAppCaches();
  })();

  let timeout: NodeJS.Timeout | undefined;

  try {
    await Promise.race([
      cleanup,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(
          () => reject(new Error("Application shutdown cleanup timed out.")),
          shutdownCleanupTimeoutMs
        );
      })
    ]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}

if (!gotLock) {
  app.quit();
} else {
  app.on("before-quit", (event) => {
    if (shutdownCleanupCompleted) {
      return;
    }

    event.preventDefault();
    shutdownCleanupPromise ??= runShutdownCleanup()
      .catch((error) => {
        console.warn("Failed to complete application shutdown cleanup.", error);
      })
      .finally(() => {
        shutdownCleanupCompleted = true;
        app.quit();
      });
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
    startupProfiler.markOnce("electron-ready", "Electron app.whenReady");
    startupProfiler.measureSyncOnce(
      "memory-runtime-configured",
      "配置记忆 runtime 路径",
      () => configureMemoryRecallRuntime({
        appPath: app.getAppPath(),
        resourcesPath: process.resourcesPath
      })
    );
    await startupProfiler.measureOnce(
      "interrupted-pet-deletions-cleaned",
      "续作中断的桌宠删除",
      () => cleanupInterruptedPetDeletions(deleteAiConnection)
    );
    await startupProfiler.measureOnce(
      "avatar-drafts-cleaned",
      "清理安全的头像草稿",
      cleanupOrphanedAvatarDrafts
    );
    await startupProfiler.measureOnce(
      "voice-runtime-reset",
      "重置桌宠声音运行态",
      resetLocalPetVoiceRuntimeState
    );

    try {
      await startupProfiler.measureOnce(
        "ai-credentials-migrated",
        "迁移旧版 AI 凭据",
        migrateLegacyAiConnections
      );
    } catch (error: unknown) {
      // Keep the settings UI reachable so it can show the fail-closed error.
      // The migration service retains the legacy file and refuses AI networking.
      console.error(
        "Failed to migrate legacy AI credentials.",
        error instanceof Error ? error.message : "Unknown secure storage error."
      );
    }

    startupProfiler.markOnce("memory-capture-resume-scheduled", "已调度后台恢复待整理记忆");
    void resumeAutomaticMemoryCaptures().then(() => {
      startupProfiler.markOnce("memory-capture-resume-finished", "后台恢复待整理记忆");
    }).catch(() => {
      console.warn("Failed to resume pending automatic memory captures.");
    });

    startupProfiler.measureSyncOnce(
      "protocol-and-permissions-registered",
      "注册本地资源协议与媒体权限",
      () => {
        registerPetResourceProtocol();
        session.defaultSession.setPermissionRequestHandler(
          (webContents, permission, callback, details) => {
            const mediaTypes =
              permission === "media" && "mediaTypes" in details && Array.isArray(details.mediaTypes)
                ? details.mediaTypes
                : [];
            const isAudioOnlyRequest =
              mediaTypes.length > 0 && mediaTypes.every((mediaType) => mediaType === "audio");

            callback(
              permission === "media" &&
                isAudioOnlyRequest &&
                isPetWindowWebContents(webContents)
            );
          }
        );
      }
    );
    mainWindow = startupProfiler.measureSyncOnce(
      "main-window-created",
      "创建主窗口并发起页面加载",
      createMainWindow
    );
    startupProfiler.measureSyncOnce("ipc-and-tray-registered", "注册 IPC 与托盘", () => {
      registerIpc(ipcMain, () => mainWindow);
      createAppTray(() => mainWindow);
    });
    startupProfiler.markOnce("main-startup-scheduled", "主进程启动任务已全部提交");

    mainWindow.on("close", (event) => {
      if (isQuitting) {
        return;
      }

      event.preventDefault();
      isQuitting = true;
      void closePetWindow({ playEffect: false })
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
        .finally(() => app.quit());
    }
  });
}
