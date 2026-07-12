import type { PetDefinition, PetExpressionSourceItem } from "./pet";

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
  petId?: string;
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

export interface PetWindowSourcePreviewRequest {
  petId: string;
  source: PetExpressionSourceItem;
}

export interface PetWindowSourcePreviewEvent {
  id: number;
  source: PetExpressionSourceItem;
}

export interface PetWindowSourcePreviewResult {
  ok: boolean;
  message?: string;
  state: PetWindowState;
  previewId?: number;
}

export interface PetWindowSourcePreviewFinishedEvent {
  id: number;
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
  previewSource(request: PetWindowSourcePreviewRequest): Promise<PetWindowSourcePreviewResult>;
  consumePendingSourcePreview(): Promise<PetWindowSourcePreviewEvent | undefined>;
  completeSourcePreview(id: number): Promise<void>;
  onStateChanged(callback: (state: PetWindowState) => void): () => void;
  onSourcePreview(callback: (event: PetWindowSourcePreviewEvent) => void): () => void;
  onSourcePreviewFinished(callback: (event: PetWindowSourcePreviewFinishedEvent) => void): () => void;
  onCursorMoved(callback: (point: PetWindowCursorPoint) => void): () => void;
  onCloseEffect(callback: () => void): () => void;
}
