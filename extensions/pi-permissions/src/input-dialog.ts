import type { ExtensionUIDialogOptions } from "@earendil-works/pi-coding-agent";

/** Manual filesystem approvals keep their UI without claiming an agent input wait. */
export function approvalDialogOptions(agentWait = true, options: ExtensionUIDialogOptions = {}): ExtensionUIDialogOptions {
  return agentWait ? options : Object.assign({ ...options }, { [Symbol.for("pi-extensions:input-dialog")]: false });
}
