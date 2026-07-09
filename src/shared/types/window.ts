import type { PetDefinition } from "./pet";

export interface DesktopPetPayload {
  id: string;
  name: string;
  modelPath: string;
  avatar?: string;
  definition?: PetDefinition;
}

export interface PetWindowState {
  visible: boolean;
  clickThrough: boolean;
}

export interface PetWindowDragPoint {
  x: number;
  y: number;
}

export interface PetWindowCursorPoint {
  screenX: number;
  screenY: number;
  windowX: number;
  windowY: number;
}

export interface PetWindowCloseOptions {
  playEffect?: boolean;
}

export interface DesktopAppWindowApi {
  isShown(): Promise<boolean>;
  revealStartupSurface(reason?: string): void;
  onShown(callback: () => void): () => void;
}

export interface DesktopPetWindowApi {
  show(payload: DesktopPetPayload): Promise<PetWindowState>;
  close(options?: PetWindowCloseOptions): Promise<PetWindowState>;
  getPayload(): Promise<DesktopPetPayload | undefined>;
  toggleClickThrough(): Promise<PetWindowState>;
  setClickThrough(value: boolean): Promise<PetWindowState>;
  setClickThroughControlInteractive(value: boolean): Promise<PetWindowState>;
  startDrag(point: PetWindowDragPoint): Promise<void>;
  moveDrag(point: PetWindowDragPoint): Promise<void>;
  endDrag(): Promise<void>;
  getState(): Promise<PetWindowState>;
  onStateChanged(callback: (state: PetWindowState) => void): () => void;
  onCursorMoved(callback: (point: PetWindowCursorPoint) => void): () => void;
  onCloseEffect(callback: () => void): () => void;
}
