import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isStaleExtensionContextError } from "./core.ts";
import { publishStatuslineItem } from "./publish.ts";
import { medianRequestRate } from "./speed.ts";

/** Rebuild from the selected branch so reloads and tree navigation cannot leak other requests. */
export function registerSpeedStatus(pi: ExtensionAPI): void {
  const publish = publishStatuslineItem(pi, { id: "speed" });

  const setStatus = (ctx: ExtensionContext, value: string | undefined) => {
    if (!ctx.hasUI) return;
    try {
      ctx.ui.setStatus("speed", value);
      publish(value);
    } catch (error) {
      if (!isStaleExtensionContextError(error)) throw error;
    }
  };

  const refresh = (ctx: ExtensionContext, model = ctx.model) => {
    if (!ctx.hasUI) return;
    const calls = model
      ? ctx.sessionManager.getBranch().flatMap((entry) => {
          if (entry.type !== "message" || entry.message.role !== "assistant") return [];
          const message = entry.message;
          if (message.provider !== model.provider || message.model !== model.id || !message.usage)
            return [];
          const start = message.timestamp;
          const end = Date.parse(entry.timestamp);
          return [
            {
              usage: message.usage,
              stopReason: message.stopReason,
              durationMs: Number.isFinite(start) && start >= 0 ? end - start : undefined,
            },
          ];
        })
      : [];
    const rate = medianRequestRate(calls);
    setStatus(ctx, rate === undefined ? undefined : `${rate.toFixed(1)} tok/s`);
  };

  pi.on("session_start", (_event, ctx) => refresh(ctx));
  pi.on("session_tree", (_event, ctx) => refresh(ctx));
  pi.on("model_select", (event, ctx) => refresh(ctx, event.model));
  // message_end runs before persistence; these boundaries can read the recorded request end.
  pi.on("tool_execution_start", (_event, ctx) => refresh(ctx));
  pi.on("turn_end", (_event, ctx) => refresh(ctx));
  pi.on("session_shutdown", (_event, ctx) => setStatus(ctx, undefined));
}
