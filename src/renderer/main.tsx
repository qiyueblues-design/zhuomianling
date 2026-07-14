window.desktopPet?.appWindow.reportStartupTiming("renderer-entry-started");

const reactModulePromise = import("react").then((module) => {
  window.desktopPet?.appWindow.reportStartupTiming("react-runtime-loaded");
  return module;
});
const reactDomModulePromise = import("react-dom/client").then((module) => {
  window.desktopPet?.appWindow.reportStartupTiming("react-dom-loaded");
  return module;
});
const stylesPromise = import("./styles.css").then(() => {
  window.desktopPet?.appWindow.reportStartupTiming("global-styles-loaded");
});
const appModulePromise = import("./app/App").then((module) => {
  window.desktopPet?.appWindow.reportStartupTiming("app-module-loaded");
  return module;
});

void Promise.all([
  reactModulePromise,
  reactDomModulePromise,
  stylesPromise,
  appModulePromise
]).then(([React, ReactDOM, _styles, { App }]) => {
  ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>
  );
  window.desktopPet?.appWindow.reportStartupTiming("react-render-submitted");
}).catch((error: unknown) => {
  console.error("Failed to bootstrap the main renderer.", error);
});
