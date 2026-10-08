import type { ExtensionUIDialogOptions } from "@earendil-works/pi-coding-agent";

/** Manual navigation must not hold up completion of concurrent agent work. */
export function manualDialogOptions(options: ExtensionUIDialogOptions = {}): ExtensionUIDialogOptions {
  return { ...options, [Symbol.for("pi-extensions:input-dialog")]: false };
}
