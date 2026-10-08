import path from "node:path";
import { DynamicBorder, ExtensionInputComponent, getSelectListTheme, keyHint, rawKeyHint, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Container, SelectList, Spacer, Text, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { bindPath, modelPath, within } from "./paths.ts";
import { approvalDialogOptions } from "./input-dialog.ts";
import type { Access, PathBinding } from "./schema.ts";

const manual = "Enter a path manually…";

/** Scope selection changes the preview, never the authority; approval remains a separate step. */
export async function editDirectoryScope(ctx: ExtensionContext, requested: string, current: string, access: Access, signal?: AbortSignal, agentWait = true): Promise<PathBinding | undefined> {
  signal?.throwIfAborted();
  const directories: string[] = [];
  for (let directory = requested; directory !== path.dirname(directory); directory = path.dirname(directory)) {
    directories.push(directory);
  }
  const items = directories.map((directory) => ({
    value: directory,
    label: directory === requested ? `${directory}  (requested directory)` : directory,
  }));
  items.push({ value: manual, label: manual });
  const title = `Choose directory scope · ${access === "read" ? "Read-only" : "Read/write"}`;
  const description = `Requested  ${requested}\nCurrent    ${current}\n\nEach option includes all files and subdirectories.\nChoosing a parent broadens the permission.`;
  const inputTitle = "Directory to authorize";
  const inputDescription = `Includes the directory and all descendants.\nThe scope must still contain the originally requested target.\n\nRequested  ${requested}`;
  let close: ((value: string | undefined) => void) | undefined;
  const abort = () => close?.(undefined);
  signal?.addEventListener("abort", abort, { once: true });
  try {
    let selected: string | undefined;
    if (ctx.mode === "tui") {
      const factory: Parameters<typeof ctx.ui.custom<string | undefined>>[0] = (tui, theme, _kb, done) => {
        close = done;
        const list = new SelectList(items, Math.min(items.length, 10), getSelectListTheme());
        // Reserve the list's prefix and safety margin so it cannot crop labels before wrapping.
        const listWidth = Math.max(...items.map((item) => visibleWidth(item.label))) + 4;
        const index = directories.indexOf(current);
        list.setSelectedIndex(index < 0 ? items.length - 1 : index);
        list.onSelect = (item) => done(item.value);
        list.onCancel = () => done(undefined);
        const container = new Container();
        container.addChild(new DynamicBorder());
        container.addChild(new Spacer(1));
        container.addChild(new Text(theme.fg("accent", theme.bold(title)), 1, 0));
        container.addChild(new Spacer(1));
        container.addChild(new Text(description, 1, 0));
        container.addChild(new Spacer(1));
        container.addChild({
          render: (width) => list.render(Math.max(listWidth, width)).flatMap((line) => wrapTextWithAnsi(line, Math.max(1, width))),
          invalidate: () => list.invalidate(),
        });
        container.addChild(new Spacer(1));
        container.addChild(new Text(`${rawKeyHint("↑↓", "navigate")}  ${keyHint("tui.select.confirm", "select")}  ${keyHint("tui.select.cancel", "cancel")}`, 1, 0));
        container.addChild(new Spacer(1));
        container.addChild(new DynamicBorder());
        if (signal?.aborted) done(undefined);
        return {
          render: (width) => container.render(width).map((line) => truncateToWidth(line, width, "")),
          invalidate: () => container.invalidate(),
          handleInput: (data) => { list.handleInput(data); tui.requestRender(); },
        };
      };
      selected = await ctx.ui.custom(agentWait ? Object.assign(factory, { [Symbol.for("pi-extensions:input-dialog")]: true }) : factory);
    } else {
      const label = await ctx.ui.select(`${title}\n\n${description}`, items.map((item) => item.label), approvalDialogOptions(agentWait, { signal }));
      selected = items.find((item) => item.label === label)?.value;
    }
    signal?.throwIfAborted();
    close = undefined;
    const manualEntry = selected === manual;
    if (manualEntry) {
      if (ctx.mode === "tui") {
        const factory: Parameters<typeof ctx.ui.custom<string | undefined>>[0] = (_tui, _theme, _kb, done) => {
          close = done;
          const input = new class extends ExtensionInputComponent {
            render(width: number): string[] {
              return super.render(width).map((line) => truncateToWidth(line, width, ""));
            }
          }(inputTitle, current, done, () => done(undefined), {
            initialValue: current,
            description: inputDescription,
          });
          if (signal?.aborted) done(undefined);
          return input;
        };
        selected = await ctx.ui.custom(agentWait ? Object.assign(factory, { [Symbol.for("pi-extensions:input-dialog")]: true }) : factory);
      } else {
        selected = await ctx.ui.input(`${inputTitle}\n\n${inputDescription}\nCurrent    ${current}`, current, approvalDialogOptions(agentWait, { signal }));
      }
      signal?.throwIfAborted();
    }
    if (!selected) return undefined;
    const binding = bindPath(manualEntry && selected !== current ? modelPath(selected, ctx.cwd) : selected);
    if (!within(binding.canonical, requested)) throw new Error("Edited directory must contain the requested target");
    if (!binding.missing.length && binding.identity.type !== "directory") throw new Error("Directory scope requires a directory");
    return binding;
  } finally {
    signal?.removeEventListener("abort", abort);
  }
}
