import { type ExtensionAPI, isToolCallEventType } from "@earendil-works/pi-coding-agent";
import { createBashOverride } from "./bash.ts";
import { FIND_MAX_RESULTS, GREP_MAX_MATCHES, LS_MAX_ENTRIES, READ_MAX_LINES } from "./limits.ts";
import {
  clampLimit,
  createFindOverride,
  createGrepOverride,
  createLsOverride,
  createReadOverride,
} from "./tools.ts";

export const GREP_GUIDANCE = `## Grep
- Use specific paths/globs and start with \`limit: 20\`, \`context: 0\`.
- After locating a match, use a focused \`read\`.
- If truncated, narrow the search—do not raise the limit.
- Never run multiple broad greps in parallel.`;

/** Adds the search discipline once, including when a child inherits its parent's prompt. */
export function addGrepGuidance(systemPrompt: string): string {
  if (systemPrompt.includes(GREP_GUIDANCE)) return systemPrompt;
  return `${systemPrompt}\n\n${GREP_GUIDANCE}`;
}

export function clampToolCallLimits(pi: ExtensionAPI): void {
  pi.on("tool_call", (event) => {
    if (isToolCallEventType("read", event)) {
      event.input.limit = clampLimit(event.input.limit, READ_MAX_LINES);
    } else if (isToolCallEventType("grep", event)) {
      event.input.limit = clampLimit(event.input.limit, GREP_MAX_MATCHES);
    } else if (isToolCallEventType("find", event)) {
      event.input.limit = clampLimit(event.input.limit, FIND_MAX_RESULTS);
    } else if (isToolCallEventType("ls", event)) {
      event.input.limit = clampLimit(event.input.limit, LS_MAX_ENTRIES);
    }
  });
}

export default function (pi: ExtensionAPI): void {
  pi.on("session_start", (_event, ctx) => {
    pi.registerTool(createReadOverride(ctx.cwd));
    pi.registerTool(createBashOverride(ctx.cwd));
    pi.registerTool(createGrepOverride(ctx.cwd));
    pi.registerTool(createFindOverride(ctx.cwd));
    pi.registerTool(createLsOverride(ctx.cwd));
  });

  clampToolCallLimits(pi);

  pi.on("before_agent_start", (event) => {
    const systemPrompt = addGrepGuidance(event.systemPrompt);
    if (systemPrompt === event.systemPrompt) return;
    return { systemPrompt };
  });
}

export { createBashOverride } from "./bash.ts";
export {
  BASH_MAX_LINES,
  FIND_MAX_RESULTS,
  GREP_MAX_LINE_LENGTH,
  GREP_MAX_MATCHES,
  LS_MAX_ENTRIES,
  MAX_OUTPUT_BYTES,
  READ_MAX_LINES,
} from "./limits.ts";
export {
  createFindOverride,
  createGrepOverride,
  createLsOverride,
  createReadOverride,
  splitNativeReadSuffix,
} from "./tools.ts";
