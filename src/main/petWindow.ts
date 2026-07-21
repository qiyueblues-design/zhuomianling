import { BrowserWindow, screen } from "electron";
import path from "node:path";
import type { PetDefinition, PetDesktopPosition, PetLineEvent } from "../shared/types/pet";
import type {
  DesktopPetPayload,
  PetWindowDragPoint,
  PetWindowSourcePreviewEvent,
  PetWindowSourcePreviewResult,
  PetWindowState
} from "../shared/types/window";
import type { PetExpressionSourceItem } from "../shared/types/pet";
import type { WebContents } from "electron";
import { hardenWindowNavigation } from "./windowSecurity";
import {
  normalizePetDesktopPosition,
  normalizePetDesktopScale
} from "../shared/validation/petUiSettings";
import { saveLocalPetDesktopPosition } from "./services/config/petConfigStore";

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
let pendingSourcePreview: PetWindowSourcePreviewEvent | undefined;
let activeSourcePreview: PetWindowSourcePreviewEvent | undefined;
let sourcePreviewSequence = 0;
let displayListenersRegistered = false;
let resetPositionOnNextCreate = false;
let pendingDefaultPositionWindow: BrowserWindow | undefined;
const stateListeners = new Set<(state: PetWindowState) => void>();
const petWindowWidth = 380;
const petWindowHeight = 480;
const petWindowEdgeMargin = 28;
const petWindowMinimumVisibleWidth = 80;
const petWindowMinimumVisibleHeight = 80;
const closeEffectDurationMs = 3300;
const cursorTrackingIntervalMs = 50;
type ClosePetWindowOptions = {
  playEffect?: boolean;
};

interface WindowRectangle {
  x: number;
  y: number;
  width: number;
  height: number;
}

function getDesktopScale(payload: DesktopPetPayload | null | undefined): number {
  return normalizePetDesktopScale(payload?.definition?.uiSettings?.desktopScale);
}

function getScaledPetWindowSize(
  desktopScale: number,
  workArea: WindowRectangle
): Pick<WindowRectangle, "width" | "height"> {
  const effectiveScale = Math.min(
    desktopScale,
    workArea.width / petWindowWidth,
    workArea.height / petWindowHeight
  );

  return {
    width: Math.max(1, Math.round(petWindowWidth * effectiveScale)),
    height: Math.max(1, Math.round(petWindowHeight * effectiveScale))
  };
}

function clampCoordinate(value: number, minimum: number, maximum: number): number {
  return Math.min(Math.max(value, minimum), Math.max(minimum, maximum));
}

function clampPetWindowBoundsToWorkArea(
  bounds: WindowRectangle,
  workArea: WindowRectangle
): WindowRectangle {
  const minimumVisibleWidth = Math.min(bounds.width, petWindowMinimumVisibleWidth);
  const minimumVisibleHeight = Math.min(bounds.height, petWindowMinimumVisibleHeight);

  return {
    ...bounds,
    x: clampCoordinate(
      bounds.x,
      workArea.x - bounds.width + minimumVisibleWidth,
      workArea.x + workArea.width - minimumVisibleWidth
    ),
    y: clampCoordinate(
      bounds.y,
      workArea.y - bounds.height + minimumVisibleHeight,
      workArea.y + workArea.height - minimumVisibleHeight
    )
  };
}

export function calculateScaledPetWindowBounds(
  currentBounds: WindowRectangle,
  workArea: WindowRectangle,
  desktopScale: number
): WindowRectangle {
  const size = getScaledPetWindowSize(normalizePetDesktopScale(desktopScale), workArea);
  const anchorCenterX = currentBounds.x + currentBounds.width / 2;
  const anchorBottomY = currentBounds.y + currentBounds.height;
  const desiredX = Math.round(anchorCenterX - size.width / 2);
  const desiredY = Math.round(anchorBottomY - size.height);

  return clampPetWindowBoundsToWorkArea({
    x: desiredX,
    y: desiredY,
    width: size.width,
    height: size.height
  }, workArea);
}

function getInitialPetWindowBounds(
  payload: DesktopPetPayload,
  useDefaultPosition = false
): WindowRectangle {
  const desktopScale = getDesktopScale(payload);
  const savedPosition = useDefaultPosition
    ? undefined
    : normalizePetDesktopPosition(payload.definition?.uiSettings?.desktopPosition);
  const primaryWorkArea = screen.getPrimaryDisplay().workArea;
  const provisionalSize = getScaledPetWindowSize(desktopScale, primaryWorkArea);
  const workArea = savedPosition
    ? screen.getDisplayMatching({
        x: savedPosition.x,
        y: savedPosition.y,
        width: provisionalSize.width,
        height: provisionalSize.height
      }).workArea
    : primaryWorkArea;
  const size = getScaledPetWindowSize(getDesktopScale(payload), workArea);
  const desiredX = savedPosition?.x ?? Math.round(
    workArea.x + workArea.width - size.width - petWindowEdgeMargin
  );
  const desiredY = savedPosition?.y ?? Math.round(
    workArea.y + workArea.height - size.height - petWindowEdgeMargin
  );

  return clampPetWindowBoundsToWorkArea({
    x: desiredX,
    y: desiredY,
    width: size.width,
    height: size.height
  }, workArea);
}

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

function updateCurrentPetDesktopPosition(position: PetDesktopPosition): void {
  const definition = currentPet?.definition;

  if (!currentPet || !definition) {
    return;
  }

  currentPet = {
    ...currentPet,
    definition: {
      ...definition,
      uiSettings: {
        theme: definition.uiSettings?.theme ?? "soft",
        ...definition.uiSettings,
        desktopPosition: position
      }
    }
  };
}

async function persistCurrentPetWindowPosition(bounds: WindowRectangle): Promise<void> {
  const payload = currentPet;

  if (!payload) {
    return;
  }

  const desktopPosition = { x: bounds.x, y: bounds.y };
  updateCurrentPetDesktopPosition(desktopPosition);
  await saveLocalPetDesktopPosition(payload.id, desktopPosition);
}

function persistCurrentPetWindowPositionInBackground(bounds: WindowRectangle): void {
  void persistCurrentPetWindowPosition(bounds).catch(() => undefined);
}

function enforcePetWindowSize(payload: DesktopPetPayload | null | undefined = currentPet): void {
  if (!petWindow || petWindow.isDestroyed()) {
    return;
  }

  const bounds = petWindow.getBounds();
  const workArea = screen.getDisplayMatching(bounds).workArea;
  const nextBounds = calculateScaledPetWindowBounds(
    bounds,
    workArea,
    getDesktopScale(payload)
  );

  if (
    bounds.x === nextBounds.x &&
    bounds.y === nextBounds.y &&
    bounds.width === nextBounds.width &&
    bounds.height === nextBounds.height
  ) {
    return;
  }

  petWindow.setBounds(nextBounds, false);
  persistCurrentPetWindowPositionInBackground(nextBounds);
}

function registerDisplayRecoveryListeners(): void {
  if (displayListenersRegistered) {
    return;
  }

  displayListenersRegistered = true;
  const recoverPetWindow = (): void => enforcePetWindowSize(currentPet);
  screen.on("display-removed", recoverPetWindow);
  screen.on("display-metrics-changed", recoverPetWindow);
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

function createPetWindow(payload: DesktopPetPayload): BrowserWindow {
  registerDisplayRecoveryListeners();
  const preloadPath = path.join(__dirname, "../preload/pet.js");
  const useDefaultPosition = resetPositionOnNextCreate;
  const initialBounds = getInitialPetWindowBounds(payload, useDefaultPosition);

  const createdWindow = new BrowserWindow({
    width: initialBounds.width,
    height: initialBounds.height,
    x: initialBounds.x,
    y: initialBounds.y,
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
  resetPositionOnNextCreate = false;
  pendingDefaultPositionWindow = useDefaultPosition ? createdWindow : undefined;
  hardenWindowNavigation(createdWindow);

  createdWindow.on("closed", () => {
    if (petWindow !== createdWindow) {
      return;
    }

    if (pendingPetWindowLoad?.window === createdWindow) {
      pendingPetWindowLoad = undefined;
    }
    if (pendingDefaultPositionWindow === createdWindow) {
      pendingDefaultPositionWindow = undefined;
    }
    stopCursorTracking();
    resetPositionOnNextCreate = true;
    petWindow = null;
    clickThrough = false;
    clickThroughControlInteractive = false;
    dragStart = null;
    pendingSourcePreview = undefined;
    activeSourcePreview = undefined;
    emitStateChanged();
  });
  const reapplyWindowState = (): void => {
    applyPetWindowState();
    enforcePetWindowSize(currentPet);
  };
  createdWindow.on("show", reapplyWindowState);
  createdWindow.on("focus", reapplyWindowState);
  createdWindow.on("blur", reapplyWindowState);
  createdWindow.on("restore", reapplyWindowState);

  petWindow = createdWindow;
  applyPetWindowState();

  return createdWindow;
}

export async function showPetWindow(payload: DesktopPetPayload): Promise<PetWindowState> {
  const generation = ++petWindowOperationGeneration;
  const targetWindow = petWindow ?? createPetWindow(payload);

  pendingPetWindowLoad = {
    generation,
    window: targetWindow,
    payload
  };
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

    enforcePetWindowSize(currentPet);

    throw error;
  }

  if (
    generation !== petWindowOperationGeneration ||
    petWindow !== targetWindow ||
    targetWindow.isDestroyed()
  ) {
    return snapshot();
  }

  const committedPayload = pendingPetWindowLoad?.generation === generation
    ? pendingPetWindowLoad.payload
    : payload;
  currentPet = committedPayload;
  if (pendingPetWindowLoad?.generation === generation) {
    pendingPetWindowLoad = undefined;
  }
  applyPetWindowState();
  enforcePetWindowSize(committedPayload);
  if (pendingDefaultPositionWindow === targetWindow) {
    pendingDefaultPositionWindow = undefined;
    persistCurrentPetWindowPositionInBackground(targetWindow.getBounds());
  }
  targetWindow.show();
  targetWindow.focus();
  startCursorTracking();

  return emitStateChanged();
}

function nextSourcePreviewEvent(source: PetExpressionSourceItem): PetWindowSourcePreviewEvent {
  sourcePreviewSequence += 1;

  return {
    id: Date.now() * 1000 + (sourcePreviewSequence % 1000),
    source
  };
}

function emitSourcePreviewFinished(preview: PetWindowSourcePreviewEvent | undefined): void {
  if (!preview) {
    return;
  }

  for (const targetWindow of BrowserWindow.getAllWindows()) {
    targetWindow.webContents.send("pet-window:source-preview-finished", { id: preview.id });
  }
}

export async function previewPetWindowSource(
  payload: DesktopPetPayload,
  source: PetExpressionSourceItem
): Promise<PetWindowSourcePreviewResult> {
  const samePetWindow = Boolean(
    petWindow && !petWindow.isDestroyed() && currentPet?.id === payload.id
  );
  const preview = nextSourcePreviewEvent(source);
  emitSourcePreviewFinished(activeSourcePreview ?? pendingSourcePreview);
  activeSourcePreview = preview;
  pendingSourcePreview = undefined;

  if (!samePetWindow) {
    pendingSourcePreview = preview;
    try {
      const state = await showPetWindow(payload);

      return { ok: state.visible, state, previewId: state.visible ? preview.id : undefined };
    } catch {
      if (pendingSourcePreview === preview) {
        pendingSourcePreview = undefined;
      }
      if (activeSourcePreview === preview) {
        activeSourcePreview = undefined;
      }

      return {
        ok: false,
        message: "桌面预览窗口未能启动。",
        state: snapshot()
      };
    }
  }

  currentPet = payload;
  enforcePetWindowSize(currentPet);
  applyPetWindowState();
  petWindow?.show();
  petWindow?.focus();
  startCursorTracking();
  petWindow?.webContents.send("pet-window:preview-source", preview);

  return { ok: true, state: emitStateChanged(), previewId: preview.id };
}

export function consumePendingPetWindowSourcePreview(): PetWindowSourcePreviewEvent | undefined {
  const preview = pendingSourcePreview;
  pendingSourcePreview = undefined;

  return preview;
}

export function completePetWindowSourcePreview(sender: WebContents, previewId: number): void {
  if (!isPetWindowWebContents(sender) || activeSourcePreview?.id !== previewId) {
    return;
  }

  const preview = activeSourcePreview;
  activeSourcePreview = undefined;
  emitSourcePreviewFinished(preview);
}

export async function showExistingPetWindow(): Promise<PetWindowState> {
  if (!petWindow && currentPet) {
    return showPetWindow(currentPet);
  }

  if (petWindow) {
    applyPetWindowState();
    enforcePetWindowSize(currentPet);
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
      pendingSourcePreview = undefined;
      activeSourcePreview = undefined;
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

export function getBoundPetWindowPayload(sender: WebContents): DesktopPetPayload | undefined {
  if (!isPetWindowWebContents(sender)) {
    return undefined;
  }

  if (
    pendingPetWindowLoad &&
    pendingPetWindowLoad.generation === petWindowOperationGeneration &&
    pendingPetWindowLoad.window === petWindow &&
    !pendingPetWindowLoad.window.isDestroyed()
  ) {
    return undefined;
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
  enforcePetWindowSize(currentPet);

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

  enforcePetWindowSize(currentPet);
  const bounds = petWindow.getBounds();
  const dragPoint = getCurrentDragPoint(point);
  dragStart = {
    pointer: dragPoint,
    window: {
      x: bounds.x,
      y: bounds.y,
      width: bounds.width,
      height: bounds.height
    }
  };
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

export async function endPetWindowDrag(): Promise<void> {
  if (!petWindow || petWindow.isDestroyed() || !dragStart) {
    dragStart = null;
    return;
  }

  dragStart = null;
  const bounds = petWindow.getBounds();
  const workArea = screen.getDisplayMatching(bounds).workArea;
  const nextBounds = clampPetWindowBoundsToWorkArea(bounds, workArea);

  if (
    bounds.x !== nextBounds.x ||
    bounds.y !== nextBounds.y ||
    bounds.width !== nextBounds.width ||
    bounds.height !== nextBounds.height
  ) {
    petWindow.setBounds(nextBounds, false);
    emitCursorMoved();
  }

  await persistCurrentPetWindowPosition(nextBounds);
}
