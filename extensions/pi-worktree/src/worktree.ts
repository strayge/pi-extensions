import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerWorktreeCommand } from "./command.ts";
import { registerWorktreeLifecycle } from "./lifecycle.ts";
import {
  createWorktreeSettingsRuntime,
  settingsFilePath,
  type WorktreeSettingsRuntime,
} from "./settings.ts";

interface WorktreeExtensionOptions {
  settings?: WorktreeSettingsRuntime;
}

export default function worktreeExtension(
  pi: ExtensionAPI,
  options: WorktreeExtensionOptions = {},
): void {
  const settings = options.settings ?? createWorktreeSettingsRuntime({ path: settingsFilePath });
  let sessionGeneration = 0;
  let menuController = new AbortController();
  const getOwner = () => {
    const generation = sessionGeneration;
    return {
      signal: menuController.signal,
      isCurrent: () => generation === sessionGeneration && !menuController.signal.aborted,
    };
  };
  const finish = registerWorktreeLifecycle(pi, settings, getOwner);
  registerWorktreeCommand(pi, settings, getOwner, finish);

  pi.on("session_start", async (_event, ctx) => {
    const generation = ++sessionGeneration;
    menuController.abort(new DOMException("Worktree session replaced", "AbortError"));
    menuController = new AbortController();
    const loaded = await settings.reload();
    if (generation !== sessionGeneration || !loaded.warning || !ctx.hasUI) return;
    ctx.ui.notify(loaded.warning, "warning");
  });
  pi.on("session_shutdown", async () => {
    sessionGeneration += 1;
    menuController.abort(new DOMException("Worktree session shut down", "AbortError"));
    await settings.flush?.();
  });
}
