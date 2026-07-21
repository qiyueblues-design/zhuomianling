import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WebContents } from "electron";

interface PendingLoad {
  resolve(): void;
  reject(error: Error): void;
}

const electronMock = vi.hoisted(() => ({
  workArea: { x: 0, y: 0, width: 1920, height: 1080 },
  matchingWorkArea: null as { x: number; y: number; width: number; height: number } | null,
  matchingScaleFactor: 1,
  displayMatchingCalls: [] as Array<{ x: number; y: number; width: number; height: number }>,
  screenListeners: new Map<string, Set<() => void>>(),
  cursorPoint: { x: 100, y: 100 },
  savedDesktopPositions: [] as Array<{ petId: string; position: { x: number; y: number } }>,
  instances: [] as Array<{
    destroyed: boolean;
    visible: boolean;
    loads: PendingLoad[];
    sent: Array<{ channel: string; payload?: unknown }>;
    destroyCalls: number;
    bounds: { x: number; y: number; width: number; height: number };
    setBoundsCalls: Array<{ x: number; y: number; width: number; height: number }>;
    ignoreMouseEventsCalls: Array<{ ignore: boolean; forward?: boolean }>;
    constructorOptions: Record<string, unknown>;
  }>
}));

vi.mock("./services/config/petConfigStore", () => ({
  saveLocalPetDesktopPosition: vi.fn(
    async (petId: string, position: { x: number; y: number }) => {
      electronMock.savedDesktopPositions.push({ petId, position: { ...position } });
      return undefined;
    }
  )
}));

vi.mock("electron", () => {
  class FakeBrowserWindow {
    destroyed = false;
    visible = false;
    loads: PendingLoad[] = [];
    sent: Array<{ channel: string; payload?: unknown }> = [];
    destroyCalls = 0;
    bounds: { x: number; y: number; width: number; height: number };
    setBoundsCalls: Array<{ x: number; y: number; width: number; height: number }> = [];
    ignoreMouseEventsCalls: Array<{ ignore: boolean; forward?: boolean }> = [];
    constructorOptions: Record<string, unknown>;
    private readonly listeners = new Map<string, Set<() => void>>();
    readonly webContents = {
      send: (channel: string, payload?: unknown): void => {
        this.sent.push({ channel, payload });
      },
      setWindowOpenHandler: vi.fn(),
      on: vi.fn()
    };

    constructor(options: unknown) {
      const bounds = options as { x: number; y: number; width: number; height: number };
      this.constructorOptions = options as Record<string, unknown>;
      this.bounds = {
        x: bounds.x,
        y: bounds.y,
        width: bounds.width,
        height: bounds.height
      };
      electronMock.instances.push(this);
    }

    on(event: string, listener: () => void): void {
      const listeners = this.listeners.get(event) ?? new Set<() => void>();
      listeners.add(listener);
      this.listeners.set(event, listeners);
    }

    loadURL(_url: string): Promise<void> {
      return new Promise<void>((resolve, reject) => {
        this.loads.push({ resolve, reject });
      });
    }

    destroy(): void {
      if (this.destroyed) {
        return;
      }

      this.destroyCalls += 1;
      this.destroyed = true;
      this.visible = false;
      this.emit("closed");
    }

    isDestroyed(): boolean {
      return this.destroyed;
    }

    isVisible(): boolean {
      return this.visible;
    }

    show(): void {
      this.visible = true;
      this.emit("show");
    }

    focus(): void {}
    setResizable(): void {}
    setAlwaysOnTop(): void {}
    setVisibleOnAllWorkspaces(): void {}
    setIgnoreMouseEvents(ignore: boolean, options?: { forward?: boolean }): void {
      this.ignoreMouseEventsCalls.push({ ignore, forward: options?.forward });
    }
    getPosition(): [number, number] {
      return [this.bounds.x, this.bounds.y];
    }
    getBounds(): { x: number; y: number; width: number; height: number } {
      return { ...this.bounds };
    }
    setBounds(bounds: { x: number; y: number; width: number; height: number }): void {
      this.bounds = { ...bounds };
      this.setBoundsCalls.push({ ...bounds });
    }

    private emit(event: string): void {
      for (const listener of this.listeners.get(event) ?? []) {
        listener();
      }
    }
  }

  FakeBrowserWindow.getAllWindows = (): FakeBrowserWindow[] => electronMock.instances;

  return {
    BrowserWindow: FakeBrowserWindow,
    screen: {
      getPrimaryDisplay: () => ({
        workArea: { ...electronMock.workArea },
        scaleFactor: 1
      }),
      getDisplayMatching: (bounds: { x: number; y: number; width: number; height: number }) => {
        electronMock.displayMatchingCalls.push({ ...bounds });
        return {
          workArea: { ...(electronMock.matchingWorkArea ?? electronMock.workArea) },
          scaleFactor: electronMock.matchingScaleFactor
        };
      },
      getCursorScreenPoint: () => ({ ...electronMock.cursorPoint }),
      on: (event: string, listener: () => void) => {
        const listeners = electronMock.screenListeners.get(event) ?? new Set<() => void>();
        listeners.add(listener);
        electronMock.screenListeners.set(event, listeners);
      }
    }
  };
});

function payload(
  id: string,
  desktopScale = 1,
  desktopPosition?: { x: number; y: number }
) {
  return {
    id,
    name: id,
    modelPath: `pet-resource://local/${id}/live2d/model.model3.json`,
    definition: {
      id,
      name: id,
      description: "",
      modelPath: `pet-resource://local/${id}/live2d/model.model3.json`,
      personaPrompt: "",
      capabilities: {
        chat: true,
        voiceInput: false,
        voiceOutput: false,
        subtitles: true
      },
      details: { role: "", personality: "", scenes: [], features: [] },
      uiSettings: { theme: "soft" as const, desktopScale, desktopPosition }
    }
  };
}

async function resolveNextLoad(instanceIndex = 0): Promise<void> {
  await vi.waitFor(() => {
    expect(electronMock.instances[instanceIndex]?.loads.length).toBeGreaterThan(0);
  });
  electronMock.instances[instanceIndex]?.loads.shift()?.resolve();
}

beforeEach(() => {
  electronMock.instances = [];
  electronMock.workArea = { x: 0, y: 0, width: 1920, height: 1080 };
  electronMock.matchingWorkArea = null;
  electronMock.matchingScaleFactor = 1;
  electronMock.displayMatchingCalls = [];
  electronMock.screenListeners = new Map();
  electronMock.cursorPoint = { x: 100, y: 100 };
  electronMock.savedDesktopPositions = [];
  vi.resetModules();
  vi.useFakeTimers();
});

describe("pet window operation generations", () => {
  it("creates a fixed non-resizable window at the saved desktop scale", async () => {
    const { closePetWindow, showPetWindow } = await import("./petWindow");
    const shown = showPetWindow(payload("pet-large", 1.5));
    await resolveNextLoad();
    await shown;

    expect(electronMock.instances[0]?.bounds).toEqual({
      x: 1322,
      y: 332,
      width: 570,
      height: 720
    });
    expect(electronMock.instances[0]?.constructorOptions.resizable).toBe(false);
    await closePetWindow({ playEffect: false });
  });

  it("keeps the bottom-center anchor and clamps a live scale update to the work area", async () => {
    const { closePetWindow, showPetWindow, updateCurrentPetWindowPayload } = await import(
      "./petWindow"
    );
    const shown = showPetWindow(payload("pet-a"));
    await resolveNextLoad();
    await shown;

    updateCurrentPetWindowPayload(payload("pet-a", 1.5));

    expect(electronMock.instances[0]?.bounds).toEqual({
      x: 1417,
      y: 332,
      width: 570,
      height: 720
    });
    await closePetWindow({ playEffect: false });
  });

  it("supports live enlarge, shrink and restore-to-100% updates without reopening", async () => {
    const { closePetWindow, showPetWindow, updateCurrentPetWindowPayload } = await import(
      "./petWindow"
    );
    const shown = showPetWindow(payload("pet-scale-cycle"));
    await resolveNextLoad();
    await shown;
    const instance = electronMock.instances[0];

    updateCurrentPetWindowPayload(payload("pet-scale-cycle", 1.5));
    expect(instance?.bounds).toMatchObject({ width: 570, height: 720 });

    updateCurrentPetWindowPayload(payload("pet-scale-cycle", 0.7));
    expect(instance?.bounds).toMatchObject({ width: 266, height: 336 });

    updateCurrentPetWindowPayload(payload("pet-scale-cycle", 1));
    expect(instance?.bounds).toMatchObject({ width: 380, height: 480 });
    expect(instance?.loads).toHaveLength(0);

    await closePetWindow({ playEffect: false });
  });

  it.each([
    {
      edge: "left",
      current: { x: -1910, y: 100, width: 380, height: 480 },
      expected: { x: -2005, y: -140, width: 570, height: 720 }
    },
    {
      edge: "right",
      current: { x: -390, y: 100, width: 380, height: 480 },
      expected: { x: -485, y: -140, width: 570, height: 720 }
    },
    {
      edge: "top",
      current: { x: -1300, y: -190, width: 380, height: 480 },
      expected: { x: -1395, y: -430, width: 570, height: 720 }
    },
    {
      edge: "bottom",
      current: { x: -1300, y: 410, width: 380, height: 480 },
      expected: { x: -1395, y: 170, width: 570, height: 720 }
    }
  ])("keeps a resized pet recoverable at the $edge edge of an offset display", async ({ current, expected }) => {
    const { calculateScaledPetWindowBounds } = await import("./petWindow");
    const workArea = { x: -1920, y: -200, width: 1920, height: 1080 };

    expect(calculateScaledPetWindowBounds(current, workArea, 1.5)).toEqual(expected);
  });

  it("uses the matching display's DIP work area across a different display scale factor", async () => {
    const { closePetWindow, showPetWindow, updateCurrentPetWindowPayload } = await import(
      "./petWindow"
    );
    const shown = showPetWindow(payload("pet-secondary-display"));
    await resolveNextLoad();
    await shown;
    const instance = electronMock.instances[0];

    if (!instance) {
      throw new Error("Expected a pet window instance.");
    }

    instance.bounds = { x: -1000, y: 100, width: 380, height: 480 };
    electronMock.matchingWorkArea = { x: -1280, y: 0, width: 1280, height: 720 };
    electronMock.matchingScaleFactor = 1.5;
    updateCurrentPetWindowPayload(payload("pet-secondary-display", 1.5));

    expect(instance.bounds).toEqual({ x: -1095, y: -140, width: 570, height: 720 });
    expect(electronMock.displayMatchingCalls.at(-1)).toEqual({
      x: -1000,
      y: 100,
      width: 380,
      height: 480
    });

    await closePetWindow({ playEffect: false });
  });

  it("preserves aspect ratio when the requested scale exceeds the display work area", async () => {
    electronMock.workArea = { x: 20, y: 30, width: 600, height: 700 };
    const { calculateScaledPetWindowBounds } = await import("./petWindow");

    expect(calculateScaledPetWindowBounds(
      { x: 120, y: 130, width: 380, height: 480 },
      electronMock.workArea,
      1.5
    )).toEqual({
      x: 33,
      y: -90,
      width: 554,
      height: 700
    });
  });

  it("drags with the scaled dimensions instead of snapping back to the base size", async () => {
    const {
      closePetWindow,
      endPetWindowDrag,
      movePetWindowDrag,
      showPetWindow,
      startPetWindowDrag
    } = await import("./petWindow");
    const shown = showPetWindow(payload("pet-drag", 1.5));
    await resolveNextLoad();
    await shown;

    startPetWindowDrag({ x: 0, y: 0 });
    electronMock.cursorPoint = { x: 150, y: 130 };
    movePetWindowDrag({ x: 0, y: 0 });
    await endPetWindowDrag();

    expect(electronMock.instances[0]?.bounds).toEqual({
      x: 1372,
      y: 362,
      width: 570,
      height: 720
    });
    await closePetWindow({ playEffect: false });
  });

  it("keeps a deliberately submerged pet partially visible across refresh and scaling", async () => {
    const {
      closePetWindow,
      endPetWindowDrag,
      movePetWindowDrag,
      showPetWindow,
      startPetWindowDrag,
      updateCurrentPetWindowPayload
    } = await import("./petWindow");
    const shown = showPetWindow(payload("pet-submerged"));
    await resolveNextLoad();
    await shown;
    const instance = electronMock.instances[0];

    startPetWindowDrag({ x: 100, y: 100 });
    electronMock.cursorPoint = { x: 100, y: 600 };
    movePetWindowDrag({ x: 100, y: 600 });
    await endPetWindowDrag();

    expect(instance?.bounds).toEqual({ x: 1512, y: 1000, width: 380, height: 480 });
    expect(electronMock.savedDesktopPositions.at(-1)).toEqual({
      petId: "pet-submerged",
      position: { x: 1512, y: 1000 }
    });

    startPetWindowDrag({ x: 100, y: 600 });
    expect(instance?.bounds.y).toBe(1000);
    await endPetWindowDrag();

    updateCurrentPetWindowPayload(payload("pet-submerged", 1.5, { x: 1512, y: 1000 }));
    expect(instance?.bounds).toEqual({ x: 1417, y: 760, width: 570, height: 720 });

    await closePetWindow({ playEffect: false });
  });

  it("allows both horizontal edges to leave 300 DIP off-screen while keeping a recoverable strip", async () => {
    const { closePetWindow, endPetWindowDrag, movePetWindowDrag, showPetWindow, startPetWindowDrag } =
      await import("./petWindow");
    const shown = showPetWindow(payload("pet-horizontal-overflow"));
    await resolveNextLoad();
    await shown;

    startPetWindowDrag({ x: 100, y: 100 });
    electronMock.cursorPoint = { x: 2500, y: 100 };
    movePetWindowDrag({ x: 2500, y: 100 });
    await endPetWindowDrag();
    expect(electronMock.instances[0]?.bounds.x).toBe(1840);

    startPetWindowDrag({ x: 2500, y: 100 });
    electronMock.cursorPoint = { x: -2500, y: 100 };
    movePetWindowDrag({ x: -2500, y: 100 });
    await endPetWindowDrag();
    expect(electronMock.instances[0]?.bounds.x).toBe(-300);

    await closePetWindow({ playEffect: false });
  });

  it("restores a saved partially off-screen position and recovers it after display removal", async () => {
    const { closePetWindow, showPetWindow } = await import("./petWindow");
    const shown = showPetWindow(payload("pet-saved-position", 1, { x: 1300, y: 900 }));
    await resolveNextLoad();
    await shown;
    const instance = electronMock.instances[0];

    expect(instance?.bounds).toEqual({ x: 1300, y: 900, width: 380, height: 480 });

    electronMock.workArea = { x: 0, y: 0, width: 1280, height: 720 };
    electronMock.matchingWorkArea = electronMock.workArea;
    for (const listener of electronMock.screenListeners.get("display-removed") ?? []) {
      listener();
    }

    expect(instance?.bounds).toEqual({ x: 1200, y: 640, width: 380, height: 480 });
    await closePetWindow({ playEffect: false });
  });

  it("keeps click-through active, blocks dragging and still accepts a saved scale update", async () => {
    const {
      closePetWindow,
      getPetWindowState,
      movePetWindowDrag,
      setPetWindowClickThrough,
      showPetWindow,
      startPetWindowDrag,
      updateCurrentPetWindowPayload
    } = await import("./petWindow");
    const shown = showPetWindow(payload("pet-click-through", 1));
    await resolveNextLoad();
    await shown;
    const instance = electronMock.instances[0];
    const boundsBeforeDrag = { ...instance?.bounds };
    const setBoundsCountBeforeDrag = instance?.setBoundsCalls.length ?? 0;

    setPetWindowClickThrough(true);
    startPetWindowDrag({ x: 100, y: 100 });
    electronMock.cursorPoint = { x: 500, y: 500 };
    movePetWindowDrag({ x: 500, y: 500 });

    expect(instance?.bounds).toEqual(boundsBeforeDrag);
    expect(instance?.setBoundsCalls).toHaveLength(setBoundsCountBeforeDrag);
    expect(instance?.ignoreMouseEventsCalls.at(-1)).toEqual({ ignore: true, forward: true });

    updateCurrentPetWindowPayload(payload("pet-click-through", 0.7));
    expect(instance?.bounds).toMatchObject({ width: 266, height: 336 });
    expect(getPetWindowState()).toMatchObject({
      visible: true,
      clickThrough: true,
      petId: "pet-click-through"
    });

    await closePetWindow({ playEffect: false });
  });

  it("does not let a delayed close destroy a newer pet", async () => {
    const { closePetWindow, getPetWindowState, showPetWindow } = await import("./petWindow");
    const firstShow = showPetWindow(payload("pet-a"));
    await resolveNextLoad();
    await expect(firstShow).resolves.toMatchObject({ visible: true, petId: "pet-a" });

    const delayedClose = closePetWindow({ playEffect: true });
    const secondShow = showPetWindow(payload("pet-b"));
    await resolveNextLoad();
    await expect(secondShow).resolves.toMatchObject({ visible: true, petId: "pet-b" });

    await vi.advanceTimersByTimeAsync(3300);
    await expect(delayedClose).resolves.toMatchObject({ visible: true, petId: "pet-b" });
    expect(electronMock.instances[0]?.destroyCalls).toBe(0);
    expect(getPetWindowState()).toMatchObject({ visible: true, petId: "pet-b" });

    await closePetWindow({ playEffect: false });
  });

  it("keeps the last payload but resets a re-enabled pet to its default position", async () => {
    const { closePetWindow, showExistingPetWindow, showPetWindow } = await import("./petWindow");
    const firstShow = showPetWindow(payload("pet-a", 1.5, { x: 900, y: 700 }));
    await resolveNextLoad();
    await firstShow;
    expect(electronMock.instances[0]?.bounds).toEqual({
      x: 900,
      y: 700,
      width: 570,
      height: 720
    });
    await expect(closePetWindow({ playEffect: false })).resolves.toMatchObject({ visible: false });

    const restored = showExistingPetWindow();
    await resolveNextLoad(1);
    await expect(restored).resolves.toMatchObject({ visible: true, petId: "pet-a" });
    expect(electronMock.instances[1]?.bounds).toEqual({
      x: 1322,
      y: 332,
      width: 570,
      height: 720
    });
    expect(electronMock.savedDesktopPositions.at(-1)).toEqual({
      petId: "pet-a",
      position: { x: 1322, y: 332 }
    });

    await closePetWindow({ playEffect: false });
  });

  it("coalesces repeated close requests for the same generation", async () => {
    const { closePetWindow, showPetWindow } = await import("./petWindow");
    const shown = showPetWindow(payload("pet-a"));
    await resolveNextLoad();
    await shown;

    const firstClose = closePetWindow({ playEffect: true });
    const repeatedClose = closePetWindow({ playEffect: true });
    await vi.advanceTimersByTimeAsync(3300);
    await Promise.all([firstClose, repeatedClose]);

    expect(electronMock.instances[0]?.destroyCalls).toBe(1);
    expect(
      electronMock.instances[0]?.sent.filter((event) => event.channel === "pet-window:play-close-effect")
    ).toHaveLength(1);
  });

  it("exposes the incoming payload while a replacement page is loading", async () => {
    const { closePetWindow, getCurrentPetWindowPayload, showPetWindow } = await import("./petWindow");
    const firstShow = showPetWindow(payload("pet-a"));
    await resolveNextLoad();
    await firstShow;

    const replacementShow = showPetWindow(payload("pet-b"));
    await vi.waitFor(() => {
      expect(electronMock.instances[0]?.loads.length).toBeGreaterThan(0);
    });

    expect(getCurrentPetWindowPayload()?.id).toBe("pet-b");

    electronMock.instances[0]?.loads.shift()?.resolve();
    await expect(replacementShow).resolves.toMatchObject({ visible: true, petId: "pet-b" });
    await closePetWindow({ playEffect: false });
  });

  it("commits the replacement pet's saved scale only after its page loads", async () => {
    const { closePetWindow, showPetWindow } = await import("./petWindow");
    const firstShow = showPetWindow(payload("pet-small", 0.7));
    await resolveNextLoad();
    await firstShow;
    const instance = electronMock.instances[0];
    expect(instance?.bounds).toMatchObject({ width: 266, height: 336 });

    const replacementShow = showPetWindow(payload("pet-large", 1.5));
    await vi.waitFor(() => {
      expect(instance?.loads.length).toBeGreaterThan(0);
    });
    expect(instance?.bounds).toMatchObject({ width: 266, height: 336 });

    instance?.loads.shift()?.resolve();
    await replacementShow;
    expect(instance?.bounds).toMatchObject({ width: 570, height: 720 });

    await closePetWindow({ playEffect: false });
  });

  it("binds sensitive requests only after a pet load commits", async () => {
    const { closePetWindow, getBoundPetWindowPayload, showPetWindow } = await import("./petWindow");
    const firstShow = showPetWindow(payload("pet-a"));
    await vi.waitFor(() => {
      expect(electronMock.instances[0]?.loads.length).toBeGreaterThan(0);
    });
    const sender = electronMock.instances[0]?.webContents as unknown as WebContents;

    expect(getBoundPetWindowPayload(sender)).toBeUndefined();

    electronMock.instances[0]?.loads.shift()?.resolve();
    await firstShow;
    expect(getBoundPetWindowPayload(sender)?.id).toBe("pet-a");

    const replacementShow = showPetWindow(payload("pet-b"));
    await vi.waitFor(() => {
      expect(electronMock.instances[0]?.loads.length).toBeGreaterThan(0);
    });

    expect(getBoundPetWindowPayload(sender)).toBeUndefined();

    electronMock.instances[0]?.loads.shift()?.resolve();
    await replacementShow;
    expect(getBoundPetWindowPayload(sender)?.id).toBe("pet-b");
    expect(getBoundPetWindowPayload({} as WebContents)).toBeUndefined();

    await closePetWindow({ playEffect: false });
  });

  it("keeps the last successful payload when a replacement page fails to load", async () => {
    const { closePetWindow, getCurrentPetWindowPayload, showPetWindow } = await import("./petWindow");
    const firstShow = showPetWindow(payload("pet-a"));
    await resolveNextLoad();
    await firstShow;

    const replacementShow = showPetWindow(payload("pet-b", 1.5));
    await vi.waitFor(() => {
      expect(electronMock.instances[0]?.loads.length).toBeGreaterThan(0);
    });
    electronMock.instances[0]?.loads.shift()?.reject(new Error("load failed"));

    await expect(replacementShow).rejects.toThrow("load failed");
    expect(getCurrentPetWindowPayload()?.id).toBe("pet-a");
    expect(electronMock.instances[0]?.bounds).toEqual({
      x: 1512,
      y: 572,
      width: 380,
      height: 480
    });
    await closePetWindow({ playEffect: false });
  });

  it("queues a preview while opening a pet and sends later previews to its desktop window", async () => {
    const {
      closePetWindow,
      consumePendingPetWindowSourcePreview,
      previewPetWindowSource
    } = await import("./petWindow");
    const source = {
      sourceKind: "motion" as const,
      sourceFileName: "angry01.mtn",
      runtimeName: "Tap"
    };

    const openingPreview = previewPetWindowSource(payload("pet-a"), source);
    await resolveNextLoad();
    await expect(openingPreview).resolves.toMatchObject({ ok: true, state: { visible: true } });
    expect(consumePendingPetWindowSourcePreview()).toMatchObject({ source });
    expect(consumePendingPetWindowSourcePreview()).toBeUndefined();

    await expect(previewPetWindowSource(payload("pet-a"), source)).resolves.toMatchObject({ ok: true });
    expect(
      electronMock.instances[0]?.sent.find((event) => event.channel === "pet-window:preview-source")
    ).toMatchObject({ payload: { source } });

    await closePetWindow({ playEffect: false });
  });
});
