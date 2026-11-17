import type { ExtensionAPI, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";

function lastUserEntry(ctx: ExtensionContext) {
  return ctx.sessionManager
    .getBranch()
    .findLast(
      (entry): entry is SessionEntry & { type: "message"; message: { role: "user" } } =>
        entry.type === "message" && entry.message.role === "user",
    );
}

export default function undoExtension(pi: ExtensionAPI) {
  let undoing = false;

  pi.registerCommand("undo", {
    description: "Stop and restore the last sent prompt, keeping any draft text",
    handler: async (_args, ctx) => {
      if (!ctx.hasUI || ctx.mode !== "tui") {
        ctx.ui.notify("/undo requires the interactive editor.", "warning");
        return;
      }
      if (undoing) return;
      const target = lastUserEntry(ctx);
      if (!target) {
        ctx.ui.notify("No user message to undo.", "info");
        return;
      }

      undoing = true;
      const sessionId = ctx.sessionManager.getSessionId();
      try {
        // In the TUI, abort also moves queued text back into the editor.
        ctx.abort();
        await ctx.waitForIdle();
        if (
          ctx.sessionManager.getSessionId() !== sessionId ||
          lastUserEntry(ctx)?.id !== target.id
        ) {
          ctx.ui.notify("The conversation changed; /undo was cancelled.", "warning");
          return;
        }

        const content = target.message.content;
        const text =
          typeof content === "string"
            ? content
            : content
                .filter((part) => part.type === "text")
                .map((part) => part.text)
                .join("");

        // Pi treats navigation to the current leaf as a no-op, even for user messages.
        if (ctx.sessionManager.getLeafId() === target.id) {
          pi.appendEntry("pi-undo-anchor", {});
        }
        const draft = ctx.ui.getEditorText();
        const result = await ctx.navigateTree(target.id, { summarize: false });
        if (result.cancelled) return;
        if (ctx.sessionManager.getSessionId() !== sessionId) return;

        const currentDraft = ctx.ui.getEditorText();
        // Pi may have filled an empty editor itself. Do not duplicate that restored prompt.
        const remainingDraft = !draft.trim() && currentDraft === text ? draft : currentDraft;
        ctx.ui.setEditorText([text, remainingDraft].filter((part) => part.length > 0).join("\n"));
      } catch (error) {
        ctx.ui.notify(`Undo failed: ${error instanceof Error ? error.message : error}`, "error");
      } finally {
        undoing = false;
      }
    },
  });

  pi.registerShortcut("alt+u", {
    description: "Undo the last sent prompt",
    handler: () => {
      // Shortcuts lack navigation methods; command dispatch supplies the command context.
      pi.sendUserMessage("/undo", { expandPromptTemplates: true });
    },
  });
}
