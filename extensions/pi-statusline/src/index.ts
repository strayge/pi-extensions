/**
 * A configurable, text-only statusline for pi.
 *
 * Replaces the built-in footer with a layout the user owns: lines of items,
 * separators, and a left/right splitter, all described by a JSON file. The
 * shipped default reproduces pi's own footer exactly, so installing this
 * extension is visually a no-op until the layout is edited.
 *
 * Other extensions can publish their own items over pi's event bus — see
 * `slots.ts` for the protocol.
 */

import type {
  ExtensionAPI,
  ExtensionContext,
  ReadonlyFooterDataProvider,
} from "@earendil-works/pi-coding-agent";
import { lastResponseFromEntries } from "./cache-age.ts";
import { configPath, loadConfig } from "./config.ts";
import { runEditor } from "./editor.ts";
import { createFooterFactory } from "./footer.ts";
import { type GitStatus, gitStatusEqual, readGitStatus } from "./git-status.ts";
import { changedSlotOptions } from "./options-sync.ts";
import { createRuntime, resetRuntime, toolEnded, toolStarted } from "./runtime.ts";
import { SlotRegistry } from "./slots.ts";
import type { StatuslineConfig } from "./types.ts";

const GIT_STATUS_DEBOUNCE_MS = 400;

export default function statusline(pi: ExtensionAPI) {
  const runtime = createRuntime();
  let config: StatuslineConfig = loadConfig().config;
  let activeContext: ExtensionContext | undefined;
  let requestRender: (() => void) | undefined;
  let footerData: ReadonlyFooterDataProvider | undefined;

  const refresh = () => requestRender?.();
  const slots = new SlotRegistry(pi, refresh);
  slots.listen();

  // Git status is the one item that costs a subprocess, so it is only kept up
  // to date while something in the layout actually asks for it.
  let gitTimer: ReturnType<typeof setTimeout> | undefined;
  let gitInFlight = false;
  let gitPending = false;

  const wantsGitStatus = () =>
    config.lines.some((line) =>
      line.some((item) => item.type === "git_status" && item.hidden !== true),
    );

  const setGitStatus = (status: GitStatus | undefined) => {
    if (gitStatusEqual(runtime.gitStatus, status)) return;
    runtime.gitStatus = status;
    refresh();
  };

  const runGitStatus = async () => {
    const ctx = activeContext;
    if (!ctx || !wantsGitStatus()) return;
    if (gitInFlight) {
      gitPending = true;
      return;
    }
    gitInFlight = true;
    try {
      setGitStatus(await readGitStatus(pi, ctx.cwd));
    } catch {
      setGitStatus(undefined);
    } finally {
      gitInFlight = false;
      if (gitPending) {
        gitPending = false;
        void runGitStatus();
      }
    }
  };

  const scheduleGitStatus = () => {
    if (!wantsGitStatus()) return;
    if (gitTimer) clearTimeout(gitTimer);
    gitTimer = setTimeout(() => {
      gitTimer = undefined;
      void runGitStatus();
    }, GIT_STATUS_DEBOUNCE_MS);
  };

  /**
   * Adopt a layout, telling producers about any option they now own differently.
   *
   * The push is deliberately driven by the diff rather than by the act of
   * saving: a reload that read the same file back changes nothing, and a
   * producer's own config should not be rewritten because a session started.
   */
  const applyConfig = (next: StatuslineConfig) => {
    const changed = changedSlotOptions(config, next);
    config = next;
    for (const [id, instances] of changed) slots.pushOptions(id, instances);
    refresh();
    scheduleGitStatus();
  };

  const reloadConfig = (): string[] => {
    const loaded = loadConfig();
    applyConfig(loaded.config);
    return loaded.warnings;
  };

  const footerFactory = createFooterFactory({
    getConfig: () => config,
    getContext: () => activeContext,
    runtime,
    slots,
    onRequestRender: (request) => {
      requestRender = request;
    },
    onFooterData: (data) => {
      footerData = data;
    },
  });

  pi.on("session_start", (_event, ctx) => {
    slots.setOwner(ctx.sessionManager.getSessionId());
    activeContext = ctx;
    resetRuntime(runtime);
    // A resumed session carries a prompt cache that expired while it was closed,
    // and that is precisely when saying so is worth something. Nothing in this
    // process has seen a response yet, so the clock starts from what is on disk.
    runtime.lastResponseAt = lastResponseFromEntries(ctx);

    if (!ctx.hasUI || ctx.mode !== "tui") return;

    // Re-installed per session rather than once: pi disposes the previous
    // component before calling the factory again, so this also re-arms the
    // render hook if anything else took the footer away in between.
    ctx.ui.setFooter(footerFactory);

    const warnings = reloadConfig();
    for (const warning of warnings) ctx.ui.notify(`statusline: ${warning}`, "warning");

    // Recover publications dropped before this session adopted its owner.
    slots.request();
    void runGitStatus();
  });

  pi.on("session_shutdown", () => {
    if (gitTimer) clearTimeout(gitTimer);
    gitTimer = undefined;
    slots.clear();
    slots.setOwner(undefined);
    activeContext = undefined;
  });

  pi.on("turn_start", () => {
    runtime.turnCount += 1;
    runtime.isStreaming = true;
    refresh();
  });

  pi.on("turn_end", () => {
    runtime.isStreaming = false;
    refresh();
  });

  // Assistant messages only: `message_end` also fires for user and tool-result
  // messages, and it is the response that writes the prompt cache.
  pi.on("message_end", (event) => {
    if (event.message?.role === "assistant") runtime.lastResponseAt = Date.now();
    refresh();
  });
  pi.on("model_select", () => refresh());
  pi.on("thinking_level_select", () => refresh());
  pi.on("session_info_changed", () => refresh());
  pi.on("session_compact", () => refresh());

  pi.on("tool_execution_start", (event) => {
    toolStarted(runtime, event.toolName);
    refresh();
  });

  pi.on("tool_execution_end", (event) => {
    toolEnded(runtime, event.toolName);
    refresh();
    scheduleGitStatus();
  });

  pi.on("agent_settled", () => {
    runtime.isStreaming = false;
    refresh();
    scheduleGitStatus();
  });

  pi.registerCommand("statusline", {
    description: "Edit the statusline layout",
    handler: async (args, ctx) => {
      const trimmed = args.trim();

      if (trimmed === "reload") {
        const warnings = reloadConfig();
        for (const warning of warnings) ctx.ui.notify(`statusline: ${warning}`, "warning");
        ctx.ui.notify(`Reloaded ${configPath()}`, "info");
        return;
      }

      if (trimmed === "path") {
        ctx.ui.notify(configPath(), "info");
        return;
      }

      // Surfaced here rather than from the paint path, which is no place to
      // write to the terminal: a producer whose `render` threw is reported the
      // next time the user comes to look at the layout.
      for (const failure of slots.takeRenderFailures()) {
        ctx.ui.notify(`statusline: ${failure}`, "warning");
      }

      await runEditor(ctx, {
        getConfig: () => config,
        setConfig: applyConfig,
        slots,
        runtime,
        getFooterData: () => footerData,
      });
    },
  });
}
