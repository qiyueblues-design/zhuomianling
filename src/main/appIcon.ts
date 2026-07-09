import path from "node:path";

export function getAppIconPath(): string {
  return path.join(__dirname, "../../assets/icons/app-icon.ico");
}
