/**
 * The default layout reproduces pi's built-in footer line for line, so
 * installing this extension changes nothing until the user edits the config.
 *
 * Stock layout:
 *   ~/path/to/cwd (branch) • session-name
 *   ↑12k ↓3.4k R80k W2k CH94.1% $0.184 72.3%/200k        (provider) model • high
 *   <extension statuses, only when non-empty>
 */

import type { ItemConfig, StatuslineConfig } from "./types.ts";

const LINE_CWD: ItemConfig[] = [
  { type: "cwd", style: "home", priority: 90 },
  { type: "branch", prefix: " (", suffix: ")" },
  { type: "sep", text: " • " },
  { type: "session" },
];

const LINE_STATS: ItemConfig[] = [
  { type: "tokens_in", prefix: "↑" },
  { type: "sep" },
  { type: "tokens_out", prefix: "↓" },
  { type: "sep" },
  { type: "cache_read", prefix: "R" },
  { type: "sep" },
  { type: "cache_write", prefix: "W" },
  { type: "sep" },
  { type: "cache_hit", prefix: "CH", suffix: "%" },
  { type: "sep" },
  { type: "cost", prefix: "$", priority: 80 },
  { type: "sep" },
  { type: "context", showWindow: true, threshold: true, priority: 85 },
  { type: "split" },
  { type: "provider", onlyWhenMultiple: true, prefix: "(", suffix: ")", priority: 60 },
  { type: "sep" },
  { type: "model", priority: 95 },
  { type: "sep", text: " • " },
  { type: "thinking", onlyWhenSupported: true, priority: 70 },
];

const LINE_EXTENSIONS: ItemConfig[] = [{ type: "extensions", separator: " " }];

export function defaultConfig(): StatuslineConfig {
  return {
    version: 1,
    groupGap: 2,
    lines: [LINE_CWD, LINE_STATS, LINE_EXTENSIONS].map((line) => line.map((item) => ({ ...item }))),
  };
}
