/**
 * The `/statusline` layout editor.
 *
 * Everything happens inside one `ctx.ui.custom` component — pickers and text
 * input are inline modes rather than nested dialogs, because opening a dialog
 * from inside a custom component fights over who owns the keyboard.
 *
 * The top of the screen is a live preview rendered through the real pipeline at
 * the real terminal width, so what the user sees while editing is exactly what
 * the footer will show.
 */

import type {
  ExtensionCommandContext,
  ReadonlyFooterDataProvider,
  Theme,
} from "@earendil-works/pi-coding-agent";
import {
  type KeybindingsManager,
  matchesKey,
  type TUI,
  truncateToWidth,
  visibleWidth,
} from "@earendil-works/pi-tui";
import {
  DEFAULT_COLD_AFTER_MINUTES,
  DEFAULT_COLD_COLOR,
  DEFAULT_COLD_MARKER,
} from "./cache-age.ts";
import { configPath, saveConfig, validateConfig } from "./config.ts";
import { defaultConfig } from "./defaults.ts";
import { sanitize } from "./format.ts";
import { buildItemValue, type RenderEnv } from "./items.ts";
import { ELLIPSIS } from "./layout.ts";
import { renderStatusline } from "./render.ts";
import type { RuntimeState } from "./runtime.ts";
import type { SlotRegistry } from "./slots.ts";
import {
  COLD_STYLES,
  CWD_STYLES,
  ITEM_COLORS,
  ITEM_TYPES,
  type ItemColor,
  type ItemConfig,
  type ItemType,
  type SlotFieldSpec,
  type SlotItemConfig,
  type SlotRegistration,
  type StatuslineConfig,
  TIME_FORMATS,
} from "./types.ts";
import { collectUsage } from "./usage.ts";

export interface EditorDeps {
  getConfig: () => StatuslineConfig;
  setConfig: (config: StatuslineConfig) => void;
  slots: SlotRegistry;
  runtime: RuntimeState;
  getFooterData: () => ReadonlyFooterDataProvider | undefined;
}

/** What the editor hands back on save: the layout, plus anything validation
 *  dropped on the way out, so a save is never silent about losing an item. */
export interface EditorResult {
  config: StatuslineConfig;
  warnings: string[];
}

const COLORS: Array<ItemColor | "auto"> = ["auto", ...ITEM_COLORS];

const CATALOG_WINDOW = 8;
const CATALOG_HINT_WIDTH = 24;

/** Shown when an item has no live value to preview, e.g. before the first turn. */
const CATALOG_EXAMPLES: Partial<Record<ItemType, string>> = {
  cwd: "~/project",
  branch: "main",
  git_status: "↑2 ~1 ?3",
  session: "refactor-footer",
  provider: "openai",
  model: "gpt-5",
  thinking: "high",
  tokens: "↑12k ↓3.4k",
  tokens_in: "12k",
  tokens_out: "3.4k",
  cache_read: "80k",
  cache_write: "2.0k",
  cache_hit: "94.1",
  cost: "0.184",
  context: "72.3%/200k",
  turn: "7",
  time: "14:32",
  tools: "read×2 bash",
  extensions: "42%  PR #12",
};

/** Items whose point is structural: a sample value would explain nothing. */
const CATALOG_DESCRIPTIONS: Partial<Record<ItemType, string>> = {
  slot: "one extension, by id",
  text: "any literal text",
  sep: "spacer between items",
  split: "right-aligns what follows",
};

/** One row of the add-item catalog: a label and the item it would insert. */
interface CatalogEntry {
  label: string;
  /** The extension's current text, shown so the row is recognisable. */
  hint?: string;
  create: () => ItemConfig;
}

type Mode = "list" | "add" | "fields" | "input";

const HINT_INDENT = "  ";
const HINT_GAP = "   ";
const HINT_MAX_LINES = 2;

const SCROLL_LEFT = "‹";
const SCROLL_RIGHT = "›";
const SCROLL_MARKER_WIDTH = 1;

/** A chip carries its plain text so widths are measured without ANSI noise. */
export interface Chip {
  text: string;
  styled: string;
}

/**
 * Pick the run of chips to show so that `focus` is visible within `available`
 * columns, scrolling only as far as it must.
 *
 * Windows are chosen from the leftmost start that still contains the focus,
 * which keeps the row still while the cursor moves inside it and shifts by the
 * minimum when the cursor walks off an edge.
 */
export function windowChips(
  chips: Chip[],
  focus: number,
  available: number,
): { visible: Chip[]; leading: boolean; trailing: boolean } {
  if (chips.length === 0 || available <= 0) {
    return { visible: [], leading: false, trailing: false };
  }

  const widths = chips.map((chip) => visibleWidth(chip.text));
  const target = Math.min(Math.max(focus, 0), chips.length - 1);

  for (let start = 0; start <= target; start++) {
    const leadingCost = start > 0 ? SCROLL_MARKER_WIDTH : 0;
    let end = start - 1;
    let used = 0;

    while (end + 1 < chips.length) {
      const next = used + (widths[end + 1] ?? 0);
      const trailingCost = end + 2 < chips.length ? SCROLL_MARKER_WIDTH : 0;
      if (leadingCost + next + trailingCost > available) break;
      used = next;
      end += 1;
    }

    if (end >= target) {
      return {
        visible: chips.slice(start, end + 1),
        leading: start > 0,
        trailing: end < chips.length - 1,
      };
    }
  }

  // The focused chip alone is wider than the row; show it and let the caller's
  // width clamp trim the overflow.
  return {
    visible: chips.slice(target, target + 1),
    leading: target > 0,
    trailing: target < chips.length - 1,
  };
}

/** Ordered by how often they are reached for, not by how they group. */
const HINTS: Record<Mode, string[]> = {
  list: [
    "w save",
    "esc discard",
    "enter options",
    "del delete",
    "ctrl+arrows move",
    "a add",
    ", separator",
    "s splitter",
    "n new line",
    "x drop line",
    "r reset",
  ],
  add: ["enter add", "esc cancel", "↑↓ choose"],
  fields: ["enter edit/toggle", "esc back", "↑↓ choose"],
  input: ["enter apply", "esc cancel"],
};

/**
 * Pack hints into as few lines as the width allows, keeping their order.
 *
 * Capped at two lines: past that the hints crowd out the layout they are
 * describing, so the tail of the last line is truncated instead.
 */
export function hintLines(hints: string[], width: number, maxLines = HINT_MAX_LINES): string[] {
  const available = Math.max(1, width - HINT_INDENT.length);
  const lines: string[] = [];
  let current = "";

  for (const hint of hints) {
    const candidate = current.length === 0 ? hint : `${current}${HINT_GAP}${hint}`;
    // On the last allowed line, keep appending and let the truncation below
    // signal that there is more.
    const mustFit = current.length > 0 && lines.length + 1 < maxLines;
    if (mustFit && visibleWidth(candidate) > available) {
      lines.push(current);
      current = hint;
      continue;
    }
    current = candidate;
  }

  if (current.length > 0) lines.push(current);
  return lines.map((line) => truncateToWidth(`${HINT_INDENT}${line}`, width, ELLIPSIS));
}

/** Bracketed paste markers, which the terminal wraps around pasted text. */
const PASTE_START = "\x1b[200~";
const PASTE_END = "\x1b[201~";
/** Far past any sane statusline value; only a truncated paste reaches it. */
const MAX_PASTE_CHARS = 4096;

/** Strips control codes, including the newlines a multi-line paste carries. */
function printableOnly(text: string): string {
  return [...text]
    .filter((char) => {
      const code = char.codePointAt(0) ?? 0;
      return code >= 0x20 && code !== 0x7f;
    })
    .join("");
}

interface FieldSpec {
  key: string;
  label: string;
  kind: "string" | "number" | "boolean" | "enum";
  options?: readonly string[];
  /** Shown when the value is unset, i.e. the built-in behaviour. */
  fallback: string;
  /** Where the value is written. Options a producer declared live under the
   *  item's `options`, out of the way of `icon`, `color` and the rest. */
  container?: "options";
  min?: number;
  max?: number;
}

export async function runEditor(ctx: ExtensionCommandContext, deps: EditorDeps): Promise<void> {
  if (!ctx.hasUI || ctx.mode !== "tui") {
    ctx.ui.notify(`statusline: edit ${configPath()} directly in this mode`, "info");
    return;
  }

  const result = await ctx.ui.custom<EditorResult | undefined>(
    (tui, theme, keybindings, done) => new LayoutEditor(tui, theme, keybindings, ctx, deps, done),
  );

  if (!result) return;
  try {
    saveConfig(result.config);
    deps.setConfig(result.config);
    for (const warning of result.warnings) ctx.ui.notify(`statusline: ${warning}`, "warning");
    ctx.ui.notify(`statusline: saved ${configPath()}`, "info");
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    ctx.ui.notify(`statusline: could not save (${reason})`, "error");
  }
}

export class LayoutEditor {
  private config: StatuslineConfig;
  private line = 0;
  private index = 0;
  private mode: Mode = "list";
  private catalogIndex = 0;
  private catalogOffset = 0;
  private catalogEntries: CatalogEntry[] = [];
  private fields: FieldSpec[] = [];
  private fieldIndex = 0;
  private inputBuffer = "";
  private inputField: FieldSpec | undefined;
  /** Set between the bracketed-paste start and end markers. */
  private pasting = false;
  private pasteBuffer = "";
  private message: string | undefined;
  private tui: TUI;
  private theme: Theme;
  private keybindings: KeybindingsManager;
  private ctx: ExtensionCommandContext;
  private deps: EditorDeps;
  private done: (result: EditorResult | undefined) => void;

  constructor(
    tui: TUI,
    theme: Theme,
    keybindings: KeybindingsManager,
    ctx: ExtensionCommandContext,
    deps: EditorDeps,
    done: (result: EditorResult | undefined) => void,
  ) {
    this.tui = tui;
    this.theme = theme;
    this.keybindings = keybindings;
    this.ctx = ctx;
    this.deps = deps;
    this.done = done;
    this.config = cloneConfig(deps.getConfig());
    if (this.config.lines.length === 0) this.config.lines.push([]);
  }

  invalidate(): void {}

  render(width: number): string[] {
    const draft = this.draft();
    const lines: string[] = [""];
    lines.push(this.theme.bold(this.theme.fg("accent", "statusline layout")));
    lines.push("");
    lines.push(...this.renderPreview(width, draft.config));
    lines.push("");
    lines.push(...this.renderLayout(draft, width));

    if (this.mode === "add") lines.push("", ...this.renderCatalog());
    if (this.mode === "fields") lines.push("", ...this.renderFields());
    if (this.mode === "input") lines.push("", ...this.renderInput(width));

    if (this.message) lines.push("", this.theme.fg("warning", this.message));
    lines.push("", ...this.renderHints(width));

    // Last line of defence: pi kills the session over an overlong render, so
    // no row may leave here unbounded, whatever produced it.
    return lines.map((line) =>
      visibleWidth(line) > width ? truncateToWidth(line, width, ELLIPSIS) : line,
    );
  }

  handleInput(data: string): void {
    this.message = undefined;

    switch (this.mode) {
      case "add":
        this.handleCatalogInput(data);
        break;
      case "fields":
        this.handleFieldsInput(data);
        break;
      case "input":
        this.handleTextInput(data);
        break;
      default:
        this.handleListInput(data);
        break;
    }

    this.tui.requestRender();
  }

  // ---------------------------------------------------------------- rendering

  /**
   * The layout as it would look right now, including the catalog item under the
   * cursor while adding. Previewing the candidate before it is confirmed is the
   * point: most of these items only differ once you see them rendered.
   */
  private draft(): { config: StatuslineConfig; candidate?: { line: number; index: number } } {
    if (this.mode !== "add") return { config: this.config };
    const entry = this.catalogEntries[this.catalogIndex];
    if (!entry) return { config: this.config };

    const index = this.insertionIndex();
    const candidate = entry.create();
    const lines = this.config.lines.map((line, lineIndex) =>
      lineIndex === this.line ? [...line.slice(0, index), candidate, ...line.slice(index)] : line,
    );

    return {
      config: { ...this.config, lines },
      candidate: { line: this.line, index },
    };
  }

  /**
   * Render the draft through the real pipeline. Without a footer data provider
   * (no footer installed yet) the preview is skipped rather than faked — a
   * wrong preview is worse than none.
   */
  private renderPreview(width: number, config: StatuslineConfig): string[] {
    const env = this.renderEnv();
    if (!env) return [this.theme.fg("dim", "  (preview unavailable)")];

    const rendered = renderStatusline(Math.max(1, width - 2), config, this.theme, env);
    if (rendered.length === 0) return [this.theme.fg("dim", "  (empty statusline)")];
    return rendered.map((line) => `  ${line}`);
  }

  /** The live session state items render from, or undefined before install. */
  private renderEnv(): Omit<RenderEnv, "placedStatusKeys"> | undefined {
    const footerData = this.deps.getFooterData();
    if (!footerData) return undefined;
    return {
      ctx: this.ctx,
      footerData,
      runtime: this.deps.runtime,
      usage: collectUsage(this.ctx),
      slots: this.deps.slots,
      preview: true,
      now: Date.now(),
    };
  }

  /**
   * One row per configured line, scrolled horizontally so the cursor is always
   * on screen. A long line holds far more chips than fit — the default stats
   * line alone is nineteen — so the row is a viewport, not the whole line.
   */
  private renderLayout(draft: ReturnType<LayoutEditor["draft"]>, width: number): string[] {
    return draft.config.lines.map((line, lineIndex) => {
      const active = lineIndex === this.line;
      const labelText = `  ${lineIndex + 1} `;
      const label = this.theme.fg(active ? "accent" : "dim", labelText);
      if (line.length === 0) {
        const empty = this.theme.fg("dim", "(empty)");
        return `${label}${active && this.mode === "list" ? this.theme.fg("accent", "▸ ") : "  "}${empty}`;
      }

      const chips = line.map((item, itemIndex): Chip => {
        const text = chipLabel(item);
        if (draft.candidate?.line === lineIndex && draft.candidate.index === itemIndex) {
          return this.chip(`[+${text}]`, (value) =>
            this.theme.bold(this.theme.fg("accent", value)),
          );
        }
        if (active && itemIndex === this.index && this.mode === "list") {
          return this.chip(`[${text}]`, (value) => this.theme.bold(this.theme.fg("accent", value)));
        }
        if (item.hidden) return this.chip(` ${text}~`, (value) => this.theme.fg("dim", value));
        return this.chip(` ${text} `, (value) => this.theme.fg("muted", value));
      });

      // Inactive rows scroll back to the start; only the active one follows a
      // cursor, and a row that jumped around while unfocused would be noise.
      const focus = active ? (draft.candidate?.index ?? this.index) : 0;
      const view = windowChips(chips, focus, width - visibleWidth(labelText));
      const leading = view.leading ? this.theme.fg("dim", SCROLL_LEFT) : "";
      const trailing = view.trailing ? this.theme.fg("dim", SCROLL_RIGHT) : "";

      return `${label}${leading}${view.visible.map((chip) => chip.styled).join("")}${trailing}`;
    });
  }

  /**
   * Every item type, then one ready-made entry per extension that is currently
   * saying something — published slots and `setStatus` keys alike.
   *
   * Without those trailing entries, placing an extension means adding a bare
   * `slot` and knowing to type its id, which is only discoverable if you already
   * knew the id. They sit after the fixed types so the catalog opens on the same
   * row whatever extensions happen to be loaded. The list is snapshotted when
   * the catalog opens so a background refresh cannot shuffle entries under the
   * cursor mid-selection.
   */
  private buildCatalog(): CatalogEntry[] {
    const env = this.renderEnv();
    const entries: CatalogEntry[] = ITEM_TYPES.map((type) => ({
      label: type,
      hint: this.catalogHint(type, env),
      create: () => newItem(type),
    }));

    for (const [id, hint] of this.knownSlots()) {
      entries.push({ label: `slot:${id}`, hint, create: () => ({ type: "slot", id }) });
    }
    return entries;
  }

  /**
   * What a row will actually look like, answered with this session's own data
   * wherever the item has something to say. An item that is quiet right now —
   * no session name, no tokens yet — falls back to a marked example, so the
   * row still explains itself without claiming a value that is not there.
   */
  private catalogHint(
    type: ItemType,
    env: Omit<RenderEnv, "placedStatusKeys"> | undefined,
  ): string | undefined {
    const description = CATALOG_DESCRIPTIONS[type];
    if (description) return description;

    if (env) {
      const live = buildItemValue({ type } as ItemConfig, {
        ...env,
        placedStatusKeys: new Set(),
      });
      if (live?.text) return truncateToWidth(live.text, CATALOG_HINT_WIDTH, ELLIPSIS);
    }

    const example = CATALOG_EXAMPLES[type];
    return example ? `ex.: ${example}` : undefined;
  }

  /** Live extension entries, as id -> current text, sorted for a stable list. */
  private knownSlots(): Array<[string, string]> {
    const found = new Map<string, string>();
    const footerData = this.deps.getFooterData();
    if (footerData) {
      for (const [id, text] of footerData.getExtensionStatuses()) found.set(id, sanitize(text));
    }
    for (const slot of this.deps.slots.all()) found.set(slot.id, slot.text);
    // A producer that registered but has not published yet still belongs in the
    // catalog: `render` is what a placed item would draw from anyway.
    for (const registration of this.deps.slots.registered()) {
      const rendered = this.deps.slots.render(registration.id, {}, { preview: true });
      if (rendered) {
        found.set(registration.id, rendered.segments.map((segment) => segment.text).join(""));
      } else if (!found.has(registration.id)) {
        found.set(registration.id, "");
      }
    }

    return [...found]
      .filter(([id, text]) => text.length > 0 || this.deps.slots.registration(id) !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([id, text]) => [
        id,
        text.length > 0 ? truncateToWidth(text, CATALOG_HINT_WIDTH, ELLIPSIS) : "(no value yet)",
      ]);
  }

  private chip(text: string, style: (value: string) => string): Chip {
    return { text, styled: style(text) };
  }

  private renderCatalog(): string[] {
    const visible = this.catalogEntries.slice(
      this.catalogOffset,
      this.catalogOffset + CATALOG_WINDOW,
    );
    // Hints share one column across the whole catalog, not just the visible
    // slice, so they do not slide sideways as the list scrolls.
    const labelColumn = this.catalogEntries.reduce(
      (widest, entry) => Math.max(widest, visibleWidth(entry.label)),
      0,
    );

    const rows = visible.map((entry, offset) => {
      const index = this.catalogOffset + offset;
      const marker = index === this.catalogIndex ? "▸ " : "  ";
      const color = index === this.catalogIndex ? "accent" : "muted";
      const label = this.theme.fg(color, `  ${marker}${entry.label}`);
      if (!entry.hint) return label;
      const pad = " ".repeat(labelColumn - visibleWidth(entry.label) + 2);
      return `${label}${this.theme.fg("dim", `${pad}${entry.hint}`)}`;
    });

    const more = this.catalogEntries.length - this.catalogOffset - visible.length;
    const heading = more > 0 ? `  add item:  (${more} more below)` : "  add item:";
    return [this.theme.fg("dim", heading), ...rows];
  }

  private renderFields(): string[] {
    const item = this.currentItem();
    if (!item) return [];
    const rows = this.fields.map((field, index) => {
      const marker = index === this.fieldIndex ? "▸ " : "  ";
      const color = index === this.fieldIndex ? "accent" : "muted";
      const value = fieldValueText(item, field);
      return this.theme.fg(color, `  ${marker}${field.label}: ${value}`);
    });
    return [this.theme.fg("dim", `  ${item.type} options:`), ...rows];
  }

  /** Long values scroll from the left so the caret end stays in view. */
  private renderInput(width: number): string[] {
    const label = this.inputField?.label ?? "value";
    const available = Math.max(1, width - HINT_INDENT.length - 1);
    const characters = [...this.inputBuffer];
    const visible =
      characters.length > available ? characters.slice(-available).join("") : this.inputBuffer;

    return [
      this.theme.fg("dim", `  ${label}:`),
      `  ${this.theme.fg("accent", visible)}${this.theme.fg("dim", "▌")}`,
    ];
  }

  /**
   * Hints are one ordered list, most important first, wrapped to the terminal:
   * a single line where there is room, two where there is not.
   *
   * Arrow-key navigation is left out — it is the one thing every user tries
   * without being told, and the list earns more by staying short.
   */
  private renderHints(width: number): string[] {
    return hintLines(HINTS[this.mode], width).map((line) => this.theme.fg("dim", line));
  }

  // ------------------------------------------------------------ list handling

  private handleListInput(data: string): void {
    // Ctrl+arrows carry the selected item; plain arrows just move the cursor.
    // Checked first: a ctrl+arrow sequence must not fall through to the plain
    // arrow test underneath it.
    if (matchesKey(data, "ctrl+left")) {
      this.shiftItem(-1);
      return;
    }
    if (matchesKey(data, "ctrl+right")) {
      this.shiftItem(1);
      return;
    }
    if (matchesKey(data, "ctrl+up")) {
      this.shiftItemToLine(-1);
      return;
    }
    if (matchesKey(data, "ctrl+down")) {
      this.shiftItemToLine(1);
      return;
    }

    if (this.matches(data, "up") || matchesKey(data, "up")) {
      this.moveLine(-1);
      return;
    }
    if (this.matches(data, "down") || matchesKey(data, "down")) {
      this.moveLine(1);
      return;
    }
    if (matchesKey(data, "right")) {
      this.moveItem(1);
      return;
    }
    if (matchesKey(data, "left")) {
      this.moveItem(-1);
      return;
    }

    if (this.matches(data, "confirm") || matchesKey(data, "enter")) {
      this.openFields();
      return;
    }
    if (matchesKey(data, "delete")) {
      this.deleteItem();
      return;
    }

    switch (data) {
      case ">":
        this.shiftItem(1);
        return;
      case "<":
        this.shiftItem(-1);
        return;
      case "a":
        this.mode = "add";
        this.catalogEntries = this.buildCatalog();
        this.catalogIndex = 0;
        this.catalogOffset = 0;
        return;
      case "d":
        this.deleteItem();
        return;
      case "e":
        this.openFields();
        return;
      case ",":
        this.insertItem({ type: "sep", text: " " });
        return;
      case "s":
        this.insertItem({ type: "split" });
        return;
      case "n":
        this.config.lines.splice(this.line + 1, 0, []);
        this.line += 1;
        this.index = 0;
        return;
      case "x":
        this.deleteLine();
        return;
      case "r":
        this.config = defaultConfig();
        this.line = 0;
        this.index = 0;
        this.message = "layout reset to the default (not saved yet)";
        return;
      case "w":
        this.done(this.normalized());
        return;
      default:
        break;
    }

    if (this.matches(data, "cancel") || data === "\x1b") this.done(undefined);
  }

  private moveLine(delta: number): void {
    const next = this.line + delta;
    if (next < 0 || next >= this.config.lines.length) return;
    this.line = next;
    this.index = Math.min(this.index, Math.max(0, this.currentLine().length - 1));
  }

  private moveItem(delta: number): void {
    const next = this.index + delta;
    if (next < 0 || next >= this.currentLine().length) return;
    this.index = next;
  }

  /** Reorder within the line, which is the whole point of a visual editor. */
  private shiftItem(delta: number): void {
    const line = this.currentLine();
    const target = this.index + delta;
    const item = line[this.index];
    if (!item || target < 0 || target >= line.length) return;
    line.splice(this.index, 1);
    line.splice(target, 0, item);
    this.index = target;
  }

  /**
   * Carry the selected item to the line above or below, keeping the cursor on
   * it. Lands at the same position where the target line is long enough, at
   * its end otherwise. Stops at the first and last line rather than creating
   * one, since `n` already does that deliberately.
   */
  private shiftItemToLine(delta: number): void {
    const target = this.config.lines[this.line + delta];
    const line = this.currentLine();
    const item = line[this.index];
    if (!item || !target) return;

    line.splice(this.index, 1);
    const at = Math.min(this.index, target.length);
    target.splice(at, 0, item);
    this.line += delta;
    this.index = at;
  }

  /** New items land after the cursor, or at the start of an empty line. */
  private insertionIndex(): number {
    return this.currentLine().length === 0 ? 0 : this.index + 1;
  }

  private insertItem(item: ItemConfig): void {
    const at = this.insertionIndex();
    this.currentLine().splice(at, 0, item);
    this.index = at;
  }

  private deleteItem(): void {
    const line = this.currentLine();
    if (line.length === 0) return;
    line.splice(this.index, 1);
    this.index = Math.max(0, Math.min(this.index, line.length - 1));
  }

  private deleteLine(): void {
    if (this.config.lines.length <= 1) {
      this.config.lines[0] = [];
      this.index = 0;
      return;
    }
    this.config.lines.splice(this.line, 1);
    this.line = Math.max(0, Math.min(this.line, this.config.lines.length - 1));
    this.index = Math.max(0, Math.min(this.index, this.currentLine().length - 1));
  }

  // --------------------------------------------------------- catalog handling

  private handleCatalogInput(data: string): void {
    if (this.matches(data, "up") || matchesKey(data, "up")) {
      this.catalogIndex = Math.max(0, this.catalogIndex - 1);
      this.syncCatalogWindow();
      return;
    }
    if (this.matches(data, "down") || matchesKey(data, "down")) {
      this.catalogIndex = Math.min(this.catalogEntries.length - 1, this.catalogIndex + 1);
      this.syncCatalogWindow();
      return;
    }
    if (this.matches(data, "confirm") || data === "\r" || data === "\n") {
      const entry = this.catalogEntries[this.catalogIndex];
      if (entry) this.insertItem(entry.create());
      this.mode = "list";
      return;
    }
    if (this.matches(data, "cancel") || data === "\x1b") this.mode = "list";
  }

  private syncCatalogWindow(): void {
    if (this.catalogIndex < this.catalogOffset) this.catalogOffset = this.catalogIndex;
    const bottom = this.catalogOffset + CATALOG_WINDOW - 1;
    if (this.catalogIndex > bottom) this.catalogOffset = this.catalogIndex - CATALOG_WINDOW + 1;
  }

  // ---------------------------------------------------------- field handling

  private openFields(): void {
    const item = this.currentItem();
    if (!item) return;
    this.fields = fieldsFor(item, this.deps.slots);
    this.fieldIndex = 0;
    this.mode = "fields";
  }

  /**
   * The record a field writes to, creating `options` on demand.
   *
   * Empty option bags are pruned by `commitInput` and `activateField` so a slot
   * the user opened and left alone does not gain an `"options": {}` in the file.
   */
  private fieldTarget(item: ItemConfig, field: FieldSpec): Record<string, unknown> {
    const record = item as unknown as Record<string, unknown>;
    if (field.container !== "options") return record;
    if (!isRecord(record.options)) record.options = {};
    return record.options as Record<string, unknown>;
  }

  private pruneOptions(item: ItemConfig): void {
    const record = item as unknown as Record<string, unknown>;
    if (isRecord(record.options) && Object.keys(record.options).length === 0) {
      delete record.options;
    }
  }

  private handleFieldsInput(data: string): void {
    // Wraps, unlike the line/item cursors: a short option list is quicker to
    // walk backwards from the top than to page down through.
    if (this.matches(data, "up") || matchesKey(data, "up")) {
      this.fieldIndex = (this.fieldIndex + this.fields.length - 1) % this.fields.length;
      return;
    }
    if (this.matches(data, "down") || matchesKey(data, "down")) {
      this.fieldIndex = (this.fieldIndex + 1) % this.fields.length;
      return;
    }
    if (this.matches(data, "confirm") || data === "\r" || data === "\n") {
      this.activateField();
      return;
    }
    if (this.matches(data, "cancel") || data === "\x1b") this.mode = "list";
  }

  /** Booleans and enums cycle in place; free text opens the inline input. */
  private activateField(): void {
    const item = this.currentItem();
    const field = this.fields[this.fieldIndex];
    if (!item || !field) return;

    const target = this.fieldTarget(item, field);

    if (field.kind === "boolean") {
      target[field.key] = !(target[field.key] === true);
      return;
    }

    if (field.kind === "enum" && field.options) {
      // An unset field already behaves as the first option, so cycling starts
      // from there; otherwise the first keypress would look like a no-op.
      const current =
        typeof target[field.key] === "string" ? (target[field.key] as string) : field.options[0];
      const at = field.options.indexOf(current ?? "");
      const next = field.options[(at + 1) % field.options.length];
      if (next === "auto" && field.key === "color") delete target[field.key];
      else target[field.key] = next;
      this.pruneOptions(item);
      return;
    }

    this.inputField = field;
    this.inputBuffer = target[field.key] === undefined ? "" : String(target[field.key]);
    this.pruneOptions(item);
    this.pasting = false;
    this.pasteBuffer = "";
    this.mode = "input";
  }

  private handleTextInput(data: string): void {
    // A paste arrives wrapped in bracketed-paste markers, and the terminal is
    // free to split it across chunks, so it is buffered until the closing
    // marker rather than treated as an escape sequence to ignore.
    if (this.pasting || data.includes(PASTE_START)) {
      this.handlePasteInput(data);
      return;
    }

    if (this.matches(data, "cancel") || data === "\x1b") {
      this.mode = "fields";
      return;
    }

    if (data === "\r" || data === "\n") {
      this.commitInput();
      return;
    }

    if (data === "\x7f" || data === "\b") {
      this.inputBuffer = this.inputBuffer.slice(0, -1);
      return;
    }

    // Ignore escape sequences and other control input; only text belongs here.
    if (data.startsWith("\x1b") || data.length === 0) return;
    this.inputBuffer += printableOnly(data);
  }

  private handlePasteInput(data: string): void {
    let rest = data;
    if (!this.pasting) {
      this.pasting = true;
      this.pasteBuffer = "";
      rest = rest.slice(rest.indexOf(PASTE_START) + PASTE_START.length);
    }

    this.pasteBuffer += rest;
    const end = this.pasteBuffer.indexOf(PASTE_END);
    // A closing marker that never arrives would otherwise leave the field
    // swallowing every key, Escape included.
    if (end === -1) {
      if (this.pasteBuffer.length <= MAX_PASTE_CHARS) return;
      this.inputBuffer += printableOnly(this.pasteBuffer);
      this.pasting = false;
      this.pasteBuffer = "";
      return;
    }

    // These fields are single-line, so a multi-line paste keeps only its text:
    // `printableOnly` drops the newlines along with the other control codes.
    this.inputBuffer += printableOnly(this.pasteBuffer.slice(0, end));
    const remaining = this.pasteBuffer.slice(end + PASTE_END.length);
    this.pasting = false;
    this.pasteBuffer = "";
    if (remaining.length > 0) this.handleTextInput(remaining);
  }

  private commitInput(): void {
    const item = this.currentItem();
    const field = this.inputField;
    this.mode = "fields";
    this.inputField = undefined;
    if (!item || !field) return;

    const target = this.fieldTarget(item, field);

    if (field.kind === "number") {
      const value = Number.parseFloat(this.inputBuffer);
      if (this.inputBuffer.trim().length === 0) delete target[field.key];
      else if (Number.isFinite(value)) target[field.key] = clampField(value, field);
      else this.message = `${field.label} must be a number`;
      this.pruneOptions(item);
      return;
    }

    // Blank clears an optional field. A required one keeps its old value and
    // says so: validation drops an item whose `id` is empty, so accepting the
    // blank would make the item disappear later, at save time, unexplained.
    if (this.inputBuffer.length === 0) {
      if (field.container !== "options" && (field.key === "text" || field.key === "id")) {
        this.message = `${field.label} cannot be empty`;
        return;
      }
      delete target[field.key];
      this.pruneOptions(item);
      return;
    }
    target[field.key] = this.inputBuffer;
  }

  // ------------------------------------------------------------------ helpers

  private currentLine(): ItemConfig[] {
    return this.config.lines[this.line] ?? [];
  }

  private currentItem(): ItemConfig | undefined {
    return this.currentLine()[this.index];
  }

  private matches(data: string, action: "up" | "down" | "confirm" | "cancel"): boolean {
    return this.keybindings.matches(data, `tui.select.${action}`);
  }

  /** Round-trip through the validator so a hand-mangled item cannot be saved.
   *  Its warnings ride along: anything dropped here is reported, not swallowed. */
  private normalized(): EditorResult {
    return validateConfig(JSON.parse(JSON.stringify(this.config)));
  }
}

function chipLabel(item: ItemConfig): string {
  switch (item.type) {
    case "sep":
      return `sep"${(item as { text?: string }).text ?? " "}"`;
    case "split":
      return "│ split";
    case "slot":
      return `slot:${(item as { id: string }).id}`;
    case "text":
      return `"${(item as { text: string }).text}"`;
    default:
      return item.type;
  }
}

function newItem(type: ItemType): ItemConfig {
  if (type === "text") return { type, text: "text" };
  if (type === "slot") return { type, id: "slot-id" };
  if (type === "sep") return { type, text: " " };
  return { type } as ItemConfig;
}

/** Decoration a separator cannot use; the renderer emits its text as-is. */
const SEP_IGNORES = new Set(["icon", "prefix", "suffix"]);

const COMMON_FIELDS: FieldSpec[] = [
  { key: "icon", label: "icon", kind: "string", fallback: "none" },
  { key: "prefix", label: "prefix", kind: "string", fallback: "none" },
  { key: "suffix", label: "suffix", kind: "string", fallback: "none" },
  { key: "color", label: "color", kind: "enum", options: COLORS, fallback: "auto" },
  { key: "bold", label: "bold", kind: "boolean", fallback: "off" },
  { key: "hidden", label: "hidden", kind: "boolean", fallback: "off" },
  { key: "priority", label: "priority", kind: "number", fallback: "50" },
];

/**
 * The option rows for one item: its own type's settings, then anything the
 * extension behind a `slot` registered, then the settings every item shares.
 */
function fieldsFor(item: ItemConfig, slots: SlotRegistry): FieldSpec[] {
  const type = item.type;
  const specific: FieldSpec[] = [];
  switch (type) {
    case "cwd":
      specific.push({
        key: "style",
        label: "style",
        kind: "enum",
        options: CWD_STYLES,
        fallback: "home",
      });
      break;
    case "model":
      specific.push({ key: "short", label: "short", kind: "boolean", fallback: "off" });
      break;
    case "provider":
      specific.push({
        key: "onlyWhenMultiple",
        label: "only when multiple",
        kind: "boolean",
        fallback: "on",
      });
      break;
    case "thinking":
      specific.push({
        key: "onlyWhenSupported",
        label: "only when supported",
        kind: "boolean",
        fallback: "on",
      });
      break;
    case "context":
      // Listed in the order they render, so the list reads like the meter does.
      specific.push(
        { key: "showBar", label: "show bar", kind: "boolean", fallback: "off" },
        { key: "showGauge", label: "show gauge", kind: "boolean", fallback: "off" },
        { key: "showPercent", label: "show percent", kind: "boolean", fallback: "on" },
        { key: "showTokens", label: "show tokens", kind: "boolean", fallback: "off" },
        { key: "showWindow", label: "show window", kind: "boolean", fallback: "on" },
        {
          key: "percentAfterWindow",
          label: "percent after window",
          kind: "boolean",
          fallback: "off",
        },
        { key: "percentParens", label: "percent in parentheses", kind: "boolean", fallback: "off" },
        { key: "barWidth", label: "bar width", kind: "number", fallback: "8" },
        { key: "windowSeparator", label: "window separator", kind: "string", fallback: "/" },
        { key: "threshold", label: "threshold colors", kind: "boolean", fallback: "on" },
        { key: "hideWhenZero", label: "hide when zero", kind: "boolean", fallback: "off" },
        {
          key: "coldStyle",
          label: "cache-cold style",
          kind: "enum",
          options: COLD_STYLES,
          fallback: "off",
        },
        {
          key: "coldAfterMinutes",
          label: "cache-cold after (min)",
          kind: "number",
          fallback: String(DEFAULT_COLD_AFTER_MINUTES),
          min: 1,
          max: 1440,
        },
        {
          key: "coldMarker",
          label: "cache-cold marker",
          kind: "string",
          fallback: DEFAULT_COLD_MARKER,
        },
        {
          key: "coldColor",
          label: "cache-cold color",
          kind: "enum",
          options: ITEM_COLORS,
          fallback: DEFAULT_COLD_COLOR,
        },
      );
      break;
    case "time":
      specific.push({
        key: "format",
        label: "format",
        kind: "enum",
        options: TIME_FORMATS,
        fallback: "clock",
      });
      break;
    case "text":
      specific.push({ key: "text", label: "text", kind: "string", fallback: "" });
      break;
    case "sep":
      specific.push({ key: "text", label: "text", kind: "string", fallback: " " });
      break;
    case "slot":
      specific.push({ key: "id", label: "id", kind: "string", fallback: "" });
      break;
    case "extensions":
      specific.push({ key: "separator", label: "separator", kind: "string", fallback: " " });
      break;
    default:
      break;
  }

  if (type === "split") return [];
  // A separator's text is emitted verbatim, so decoration would do nothing.
  if (type === "sep") return [...specific, ...COMMON_FIELDS.filter((f) => !SEP_IGNORES.has(f.key))];
  if (type === "slot") {
    const registration = slots.registration((item as SlotItemConfig).id);
    return [...specific, ...schemaFields(registration), ...COMMON_FIELDS];
  }
  return [...specific, ...COMMON_FIELDS];
}

/**
 * Turn a producer's declared schema into editor rows.
 *
 * The "unset" text comes from the values the producer announced, so a field
 * nobody has touched reads as whatever its own config currently says — and
 * keeps reading that way when the producer's config changes underneath.
 */
function schemaFields(registration: SlotRegistration | undefined): FieldSpec[] {
  if (!registration) return [];
  return registration.fields.map((field) => {
    const announced = registration.defaults?.[field.key];
    const spec: FieldSpec = {
      key: field.key,
      label: field.label,
      kind: field.kind,
      container: "options",
      // Spelled the way the row's own value will be, so an unset field and a
      // set one read alike: `(on)` against `on`, never `(true)`.
      fallback:
        announced === undefined
          ? unsetText(field)
          : typeof announced === "boolean"
            ? announced
              ? "on"
              : "off"
            : String(announced),
    };
    if (field.options) spec.options = field.options;
    if (field.min !== undefined) spec.min = field.min;
    if (field.max !== undefined) spec.max = field.max;
    return spec;
  });
}

/** What a field with no announced default behaves as, spelled for the editor. */
function unsetText(field: SlotFieldSpec): string {
  if (field.kind === "boolean") return "off";
  if (field.kind === "enum") return field.options?.[0] ?? "";
  return "none";
}

function clampField(value: number, field: FieldSpec): number {
  let result = value;
  if (field.min !== undefined) result = Math.max(field.min, result);
  if (field.max !== undefined) result = Math.min(field.max, result);
  return result;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function fieldValueText(item: ItemConfig, field: FieldSpec): string {
  const record = item as unknown as Record<string, unknown>;
  const container =
    field.container === "options" && isRecord(record.options)
      ? (record.options as Record<string, unknown>)
      : field.container === "options"
        ? {}
        : record;
  const value = container[field.key];
  if (value === undefined) return `(${field.fallback})`;
  if (typeof value === "boolean") return value ? "on" : "off";
  if (typeof value === "string") return field.key === "text" ? `"${value}"` : value;
  return String(value);
}

function cloneConfig(config: StatuslineConfig): StatuslineConfig {
  return {
    version: 1,
    groupGap: config.groupGap,
    lines: config.lines.map((line) => line.map((item) => ({ ...item }))),
  };
}
