import { app, net, protocol } from "electron";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const petResourceProtocol = "pet-resource";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Cross-Origin-Resource-Policy": "cross-origin"
};
const previewRoots = new Map<string, string>();

function getPetsRootPath(): string {
  return path.join(app.getPath("userData"), "pets");
}


function resolvePetResourcePath(url: string): string {
  const parsedUrl = new URL(url);

  if (parsedUrl.hostname === "preview") {
    const [token, ...resourceParts] = parsedUrl.pathname.split("/").filter(Boolean);
    const previewRootPath = token ? previewRoots.get(token) : undefined;

    if (!previewRootPath || !resourceParts.length) {
      throw new Error("Invalid preview resource path.");
    }

    const targetPath = path.resolve(previewRootPath, ...resourceParts.map((part) => decodeURIComponent(part)));
    const safeRelativePath = path.relative(previewRootPath, targetPath);

    if (safeRelativePath.startsWith("..") || path.isAbsolute(safeRelativePath)) {
      throw new Error("Invalid preview resource path.");
    }

    return targetPath;
  }

  const hostParts = parsedUrl.hostname === "local" ? [] : [parsedUrl.hostname];
  const parts = [...hostParts, ...parsedUrl.pathname.split("/")].filter(Boolean);
  const relativePath = parts.map((part) => decodeURIComponent(part)).join(path.sep);
  const petsRootPath = path.resolve(getPetsRootPath());
  const targetPath = path.resolve(petsRootPath, relativePath);
  const safeRelativePath = path.relative(petsRootPath, targetPath);

  if (!safeRelativePath || safeRelativePath.startsWith("..") || path.isAbsolute(safeRelativePath)) {
    throw new Error("Invalid pet resource path.");
  }

  return targetPath;
}

export function registerPetResourcePreviewRoot(rootPath: string): string {
  const token = randomUUID();

  previewRoots.set(token, path.resolve(rootPath));

  return token;
}

export function toPetPreviewResourceUrl(token: string, rootPath: string, filePath: string): string {
  const previewRootPath = path.resolve(rootPath);
  const targetPath = path.resolve(filePath);
  const relativePath = path.relative(previewRootPath, targetPath);

  if (!relativePath || relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
    throw new Error("Invalid preview resource file path.");
  }

  return `${petResourceProtocol}://preview/${encodeURIComponent(token)}/${relativePath
    .split(path.sep)
    .map(encodeURIComponent)
    .join("/")}`;
}

export function toPetResourceUrl(filePath: string): string {
  const petsRootPath = path.resolve(getPetsRootPath());
  const targetPath = path.resolve(filePath);
  const relativePath = path.relative(petsRootPath, targetPath);

  if (!relativePath || relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
    return pathToFileURL(targetPath).toString();
  }

  return `${petResourceProtocol}://local/${relativePath.split(path.sep).map(encodeURIComponent).join("/")}`;
}

export function registerPetResourceProtocol(): void {
  protocol.handle(petResourceProtocol, async (request) => {
    const filePath = resolvePetResourcePath(request.url);

    const response = await net.fetch(pathToFileURL(filePath).toString());
    const headers = new Headers(response.headers);

    for (const [header, value] of Object.entries(corsHeaders)) {
      headers.set(header, value);
    }

    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers
    });
  });
}
