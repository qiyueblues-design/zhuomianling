import type { PetDefinition } from "./pet";

export type Live2DResourceCheckId = "entry" | "moc" | "textures" | "motions" | "expressions";

export type Live2DResourceCheckStatus = "ready" | "missing" | "empty" | "warning";
export type Live2DModelFormat = "cubism2" | "cubism4-5";

export interface Live2DResourceCheck {
  id: Live2DResourceCheckId;
  label: string;
  status: Live2DResourceCheckStatus;
  count: number;
  message: string;
  files: string[];
  missingFiles: string[];
}

export interface Live2DFolderScanResult {
  ok: boolean;
  message: string;
  modelFormat?: Live2DModelFormat;
  folderPath?: string;
  entryFilePath?: string;
  entryFileName?: string;
  entryRelativePath?: string;
  generatedEntryFileName?: string;
  needsGeneratedEntry?: boolean;
  checks: Live2DResourceCheck[];
  missingFiles: string[];
  textureCount: number;
  motionCount: number;
  expressionCount: number;
}

export interface Live2DPreviewModelResult {
  ok: boolean;
  message: string;
  modelPath?: string;
  scan?: Live2DFolderScanResult;
}

export interface Live2DFolderSelectResult extends Live2DFolderScanResult {
  canceled?: boolean;
}

export interface Live2DModelImportRequest {
  petId: string;
  sourceFolderPath: string;
}

export interface Live2DGeneratedEntryResult {
  ok: boolean;
  message: string;
  generatedEntryPath?: string;
  scan?: Live2DFolderScanResult;
}

export interface Live2DModelImportResult {
  ok: boolean;
  message: string;
  petId?: string;
  pet?: PetDefinition;
  modelPath?: string;
  scan?: Live2DFolderScanResult;
}

export type Live2DImportedSourceKind = "expression" | "motion";

export interface Live2DImportedSource {
  kind: Live2DImportedSourceKind;
  name: string;
  file: string;
  fileName: string;
}

export interface Live2DImportedSourceScanResult {
  ok: boolean;
  message: string;
  petId?: string;
  sources: Live2DImportedSource[];
}
