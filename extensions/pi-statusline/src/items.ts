/**
 * Item builders: one function per item type, each turning session state into a
 * bare value string.
 *
 * Builders return the value only — icon, prefix, suffix, color and styling are
 * applied uniformly by the renderer, so every item honours the same options.
 * An empty or undefined result means "this item has nothing to say right now"
 * and makes the item (plus its decorations and adjacent separators) disappear.
 */

import { basename } from "node:path";
import type { ExtensionContext, ReadonlyFooterDataProvider } from "@earendil-works/pi-coding-agent";
import {
  formatBar,
  formatCwd,
  formatGauge,
  formatTokens,
  sanitize,
  shortenModel,
} from "./format.ts";
import { formatGitStatus } from "./git-status.ts";
import type { RuntimeState } from "./runtime.ts";
import type { SlotRegistry } from "./slots.ts";
import type {
  ContextItemConfig,
  CwdItemConfig,
  ExtensionsItemConfig,
  ItemConfig,
  ItemValue,
  ModelItemConfig,
  ProviderItemConfig,
  SepItemConfig,
  SlotItemConfig,
  TextItemConfig,
  ThinkingItemConfig,
  TimeItemConfig,
} from "./types.ts";
import type { UsageTotals } from "./usage.ts";

const DEFAULT_BAR_WIDTH = 8;
const DEFAULT_WINDOW_SEPARATOR = "/";

export interface RenderEnv {
  ctx: ExtensionContext;
  footerData: ReadonlyFooterDataProvider;
  runtime: RuntimeState;
  usage: UsageTotals;
  slots: SlotRegistry;
  /** Status keys and slot ids the layout places explicitly, so the `extensions`
   *  catch-all does not render them a second time. */
  placedStatusKeys: Set<string>;
  /** True while the editor draws its preview, so a producer can stand in for
   *  data it has not fetched yet. */
  preview: boolean;
  now: number;
}

export function buildItemValue(item: ItemConfig, env: RenderEnv): ItemValue | undefined {
  switch (item.type) {
    case "brand":
      return { text: "π" };
    case "cwd":
      return { text: buildCwd(item as CwdItemConfig, env) };
    case "branch":
      return { text: env.footerData.getGitBranch() ?? "" };
    case "git_status":
      return { text: formatGitStatus(env.runtime.gitStatus) };
    case "session":
      return { text: env.ctx.sessionManager.getSessionName() ?? "" };
    case "provider":
      return { text: buildProvider(item as ProviderItemConfig, env) };
    case "model":
      return { text: buildModel(item as ModelItemConfig, env) };
    case "thinking":
      return { text: buildThinking(item as ThinkingItemConfig, env) };
    case "tokens":
      return { text: buildTokens(env) };
    case "tokens_in":
      return { text: env.usage.input ? formatTokens(env.usage.input) : "" };
    case "tokens_out":
      return { text: env.usage.output ? formatTokens(env.usage.output) : "" };
    case "cache_read":
      return { text: env.usage.cacheRead ? formatTokens(env.usage.cacheRead) : "" };
    case "cache_write":
      return { text: env.usage.cacheWrite ? formatTokens(env.usage.cacheWrite) : "" };
    case "cache_hit":
      return { text: buildCacheHit(env) };
    case "cost":
      return { text: env.usage.cost ? env.usage.cost.toFixed(3) : "" };
    case "context":
      return buildContext(item as ContextItemConfig, env);
    case "turn":
      return { text: env.runtime.turnCount ? String(env.runtime.turnCount) : "" };
    case "time":
      return { text: buildTime(item as TimeItemConfig, env) };
    case "tools":
      return { text: buildTools(env) };
    case "extensions":
      return { text: buildExtensions(item as ExtensionsItemConfig, env) };
    case "slot":
      return buildSlot(item as SlotItemConfig, env);
    case "text":
      return { text: (item as TextItemConfig).text };
    case "sep":
      return { text: (item as SepItemConfig).text ?? " " };
    case "split":
      return { text: "" };
    default:
      return undefined;
  }
}

function buildCwd(item: CwdItemConfig, env: RenderEnv): string {
  const cwd = env.ctx.cwd;
  switch (item.style ?? "home") {
    case "basename":
      return basename(cwd) || cwd;
    case "full":
      return cwd;
    default:
      return formatCwd(cwd, process.env.HOME || process.env.USERPROFILE);
  }
}

function buildProvider(item: ProviderItemConfig, env: RenderEnv): string {
  const provider = env.ctx.model?.provider;
  if (!provider) return "";
  const onlyWhenMultiple = item.onlyWhenMultiple ?? true;
  if (onlyWhenMultiple && env.footerData.getAvailableProviderCount() <= 1) return "";
  return provider;
}

function buildModel(item: ModelItemConfig, env: RenderEnv): string {
  const id = env.ctx.model?.id;
  if (!id) return "no-model";
  return item.short ? shortenModel(id) : id;
}

/**
 * Stock pi spells out "thinking off" but shows a bare level otherwise, which
 * reads as `model • thinking off` / `model • high`.
 */
function buildThinking(item: ThinkingItemConfig, env: RenderEnv): string {
  if ((item.onlyWhenSupported ?? true) && !env.ctx.model?.reasoning) return "";
  const level = env.ctx.thinkingLevel ?? "off";
  return level === "off" ? "thinking off" : level;
}

function buildTokens(env: RenderEnv): string {
  const parts: string[] = [];
  if (env.usage.input) parts.push(`↑${formatTokens(env.usage.input)}`);
  if (env.usage.output) parts.push(`↓${formatTokens(env.usage.output)}`);
  return parts.join(" ");
}

function buildCacheHit(env: RenderEnv): string {
  const { cacheRead, cacheWrite, latestCacheHitRate } = env.usage;
  if (cacheRead <= 0 && cacheWrite <= 0) return "";
  if (latestCacheHitRate === undefined) return "";
  return latestCacheHitRate.toFixed(1);
}

/**
 * The meter, assembled from whichever parts are switched on.
 *
 * After a compaction the token count is unknown until the next response. A bar
 * or gauge cannot say that, so they drop out and the whole value group collapses
 * to a single `?` — two unknowns side by side would only be noise. The window is
 * a property of the model, not of the count, so it still renders.
 */
function buildContext(item: ContextItemConfig, env: RenderEnv): ItemValue {
  const usage = env.ctx.getContextUsage();
  const window = usage?.contextWindow ?? env.ctx.model?.contextWindow ?? 0;
  const percent = usage?.percent ?? null;
  const tokens = usage?.tokens ?? null;
  const known = percent !== null;

  // An empty context, hidden window included: with nothing in it there is no
  // count for the window to qualify. An unknown count is not a zero one, so a
  // post-compaction `?` still has something to say and stays.
  if (item.hideWhenZero && known && (tokens ?? percent) === 0) return { text: "" };

  const showPercent = item.showPercent ?? true;
  const showTokens = item.showTokens ?? false;

  const parts: string[] = [];
  if (known && item.showBar) parts.push(formatBar(percent, item.barWidth ?? DEFAULT_BAR_WIDTH));
  if (known && item.showGauge) parts.push(formatGauge(percent));

  let percentText: string | undefined;
  if (known && showPercent) {
    percentText = `${percent.toFixed(1)}%`;
    if (item.percentParens) percentText = `(${percentText})`;
  }
  const afterWindow = (item.percentAfterWindow ?? false) && percentText !== undefined;

  const values: string[] = [];
  if (known) {
    if (percentText && !afterWindow) values.push(percentText);
    if (showTokens) values.push(tokens === null ? "?" : formatTokens(tokens));
  } else if (showPercent || showTokens) {
    // One unknown, rendered where the window can qualify it. Placement describes
    // how two known values relate, and here there is nothing to relate.
    values.push("?");
  }

  let tail = values.join(" ");
  if ((item.showWindow ?? true) && window > 0) {
    const separator = item.windowSeparator ?? DEFAULT_WINDOW_SEPARATOR;
    // Alone it is a plain figure: a leading separator would dangle off nothing.
    tail = tail ? `${tail}${separator}${formatTokens(window)}` : formatTokens(window);
  }
  if (afterWindow && percentText) tail = tail ? `${tail} ${percentText}` : percentText;
  if (tail) parts.push(tail);

  const text = parts.join(" ");
  if (!(item.threshold ?? true) || !known) return { text };
  if (percent > 90) return { text, color: "error" };
  if (percent > 70) return { text, color: "warning" };
  return { text };
}

function buildTime(item: TimeItemConfig, env: RenderEnv): string {
  if ((item.format ?? "clock") === "clock") {
    const now = new Date(env.now);
    return `${pad2(now.getHours())}:${pad2(now.getMinutes())}`;
  }
  const seconds = Math.max(0, Math.floor((env.now - env.runtime.sessionStartedAt) / 1000));
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h${pad2(minutes % 60)}m`;
}

function buildTools(env: RenderEnv): string {
  const parts: string[] = [];
  for (const [name, count] of env.runtime.activeTools) {
    parts.push(count > 1 ? `${name}×${count}` : name);
  }
  return parts.join(" ");
}

/**
 * The catch-all for `ctx.ui.setStatus` texts and for published slot items the
 * layout does not place by name. Sorted by key so entries do not jump around
 * between renders.
 *
 * Keyed by id rather than appended: an extension that both publishes a slot and
 * calls `setStatus` under the same name — the recommended way to stay readable
 * on a stock pi footer — is one extension speaking twice, not two entries. The
 * slot wins, since it carries the icon and color.
 */
function buildExtensions(item: ExtensionsItemConfig, env: RenderEnv): string {
  const include = item.include ? new Set(item.include) : undefined;
  const exclude = new Set(item.exclude ?? []);
  const icons = item.icons ?? {};

  const wanted = (id: string) =>
    (!include || include.has(id)) && !exclude.has(id) && !env.placedStatusKeys.has(id);

  const entries = new Map<string, string>();
  for (const [key, text] of env.footerData.getExtensionStatuses()) {
    if (!wanted(key)) continue;
    const clean = sanitize(text);
    if (clean.length === 0) continue;
    entries.set(key, icons[key] ? `${icons[key]} ${clean}` : clean);
  }

  for (const slot of env.slots.all()) {
    if (!wanted(slot.id)) continue;
    // No per-item options exist down here, so a producer that registered one is
    // asked for its own defaults — which is what its own config file says.
    // Segment colors are lost either way: the catch-all is one item.
    const rendered = env.slots.render(slot.id, {}, { preview: env.preview });
    const text = rendered ? rendered.segments.map((segment) => segment.text).join("") : slot.text;
    if (text.length === 0) {
      entries.delete(slot.id);
      continue;
    }
    const icon = rendered?.icon ?? slot.icon ?? icons[slot.id];
    entries.set(slot.id, icon ? `${icon} ${text}` : text);
  }

  return [...entries]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([, text]) => text)
    .join(item.separator ?? " ");
}

/**
 * Resolve a named slot, in three descending steps: the producer's own `render`
 * with this item's options, then the text it last published, then a
 * `ctx.ui.setStatus` key of the same name.
 *
 * The last of those is what lets any existing extension — one that knows
 * nothing about this statusline — be placed at an exact spot by the user. The
 * first is what lets a producer be configured from the layout editor, and it
 * works before anything has been published, so an explicitly placed slot draws
 * from the first frame.
 */
function buildSlot(item: SlotItemConfig, env: RenderEnv): ItemValue | undefined {
  const slot = env.slots.get(item.id);
  const registration = env.slots.registration(item.id);
  const rendered = env.slots.render(item.id, item.options ?? {}, { preview: env.preview });

  if (rendered) {
    // The renderer applies `item.icon`; the producer's is only the fallback.
    const icon = item.icon ? undefined : (rendered.icon ?? registration?.icon ?? slot?.icon);
    const segments = icon ? [{ text: `${icon} ` }, ...rendered.segments] : rendered.segments;
    return {
      text: segments.map((segment) => segment.text).join(""),
      segments,
      color: registration?.color ?? slot?.color,
    };
  }

  if (!slot) {
    const status = env.footerData.getExtensionStatuses().get(item.id);
    const clean = status ? sanitize(status) : "";
    return clean.length > 0 ? { text: clean } : undefined;
  }
  if (slot.text.length === 0) return undefined;
  const icon = item.icon ? undefined : slot.icon;
  return { text: icon ? `${icon} ${slot.text}` : slot.text, color: slot.color };
}

function pad2(value: number): string {
  return value.toString().padStart(2, "0");
}
