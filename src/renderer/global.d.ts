import type { DesktopPetApi } from "../preload";

declare global {
  interface Window {
    desktopPet?: DesktopPetApi;
    __desktopPetStartupSurfaceReady?: boolean;
  }
}

export {};
