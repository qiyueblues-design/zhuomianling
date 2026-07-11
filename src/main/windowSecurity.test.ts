import type { BrowserWindow } from "electron";
import { describe, expect, it, vi } from "vitest";
import { hardenWindowNavigation } from "./windowSecurity";

describe("hardenWindowNavigation", () => {
  it("denies new windows, navigation, redirects, and webviews", () => {
    const listeners = new Map<string, (event: { preventDefault(): void }) => void>();
    const setWindowOpenHandler = vi.fn();
    const targetWindow = {
      webContents: {
        setWindowOpenHandler,
        on: (event: string, listener: (event: { preventDefault(): void }) => void) => {
          listeners.set(event, listener);
        }
      }
    } as unknown as BrowserWindow;

    hardenWindowNavigation(targetWindow);

    const openHandler = setWindowOpenHandler.mock.calls[0]?.[0] as (() => { action: string }) | undefined;
    expect(openHandler?.()).toEqual({ action: "deny" });

    for (const eventName of ["will-navigate", "will-redirect", "will-attach-webview"]) {
      const preventDefault = vi.fn();
      listeners.get(eventName)?.({ preventDefault });
      expect(preventDefault).toHaveBeenCalledOnce();
    }
  });
});
