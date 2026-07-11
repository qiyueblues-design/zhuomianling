import { rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

await Promise.all(
  ["main", "preload", "shared"].map((directoryName) =>
    rm(path.join(projectRoot, "dist", directoryName), {
      recursive: true,
      force: true
    })
  )
);
