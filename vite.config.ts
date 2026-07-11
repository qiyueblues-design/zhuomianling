import { defineConfig } from "vite";
import type { Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { cp, rm } from "node:fs/promises";
import { resolve } from "node:path";

const releasePublicDirectories = ["icons", "vendor"] as const;

function copyReleasePublicAssets(): Plugin {
  return {
    name: "copy-release-public-assets",
    apply: "build",
    async closeBundle() {
      const publicRoot = resolve(__dirname, "public");
      const rendererOutputRoot = resolve(__dirname, "dist/renderer");

      // Local development models may live under public/live2d, but release builds
      // must only contain the explicitly approved framework assets above.
      await rm(resolve(rendererOutputRoot, "live2d"), { recursive: true, force: true });
      await Promise.all(
        releasePublicDirectories.map((directoryName) =>
          cp(
            resolve(publicRoot, directoryName),
            resolve(rendererOutputRoot, directoryName),
            { recursive: true, force: true }
          )
        )
      );
    }
  };
}

export default defineConfig({
  plugins: [react(), copyReleasePublicAssets()],
  base: "./",
  build: {
    copyPublicDir: false,
    outDir: "dist/renderer",
    emptyOutDir: true,
    rollupOptions: {
      input: {
        main: resolve(__dirname, "index.html"),
        pet: resolve(__dirname, "pet.html")
      }
    }
  },
  server: {
    port: 5173,
    strictPort: true
  }
});
