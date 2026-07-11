import type { MainDesktopPetApi } from "../preload";
import type { PetDesktopPetApi } from "../preload/pet";

type DesktopPetApi = MainDesktopPetApi & PetDesktopPetApi;

declare global {
  interface Window {
    desktopPet?: DesktopPetApi;
    __desktopPetStartupSurfaceReady?: boolean;
  }
}

export {};
