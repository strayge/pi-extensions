import type {
  ExtensionCommandContext,
  ExtensionUIDialogOptions,
} from "@earendil-works/pi-coding-agent";

export function manualDialogOptions(options?: ExtensionUIDialogOptions): ExtensionUIDialogOptions {
  return Object.assign({ ...options }, { [Symbol.for("pi-extensions:input-dialog")]: false });
}

/** Library-native menus are manual without changing the shared UI or custom factories. */
export function manualMenuContext(ctx: ExtensionCommandContext): ExtensionCommandContext {
  const ui = ctx.ui;
  return {
    ...ctx,
    ui: {
      ...ui,
      confirm: (title, message, options) =>
        ui.confirm(title, message, manualDialogOptions(options)),
      select: (title, choices, options) => ui.select(title, choices, manualDialogOptions(options)),
      input: (title, placeholder, options) =>
        ui.input(title, placeholder, manualDialogOptions(options)),
    },
  };
}
