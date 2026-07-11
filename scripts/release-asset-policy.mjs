const forbiddenSuffixes = [
  ".moc",
  ".moc3",
  ".model3.json",
  ".motion3.json",
  ".exp3.json",
  ".mtn",
  ".exp.json",
  ".pth",
  ".ckpt",
  ".wav",
  ".mp3",
  ".flac",
  ".ogg",
  ".aac",
  ".local.json",
  ".bak",
  ".tmp",
  ".test.js",
  ".spec.js"
];
const forbiddenFileNames = new Set([
  "pet.local.json",
  "ai-connections.json",
  "secure-secrets.json",
  "speech.local.json",
  "gpt-sovits.generated.yaml",
  ".desktop-pet-import-transaction.json"
]);
const forbiddenPathSegments = [
  "/gpt-sovits/",
  "/voice-model/",
  "/reference-audio/",
  "/.live2d-staging-",
  "/.live2d-backup-"
];

export function normalizeReleasePath(filePath) {
  return `/${String(filePath).replace(/\\/g, "/").replace(/^\/+/, "").toLowerCase()}`;
}

export function isForbiddenReleasePath(filePath) {
  const normalizedPath = normalizeReleasePath(filePath);
  const fileName = normalizedPath.split("/").pop() ?? "";

  return (
    normalizedPath === "/dist/renderer/live2d" ||
    normalizedPath.startsWith("/dist/renderer/live2d/") ||
    forbiddenFileNames.has(fileName) ||
    forbiddenSuffixes.some((suffix) => fileName.endsWith(suffix)) ||
    forbiddenPathSegments.some((segment) => normalizedPath.includes(segment))
  );
}

export function isProductionNodeModulePath(filePath) {
  const normalizedPath = normalizeReleasePath(filePath);

  return normalizedPath === "/node_modules" || normalizedPath.startsWith("/node_modules/");
}
