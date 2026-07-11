import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  LocalPetConfigCorruption,
  LocalPetListResult,
  PetDefinition
} from "../../shared/types/pet";
import { loadAvailablePets } from "./petSources";

function createPet(
  id: string,
  options: { isLocal?: boolean; modelPath?: string; modelReady?: boolean } = {}
): PetDefinition {
  return {
    id,
    name: id,
    description: "fixture",
    avatar: "",
    modelPath: options.modelPath ?? "",
    personaPrompt: "",
    isLocal: options.isLocal ?? false,
    details: {
      role: "fixture",
      personality: "fixture",
      scenes: [],
      scenarios: [],
      features: options.modelReady
        ? [{ title: "Live2D 显示", description: "fixture", status: "ready" }]
        : []
    },
    capabilities: {
      chat: false,
      voiceInput: false,
      voiceOutput: false,
      subtitles: false
    }
  } as PetDefinition;
}

function stubListLocal(result: LocalPetListResult): void {
  vi.stubGlobal("window", {
    desktopPet: {
      petConfig: {
        listLocal: vi.fn().mockResolvedValue(result)
      }
    }
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("loadAvailablePets", () => {
  it("keeps local drafts and usable imported pets while filtering unusable non-local entries", async () => {
    stubListLocal({
      ok: true,
      pets: [
        createPet("local-draft", { isLocal: true }),
        createPet("imported", { modelPath: "live2d/model.model3.json", modelReady: true }),
        createPet("unusable")
      ]
    });

    await expect(loadAvailablePets()).resolves.toMatchObject({
      pets: [{ id: "local-draft" }, { id: "imported" }]
    });
  });

  it("passes structured corruption details to the recovery UI", async () => {
    const corruption: LocalPetConfigCorruption = {
      code: "PET_CONFIG_CORRUPTED",
      petId: "damaged-pet",
      backupAvailable: true,
      message: "配置文件已损坏。"
    };
    stubListLocal({
      ok: false,
      pets: [createPet("healthy-pet", { isLocal: true })],
      corruption
    });

    await expect(loadAvailablePets()).resolves.toEqual({
      pets: [expect.objectContaining({ id: "healthy-pet" })],
      corruption
    });
  });

  it("returns an empty result when the Electron API is unavailable", async () => {
    vi.stubGlobal("window", {});

    await expect(loadAvailablePets()).resolves.toEqual({
      pets: [],
      corruption: undefined
    });
  });
});
