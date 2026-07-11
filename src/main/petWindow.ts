import { BrowserWindow, screen } from "electron";
import path from "node:path";
import type { PetDefinition, PetLineEvent } from "../shared/types/pet";
import type { DesktopPetPayload, PetWindowDragPoint, PetWindowState } from "../shared/types/window";
import type { WebContents } from "electron";
import { hardenWindowNavigation } from "./windowSecurity";

let petWindow: BrowserWindow | null = null;
let currentPet: DesktopPetPayload | null = null;
let petWindowOperationGeneration = 0;
let pendingPetWindowLoad:
  | {
      generation: number;
      window: BrowserWindow;
      payload: DesktopPetPayload;
    }
  | undefined;
let closeOperation:
  | {
      generation: number;
      promise: Promise<PetWindowState>;
    }
  | undefined;
let clickThrough = false;
let clickThroughControlInteractive = false;
let cursorTrackingTimer: NodeJS.Timeout | undefined;
let dragStart:
  | {
      pointer: PetWindowDragPoint;
      window: { x: number; y: number; width: number; height: number };
    }
  | null = null;
const stateListeners = new Set<(state: PetWindowState) => void>();
const petWindowWidth = 380;
const petWindowHeight = 480;
const closeEffectDurationMs = 3300;
const cursorTrackingIntervalMs = 50;
type ClosePetWindowOptions = {
  playEffect?: boolean;
};

function getCurrentDragPoint(fallback: PetWindowDragPoint): PetWindowDragPoint {
  const point = screen.getCursorScreenPoint();

  if (Number.isFinite(point.x) && Number.isFinite(point.y)) {
    return point;
  }

  return fallback;
}

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

  petWindow.setResizable(false);
  petWindow.setAlwaysOnTop(true, "screen-saver");
  petWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  petWindow.setIgnoreMouseEvents(clickThrough && !clickThroughControlInteractive, {
    forward: true
  });
}

function enforcePetWindowSize(): void {
  if (!petWindow || petWindow.isDestroyed()) {
    return;
  }

  const bounds = petWindow.getBounds();

  if (bounds.width === petWindowWidth && bounds.height === petWindowHeight) {
    return;
  }

  petWindow.setBounds(
    {
      x: bounds.x,
      y: bounds.y,
      width: petWindowWidth,
      height: petWindowHeight
    },
    false
  );
}

function snapshot(): PetWindowState {
  const visible = Boolean(petWindow && !petWindow.isDestroyed() && petWindow.isVisible());

  return {
    visible,
    clickThrough,
    petId: visible ? currentPet?.id : undefined
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
  const preloadPath = path.join(__dirname, "../preload/pet.js");
  const display = screen.getPrimaryDisplay();
  const x = Math.round(display.workArea.x + display.workArea.width - petWindowWidth - 28);
  const y = Math.round(display.workArea.y + display.workArea.height - petWindowHeight - 28);

  const createdWindow = new BrowserWindow({
    width: petWindowWidth,
    height: petWindowHeight,
    x,
    y,
    minWidth: petWindowWidth,
    minHeight: petWindowHeight,
    maxWidth: petWindowWidth,
    maxHeight: petWindowHeight,
    frame: false,
    transparent: true,
    resizable: false,
    maximizable: false,
    skipTaskbar: true,
    hasShadow: false,
    backgroundColor: "#00000000",
    title: "桌宠窗口",
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      navigateOnDragDrop: false
    }
  });
  hardenWindowNavigation(createdWindow);

  createdWindow.on("closed", () => {
    if (petWindow !== createdWindow) {
      return;
    }

    if (pendingPetWindowLoad?.window === createdWindow) {
      pendingPetWindowLoad = undefined;
    }
    stopCursorTracking();
    petWindow = null;
    clickThrough = false;
    clickThroughControlInteractive = false;
    dragStart = null;
    emitStateChanged();
  });
  createdWindow.on("show", applyPetWindowState);
  createdWindow.on("focus", applyPetWindowState);
  createdWindow.on("blur", applyPetWindowState);
  createdWindow.on("restore", applyPetWindowState);

  petWindow = createdWindow;
  applyPetWindowState();

  return createdWindow;
}

export async function showPetWindow(payload: DesktopPetPayload): Promise<PetWindowState> {
  const generation = ++petWindowOperationGeneration;
  const targetWindow = petWindow ?? createPetWindow();

  pendingPetWindowLoad = {
    generation,
    window: targetWindow,
    payload
  };
  enforcePetWindowSize();
  try {
    await targetWindow.loadURL(getPetWindowUrl(payload));
  } catch (error: unknown) {
    if (
      pendingPetWindowLoad?.generation === generation &&
      pendingPetWindowLoad.window === targetWindow
    ) {
      pendingPetWindowLoad = undefined;
    }

    if (
      generation !== petWindowOperationGeneration ||
      petWindow !== targetWindow ||
      targetWindow.isDestroyed()
    ) {
      return snapshot();
    }

    throw error;
  }

  if (
    generation !== petWindowOperationGeneration ||
    petWindow !== targetWindow ||
    targetWindow.isDestroyed()
  ) {
    return snapshot();
  }

  currentPet = payload;
  if (pendingPetWindowLoad?.generation === generation) {
    pendingPetWindowLoad = undefined;
  }
  applyPetWindowState();
  enforcePetWindowSize();
  targetWindow.show();
  targetWindow.focus();
  startCursorTracking();

  return emitStateChanged();
}

export async function showExistingPetWindow(): Promise<PetWindowState> {
  if (!petWindow && currentPet) {
    return showPetWindow(currentPet);
  }

  if (petWindow) {
    applyPetWindowState();
    petWindow.show();
  }

  return emitStateChanged();
}

export async function closePetWindow(options: ClosePetWindowOptions = {}): Promise<PetWindowState> {
  const generation = petWindowOperationGeneration;
  const targetWindow = petWindow;

  if (!targetWindow || targetWindow.isDestroyed()) {
    return emitStateChanged();
  }

  if (closeOperation?.generation === generation) {
    return closeOperation.promise;
  }

  const playEffect =
    options.playEffect ?? hasConfiguredPetEvent(currentPet?.definition, "closing");
  const promise = (async (): Promise<PetWindowState> => {
    targetWindow.setIgnoreMouseEvents(false);

    if (playEffect) {
      targetWindow.webContents.send("pet-window:play-close-effect");
      await new Promise((resolve) => setTimeout(resolve, closeEffectDurationMs));
    }

    if (
      generation !== petWindowOperationGeneration ||
      petWindow !== targetWindow ||
      targetWindow.isDestroyed()
    ) {
      return snapshot();
    }

    targetWindow.destroy();

    if (petWindow === targetWindow) {
      stopCursorTracking();
      petWindow = null;
      clickThrough = false;
      clickThroughControlInteractive = false;
      dragStart = null;
      return emitStateChanged();
    }

    return snapshot();
  })();

  closeOperation = {
    generation,
    promise
  };

  try {
    return await promise;
  } finally {
    if (closeOperation?.promise === promise) {
      closeOperation = undefined;
    }
  }
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
  if (
    pendingPetWindowLoad &&
    pendingPetWindowLoad.generation === petWindowOperationGeneration &&
    pendingPetWindowLoad.window === petWindow &&
    !pendingPetWindowLoad.window.isDestroyed()
  ) {
    return pendingPetWindowLoad.payload;
  }

  return currentPet ?? undefined;
}

export function isPetWindowWebContents(sender: WebContents): boolean {
  return Boolean(petWindow && !petWindow.isDestroyed() && petWindow.webContents === sender);
}

export function updateCurrentPetWindowPayload(payload: DesktopPetPayload): DesktopPetPayload | undefined {
  if (pendingPetWindowLoad?.payload.id === payload.id) {
    pendingPetWindowLoad = {
      ...pendingPetWindowLoad,
      payload
    };
  }

  if (!currentPet || currentPet.id !== payload.id) {
    return getCurrentPetWindowPayload();
  }

  currentPet = payload;

  return currentPet;
}

export function clearCurrentPetWindowPayload(petId?: string): void {
  if (pendingPetWindowLoad && (!petId || pendingPetWindowLoad.payload.id === petId)) {
    pendingPetWindowLoad = undefined;
  }

  if (!currentPet || (petId && currentPet.id !== petId)) {
    return;
  }

  currentPet = null;
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

  const bounds = petWindow.getBounds();
  const dragPoint = getCurrentDragPoint(point);
  dragStart = {
    pointer: dragPoint,
    window: {
      x: bounds.x,
      y: bounds.y,
      width: petWindowWidth,
      height: petWindowHeight
    }
  };

  if (bounds.width !== petWindowWidth || bounds.height !== petWindowHeight) {
    enforcePetWindowSize();
  }
}

export function movePetWindowDrag(point: PetWindowDragPoint): void {
  if (!petWindow || petWindow.isDestroyed() || !dragStart || clickThrough) {
    return;
  }

  const dragPoint = getCurrentDragPoint(point);
  const nextX = dragStart.window.x + dragPoint.x - dragStart.pointer.x;
  const nextY = dragStart.window.y + dragPoint.y - dragStart.pointer.y;
  petWindow.setBounds(
    {
      x: Math.round(nextX),
      y: Math.round(nextY),
      width: dragStart.window.width,
      height: dragStart.window.height
    },
    false
  );
  emitCursorMoved();
}

export function endPetWindowDrag(): void {
  dragStart = null;
}
