import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("Live2D desktop scale integration", () => {
  it("lets the pet shell and Live2D host grow with the normalized window scale", async () => {
    const [windowSource, styleSource] = await Promise.all([
      readFile(new URL("../pet-window/PetWindow.tsx", import.meta.url), "utf8"),
      readFile(new URL("../pet-window/pet-window.css", import.meta.url), "utf8")
    ]);

    expect(windowSource).toContain("normalizePetDesktopScale");
    expect(windowSource).toContain('"--desktop-scale": desktopScale');
    expect(styleSource).toMatch(/\.petWindowShell\s*{[^}]*width:\s*100%/s);
    expect(styleSource).not.toContain("width: min(100%, 380px)");
    expect(styleSource).toContain("calc(312px * var(--desktop-scale, 1))");
    expect(styleSource).toContain("calc(430px * var(--desktop-scale, 1))");
  });

  it("resizes the existing runtime from its host without adding scale to load dependencies", async () => {
    const source = await readFile(new URL("./Live2DCanvas.tsx", import.meta.url), "utf8");

    expect(source).toContain("new ResizeObserver");
    expect(source).toContain("model.resize()");
    expect(source).toContain("model.getRightFaceAnchorClientPoint()");
    expect(source).toContain("onRightFaceAnchorChangeRef.current?.(");
    expect(source).toContain("}, [autoIdle, fitMode, modelPath, neutralPreview]);");
    expect(source).not.toContain("desktopScale");
  });

  it("keeps CSS size, backing store, and visible-bottom fitting in both runtimes", async () => {
    const [cubism45, cubism2] = await Promise.all([
      readFile(new URL("./live2dRuntime.ts", import.meta.url), "utf8"),
      readFile(new URL("./live2dRuntimeV2.ts", import.meta.url), "utf8")
    ]);

    for (const source of [cubism45, cubism2]) {
      expect(source).toContain("parent?.clientWidth");
      expect(source).toContain("parent?.clientHeight");
      expect(source).toContain("this.canvas.width = nextWidth");
      expect(source).toContain("this.canvas.height = nextHeight");
      expect(source).toContain("stageBottomPaddingPixels");
      expect(source).toContain("this.modelBounds = this.measureModelBounds()");
      expect(source).toContain("getRightFaceAnchorClientPoint()");
      expect(source).toContain("projectRightFaceAnchorToClientPoint(");
    }
  });

  it("keeps drag, click-through, chat, subtitles and the radial menu mounted around scaling", async () => {
    const source = await readFile(
      new URL("../pet-window/PetWindow.tsx", import.meta.url),
      "utf8"
    );

    expect(source).toContain("useWindowDrag({");
    expect(source).toContain("clickThrough: state.clickThrough");
    expect(source).toContain("<Subtitle state={subtitle.state}");
    expect(source).toContain("anchor={rightFaceAnchor}");
    expect(source).toContain("onRightFaceAnchorChange={setRightFaceAnchor}");
    expect(source).toContain('className={chatCollapsed ? "petChatPanel collapsed" : "petChatPanel"}');
    expect(source).toContain("left: chatPanelPosition.left");
    expect(source).toContain("bottom: chatPanelPosition.bottom");
    expect(source).toContain("onPointerDown={startChatPanelDrag}");
    expect(source).toContain("onPointerMove={moveChatPanelDrag}");
    expect(source).toContain("onPointerUp={endChatPanelDrag}");
    expect(source).toContain("onPointerCancel={endChatPanelDrag}");
    expect(source).toContain("onContextMenu={showRadialMenu}");
    expect(source).toContain("<RadialPetMenu");
    expect(source).not.toContain("key={desktopScale}");
    expect(source).not.toContain("key={rightFaceAnchor");
  });

  it("saves all quick actions together and broadcasts the result to the active pet window", async () => {
    const [panelSource, ipcSource, windowSource] = await Promise.all([
      readFile(
        new URL("../components/PetEditor/QuickActionsPanel.tsx", import.meta.url),
        "utf8"
      ),
      readFile(new URL("../../main/ipc.ts", import.meta.url), "utf8"),
      readFile(new URL("../../main/petWindow.ts", import.meta.url), "utf8")
    ]);

    expect(panelSource).toContain("clickThroughOpacity: selectedOpacity");
    expect(panelSource).toContain("cursorFollowEnabled,");
    expect(panelSource).toContain("desktopScale: selectedDesktopScale");
    expect(ipcSource).toContain('handle("pet-config:save-ui-settings"');
    expect(ipcSource).toContain("updateCurrentPetWindowPayload({");
    expect(ipcSource).toContain('"pet-config:changed",');
    expect(ipcSource).toContain("isPetWindowWebContents(targetWindow.webContents) ? runtimePet : publicPet");
    expect(windowSource).toContain("currentPet = payload;");
    expect(windowSource).toContain("enforcePetWindowSize(currentPet);");
  });
});
