import { type ExtensionAPI, truncateHead } from "@earendil-works/pi-coding-agent";

export const MAX_GREP_OUTPUT_BYTES = 10 * 1024;
export const GREP_GUIDANCE = `## Grep
- Use specific paths/globs and start with \`limit: 20\`, \`context: 0\`.
- After locating a match, use a focused \`read\`.
- If truncated, narrow the search—do not raise the limit.
- Never run multiple broad greps in parallel.`;
const TRUNCATION_NOTICE = "[Output truncated by pi-grep-output-limit: 10KB maximum.]";
const NOTICE_SEPARATOR = "\n\n";
const CONTENT_BUDGET =
  MAX_GREP_OUTPUT_BYTES - Buffer.byteLength(NOTICE_SEPARATOR + TRUNCATION_NOTICE, "utf8");

/** Adds the search discipline once, including when a child inherits its parent's prompt. */
export function addGrepGuidance(systemPrompt: string): string {
  if (systemPrompt.includes(GREP_GUIDANCE)) return systemPrompt;
  return `${systemPrompt}\n\n${GREP_GUIDANCE}`;
}

/** Preserves complete leading lines while guaranteeing the notice fits inside the cap. */
export function limitGrepText(text: string): string {
  if (Buffer.byteLength(text, "utf8") <= MAX_GREP_OUTPUT_BYTES) return text;

  const truncated = truncateHead(text, {
    maxBytes: CONTENT_BUDGET,
    maxLines: Number.MAX_SAFE_INTEGER,
  });
  const separator = truncated.content.length > 0 ? NOTICE_SEPARATOR : "";
  return `${truncated.content}${separator}${TRUNCATION_NOTICE}`;
}

export default function (pi: ExtensionAPI): void {
  pi.on("before_agent_start", (event) => {
    const systemPrompt = addGrepGuidance(event.systemPrompt);
    if (systemPrompt === event.systemPrompt) return;
    return { systemPrompt };
  });

  pi.on("tool_result", (event) => {
    if (event.toolName !== "grep") return;

    let changed = false;
    const content = event.content.map((part) => {
      if (part.type !== "text") return part;
      const text = limitGrepText(part.text);
      if (text === part.text) return part;
      changed = true;
      return { ...part, text };
    });

    if (!changed) return;
    return { content };
  });
}
