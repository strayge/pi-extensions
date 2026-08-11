import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { prioritizeModelsCommand } from "./autocomplete.ts";
import { chooseModel } from "./selector.ts";
import { modelKey } from "./sort.ts";
import { loadHistory, mutateHistory } from "./store.ts";

export default function (pi: ExtensionAPI): void {
  pi.on("session_start", (_event, ctx) => {
    if (ctx.mode !== "tui") return;
    ctx.ui.addAutocompleteProvider((current) => ({
      async getSuggestions(lines, cursorLine, cursorCol, options) {
        const result = await current.getSuggestions(lines, cursorLine, cursorCol, options);
        if (!result) return null;
        const textBeforeCursor = (lines[cursorLine] ?? "").slice(0, cursorCol);
        return { ...result, items: prioritizeModelsCommand(result.items, textBeforeCursor) };
      },
      applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
        return current.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
      },
      shouldTriggerFileCompletion(lines, cursorLine, cursorCol) {
        return current.shouldTriggerFileCompletion?.(lines, cursorLine, cursorCol) ?? true;
      },
    }));
  });

  pi.on("model_select", async (event) => {
    try {
      await mutateHistory((history) => {
        const record = history.models[modelKey(event.model)] ?? {};
        record.lastUsedAt = Date.now();
        history.models[modelKey(event.model)] = record;
      });
    } catch {
      /* Persistence must not take down the event dispatcher. */
    }
  });
  pi.registerCommand("models", {
    description: "Choose from all available models",
    handler: async (_args, ctx) => {
      const history = await loadHistory();
      const states = Object.fromEntries(
        Object.entries(history.models).map(([key, value]) => [key, { ...value }]),
      );
      const models = ctx.modelRegistry.getAvailable();
      const result = await chooseModel(ctx, {
        models,
        states,
        current: ctx.model ? modelKey(ctx.model) : undefined,
      });
      if (result.favorites && Object.keys(result.favorites).length > 0) {
        try {
          await mutateHistory((next) => {
            for (const [key, favorite] of Object.entries(result.favorites ?? {})) {
              next.models[key] = { ...next.models[key], favorite };
            }
          });
        } catch (error) {
          ctx.ui.notify(`Could not save model favorite: ${String(error)}`, "error");
        }
      }
      if (!result.model) return;
      if (ctx.mode !== "tui") {
        const action = await ctx.ui.select("Model action", ["Select", "Toggle favorite", "Cancel"]);
        if (action === "Toggle favorite") {
          const key = modelKey(result.model);
          states[key] = { ...states[key], favorite: !states[key]?.favorite };
          try {
            await mutateHistory((next) => {
              next.models[key] = { ...next.models[key], favorite: states[key]?.favorite };
            });
          } catch (error) {
            ctx.ui.notify(`Could not save model favorite: ${String(error)}`, "error");
          }
          return;
        }
        if (action !== "Select") return;
      }
      const selected = await pi.setModel(result.model as Parameters<typeof pi.setModel>[0]);
      if (!selected) ctx.ui.notify("Unable to select that model", "error");
    },
  });
}
