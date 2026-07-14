export const startupRendererStages = [
  "html-inline-script-started",
  "first-contentful-paint",
  "renderer-entry-started",
  "react-runtime-loaded",
  "react-dom-loaded",
  "global-styles-loaded",
  "app-module-loaded",
  "react-render-submitted",
  "react-mounted",
  "dom-content-loaded",
  "window-load-complete",
  "main-window-shown",
  "startup-surface-ready",
  "initial-pets-loaded",
  "minimum-splash-elapsed",
  "splash-exit-started",
  "splash-hidden"
] as const;

export type StartupRendererStage = (typeof startupRendererStages)[number];
