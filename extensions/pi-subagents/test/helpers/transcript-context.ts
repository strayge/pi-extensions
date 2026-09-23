import type { Context } from "@earendil-works/pi-ai";
import {
  getCurrentSystemPrompt,
  getCurrentTools,
} from "@earendil-works/pi-ai/utils/transcript";

/** Provider calls now carry prompt and tool changes in system messages. */
export function contextToolNames(context: Context): string[] {
  return getCurrentTools(context.messages).map((tool) => tool.name);
}

export function contextSystemPrompt(context: Context): string {
  return getCurrentSystemPrompt(context.messages);
}
