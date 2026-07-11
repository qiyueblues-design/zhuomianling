import { beforeEach, describe, expect, it, vi } from "vitest";

interface PendingLoad {
  resolve(): void;
  reject(error: Error): void;
}

const electronMock = vi.hoisted(() => ({
  instances: [] as Array<{
    destroyed: boolean;
    visible: boolean;
    loads: PendingLoad[];
    sent: Array<{ channel: string; payload?: unknown }>;
    destroyCalls: number;
  }>
}));

vi.mock("electron", () => {
  class FakeBrowserWindow {
    destroyed = false;
    visible = false;
    loads: PendingLoad[] = [];
    sent: Array<{ channel: string; payload?: unknown }> = [];
    destroyCalls = 0;
    private readonly listeners = new Map<string, Set<() => void>>();
    readonly webContents = {
      send: (channel: string, payload?: unknown): void => {
        this.sent.push({ channel, payload });
      },
      setWindowOpenHandler: vi.fn(),
      on: vi.fn()
    };

    constructor(_options: unknown) {
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
    setIgnoreMouseEvents(): void {}
    getPosition(): [number, number] {
      return [0, 0];
    }
    getBounds(): { x: number; y: number; width: number; height: number } {
      return { x: 0, y: 0, width: 380, height: 480 };
    }
    setBounds(): void {}

    private emit(event: string): void {
      for (const listener of this.listeners.get(event) ?? []) {
        listener();
      }
    }
  }

  return {
    BrowserWindow: FakeBrowserWindow,
    screen: {
      getPrimaryDisplay: () => ({
        workArea: { x: 0, y: 0, width: 1920, height: 1080 }
      }),
      getCursorScreenPoint: () => ({ x: 100, y: 100 })
    }
  };
});

function payload(id: string) {
  return {
    id,
    name: id,
    modelPath: `pet-resource://local/${id}/live2d/model.model3.json`
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
  vi.resetModules();
  vi.useFakeTimers();
});

describe("pet window operation generations", () => {
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

  it("keeps the last payload so the tray can restore a closed pet", async () => {
    const { closePetWindow, showExistingPetWindow, showPetWindow } = await import("./petWindow");
    const firstShow = showPetWindow(payload("pet-a"));
    await resolveNextLoad();
    await firstShow;
    await expect(closePetWindow({ playEffect: false })).resolves.toMatchObject({ visible: false });

    const restored = showExistingPetWindow();
    await resolveNextLoad(1);
    await expect(restored).resolves.toMatchObject({ visible: true, petId: "pet-a" });

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

  it("keeps the last successful payload when a replacement page fails to load", async () => {
    const { closePetWindow, getCurrentPetWindowPayload, showPetWindow } = await import("./petWindow");
    const firstShow = showPetWindow(payload("pet-a"));
    await resolveNextLoad();
    await firstShow;

    const replacementShow = showPetWindow(payload("pet-b"));
    await vi.waitFor(() => {
      expect(electronMock.instances[0]?.loads.length).toBeGreaterThan(0);
    });
    electronMock.instances[0]?.loads.shift()?.reject(new Error("load failed"));

    await expect(replacementShow).rejects.toThrow("load failed");
    expect(getCurrentPetWindowPayload()?.id).toBe("pet-a");
    await closePetWindow({ playEffect: false });
  });
});
