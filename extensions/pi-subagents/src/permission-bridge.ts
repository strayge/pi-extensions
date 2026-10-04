import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

export const PERMISSION_EXTENSION = "<inline:permission-policy-v2>";
export interface PermissionAttachment {
  factory(pi: ExtensionAPI): void;
  verify(): void;
  resume(cancel: () => void): () => void;
  release(): void;
}

/** Enforcement is mandatory for governed parents even when child extension visibility is disabled. */
export function attachParentPermissions(pi: ExtensionAPI, ctx: ExtensionContext, cancel: () => void): PermissionAttachment | undefined {
  const parentSessionId = ctx.sessionManager?.getSessionId?.();
  if (!parentSessionId || !pi.events?.emit) return undefined;
  let required = false;
  pi.events.emit("permission:present:v2", { parentSessionId, respond: () => { required = true; } });
  if (!required) return undefined;
  let attachment: PermissionAttachment | undefined;
  let failure: string | undefined;
  pi.events.emit("permission:attach:v2", {
    version: 2, parentSessionId, cancel,
    respond: (value: PermissionAttachment) => { attachment = value; },
    reject: (reason: string) => { failure = reason; },
  });
  if (failure || !attachment || typeof attachment.factory !== "function" || typeof attachment.verify !== "function" || typeof attachment.resume !== "function" || typeof attachment.release !== "function") throw new Error(`Required parent filesystem policy could not attach: ${failure ?? "missing bridge"}`);
  return attachment;
}
