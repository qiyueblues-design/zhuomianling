import type { WebContents } from "electron";

export type IpcAccess = "main" | "pet" | "both";

export function assertIpcSenderAllowed(
  channel: string,
  access: IpcAccess,
  sender: WebContents,
  mainSender: WebContents | undefined,
  isPetSender: boolean
): void {
  const fromMainWindow = sender === mainSender;

  if (
    (access === "main" && fromMainWindow) ||
    (access === "pet" && isPetSender) ||
    (access === "both" && (fromMainWindow || isPetSender))
  ) {
    return;
  }

  throw new Error(`IPC ${channel} 不允许从当前窗口调用。`);
}

export function assertIpcPetIdBound(
  channel: string,
  requestedPetId: string,
  boundPetId: string | undefined
): void {
  if (boundPetId && requestedPetId === boundPetId) {
    return;
  }

  throw new Error(`IPC ${channel} 请求的桌宠与当前窗口不匹配。`);
}
