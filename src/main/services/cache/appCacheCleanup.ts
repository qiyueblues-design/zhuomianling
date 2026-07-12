import { app } from "electron";
import fs from "node:fs/promises";
import path from "node:path";

const safeCacheDirectoryNames = [
  "Cache",
  "Code Cache",
  "GPUCache",
  "DawnGraphiteCache",
  "DawnWebGPUCache"
] as const;

function assertContainedPath(rootPath: string, targetPath: string): void {
  const relativePath = path.relative(path.resolve(rootPath), path.resolve(targetPath));

  if (!relativePath || relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
    throw new Error("Cache cleanup path escaped the application user-data directory.");
  }
}

export async function clearSafeAppCaches(): Promise<void> {
  const userDataPath = path.resolve(app.getPath("userData"));

  for (const directoryName of safeCacheDirectoryNames) {
    const cacheDirectoryPath = path.resolve(userDataPath, directoryName);
    assertContainedPath(userDataPath, cacheDirectoryPath);

    try {
      const [realUserDataPath, cacheDirectoryStat] = await Promise.all([
        fs.realpath(userDataPath),
        fs.lstat(cacheDirectoryPath)
      ]);

      if (!cacheDirectoryStat.isDirectory() || cacheDirectoryStat.isSymbolicLink()) {
        console.warn("Skipped unsafe application cache path.", directoryName);
        continue;
      }

      const realCacheDirectoryPath = await fs.realpath(cacheDirectoryPath);
      assertContainedPath(realUserDataPath, realCacheDirectoryPath);
      await fs.rm(cacheDirectoryPath, { recursive: true, force: true, maxRetries: 2, retryDelay: 100 });
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        console.warn("Failed to clear application cache directory.", directoryName, error);
      }
    }
  }
}
