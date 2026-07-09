import { BrowserWindow, screen } from "electron";
import path from "node:path";
import type { PetDefinition, PetLineEvent } from "../shared/types/pet";
import type { DesktopPetPayload, PetWindowDragPoint, PetWindowState } from "../shared/types/window";

let petWindow: BrowserWindow | null = null;
let currentPet: DesktopPetPayload | null = null;
let clickThrough = false;
let clickThroughControlInteractive = false;
let cursorTrackingTimer: NodeJS.Timeout | undefined;
let dragStart:
  | {
      pointer: PetWindowDragPoint;
      window: { x: number; y: number };
    }
  | null = null;
const stateListeners = new Set<(state: PetWindowState) => void>();
const closeEffectDurationMs = 3300;
const cursorTrackingIntervalMs = 50;
type ClosePetWindowOptions = {
  playEffect?: boolean;
};

function normalizeCloseLineText(line: unknown): { text?: string; audioPath?: string } | undefined {
  if (typeof line === "string") {
    return { text: line };
  }

  if (!line || typeof line !== "object") {
    return undefined;
  }

  const item = line as { text?: unknown; audioPath?: unknown };

  return {
    text: typeof item.text === "string" ? item.text : undefined,
    audioPath: typeof item.audioPath === "string" ? item.audioPath : undefined
  };
}

function hasConfiguredPetEvent(pet: PetDefinition | undefined, eventName: PetLineEvent): boolean {
  const configuredSource = pet?.eventSettings?.[eventName]?.source;
  const hasSource = Boolean(configuredSource?.sourceFileName?.trim());
  const configuredExpression = pet?.eventSettings?.[eventName]?.expression;
  const hasExpression = Boolean(configuredExpression && pet?.expressions?.[configuredExpression]);
  const hasLine = Boolean(
    pet?.lines?.[eventName]?.some((line) => {
      const normalizedLine = normalizeCloseLineText(line);

      return Boolean(normalizedLine?.text?.trim() || normalizedLine?.audioPath?.trim());
    })
  );

  return hasSource || hasExpression || hasLine;
}

function getPetWindowUrl(payload: DesktopPetPayload): string {
  const searchParams = new URLSearchParams({
    petId: payload.id,
    petName: payload.name,
    modelPath: payload.modelPath,
    avatar: payload.avatar ?? payload.name.slice(0, 2).toUpperCase()
  });

  const devServerUrl = process.env.VITE_DEV_SERVER_URL;

  if (devServerUrl) {
    return `${devServerUrl}/pet.html?${searchParams.toString()}`;
  }

  const filePath = path.join(__dirname, "../renderer/pet.html").replace(/\\/g, "/");

  return `file:///${filePath}?${searchParams.toString()}`;
}

function applyPetWindowState(): void {
  if (!petWindow) {
    return;
  }

  petWindow.setAlwaysOnTop(true, "screen-saver");
  petWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  petWindow.setIgnoreMouseEvents(clickThrough && !clickThroughControlInteractive, {
    forward: true
  });
}

function snapshot(): PetWindowState {
  return {
    visible: petWindow?.isVisible() ?? false,
    clickThrough
  };
}

function emitStateChanged(): PetWindowState {
  const state = snapshot();

  for (const listener of stateListeners) {
    listener(state);
  }

  return state;
}

function emitCursorMoved(): void {
  if (!petWindow || petWindow.isDestroyed()) {
    return;
  }

  const point = screen.getCursorScreenPoint();
  const [windowX, windowY] = petWindow.getPosition();

  petWindow.webContents.send("pet-window:cursor-moved", {
    screenX: point.x,
    screenY: point.y,
    windowX: point.x - windowX,
    windowY: point.y - windowY
  });
}

function startCursorTracking(): void {
  if (cursorTrackingTimer) {
    return;
  }

  emitCursorMoved();
  cursorTrackingTimer = setInterval(emitCursorMoved, cursorTrackingIntervalMs);
}

function stopCursorTracking(): void {
  if (!cursorTrackingTimer) {
    return;
  }

  clearInterval(cursorTrackingTimer);
  cursorTrackingTimer = undefined;
}

export function onPetWindowStateChanged(listener: (state: PetWindowState) => void): () => void {
  stateListeners.add(listener);

  return () => {
    stateListeners.delete(listener);
  };
}

function createPetWindow(): BrowserWindow {
  const preloadPath = path.join(__dirname, "../preload/index.js");
  const display = screen.getPrimaryDisplay();
  const width = 380;
  const height = 480;
  const x = Math.round(display.workArea.x + display.workArea.width - width - 28);
  const y = Math.round(display.workArea.y + display.workArea.height - height - 28);

  const createdWindow = new BrowserWindow({
    width,
    height,
    x,
    y,
    minWidth: 320,
    minHeight: 360,
    frame: false,
    transparent: true,
    resizable: true,
    skipTaskbar: true,
    hasShadow: false,
    backgroundColor: "#00000000",
    title: "桌宠窗口",
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  createdWindow.on("closed", () => {
    stopCursorTracking();
    petWindow = null;
    currentPet = null;
    clickThrough = false;
    clickThroughControlInteractive = false;
    dragStart = null;
    emitStateChanged();
  });

  petWindow = createdWindow;
  applyPetWindowState();

  return createdWindow;
}

export async function showPetWindow(payload: DesktopPetPayload): Promise<PetWindowState> {
  currentPet = payload;
  const targetWindow = petWindow ?? createPetWindow();

  await targetWindow.loadURL(getPetWindowUrl(payload));
  applyPetWindowState();
  targetWindow.show();
  targetWindow.focus();
  startCursorTracking();

  return emitStateChanged();
}

export function showExistingPetWindow(): PetWindowState {
  if (!petWindow && currentPet) {
    void showPetWindow(currentPet);
    return {
      visible: true,
      clickThrough
    };
  }

  petWindow?.show();
  return emitStateChanged();
}

export async function closePetWindow(options: ClosePetWindowOptions = {}): Promise<PetWindowState> {
  const playEffect =
    options.playEffect ?? hasConfiguredPetEvent(currentPet?.definition, "closing");
  const targetWindow = petWindow;

  if (petWindow && !petWindow.isDestroyed()) {
    petWindow.setIgnoreMouseEvents(false);
    if (playEffect) {
      petWindow.webContents.send("pet-window:play-close-effect");
      await new Promise((resolve) => setTimeout(resolve, closeEffectDurationMs));
    }
    petWindow.destroy();
  }

  petWindow = null;
  currentPet = null;
  clickThrough = false;
  clickThroughControlInteractive = false;
  dragStart = null;
  stopCursorTracking();

  if (!targetWindow) {
    return emitStateChanged();
  }

  return emitStateChanged();
}

export function setPetWindowClickThrough(value: boolean): PetWindowState {
  clickThrough = value;
  clickThroughControlInteractive = false;
  applyPetWindowState();
  return emitStateChanged();
}

export function togglePetWindowClickThrough(): PetWindowState {
  return setPetWindowClickThrough(!clickThrough);
}

export function getPetWindowState(): PetWindowState {
  return snapshot();
}

export function getCurrentPetWindowPayload(): DesktopPetPayload | undefined {
  return currentPet ?? undefined;
}

export function updateCurrentPetWindowPayload(payload: DesktopPetPayload): DesktopPetPayload | undefined {
  if (!currentPet || currentPet.id !== payload.id) {
    return currentPet ?? undefined;
  }

  currentPet = payload;

  return currentPet;
}

export function setPetWindowClickThroughControlInteractive(value: boolean): PetWindowState {
  if (!petWindow || petWindow.isDestroyed()) {
    return snapshot();
  }

  clickThroughControlInteractive = clickThrough && value;
  applyPetWindowState();

  return snapshot();
}

export function startPetWindowDrag(point: PetWindowDragPoint): void {
  if (!petWindow || petWindow.isDestroyed() || clickThrough) {
    return;
  }

  const [x, y] = petWindow.getPosition();
  dragStart = {
    pointer: point,
    window: { x, y }
  };
}

export function movePetWindowDrag(point: PetWindowDragPoint): void {
  if (!petWindow || petWindow.isDestroyed() || !dragStart || clickThrough) {
    return;
  }

  const nextX = dragStart.window.x + point.x - dragStart.pointer.x;
  const nextY = dragStart.window.y + point.y - dragStart.pointer.y;
  petWindow.setPosition(Math.round(nextX), Math.round(nextY), false);
  emitCursorMoved();
}

export function endPetWindowDrag(): void {
  dragStart = null;
}
