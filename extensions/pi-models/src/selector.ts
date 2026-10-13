import type {
  ExtensionCommandContext,
  ExtensionUIDialogOptions,
  Theme,
} from "@earendil-works/pi-coding-agent";
import {
  type Component,
  Input,
  Key,
  matchesKey,
  truncateToWidth,
  visibleWidth,
} from "@earendil-works/pi-tui";
import { type ModelLike, type ModelState, modelKey, rankModels } from "./sort.ts";

export interface SelectorResult {
  model?: ModelLike;
  favorites?: Record<string, boolean>;
  hidden?: Record<string, boolean>;
}
export interface SelectorOptions {
  models: readonly ModelLike[];
  states: Record<string, ModelState>;
  current?: string;
  theme?: Pick<Theme, "fg">;
  done?: (result: SelectorResult) => void;
}

export class ModelSelector implements Component {
  private readonly options: SelectorOptions;
  private readonly input = new Input();
  private query = "";
  private showHidden = false;
  private selected = 0;
  private models: ModelLike[];
  private disposed = false;
  private readonly favorites: Record<string, boolean> = {};
  private readonly hidden: Record<string, boolean> = {};
  constructor(options: SelectorOptions) {
    this.options = options;
    this.models = rankModels(options.models, options.states);
    this.input.focused = true;
  }
  render(width: number): string[] {
    const safe = Math.max(1, width);
    const label = "Search: ";
    const inputWidth = Math.max(1, safe - visibleWidth(label));
    const maxVisible = 16;
    const start = Math.max(
      0,
      Math.min(this.selected - Math.floor(maxVisible / 2), this.models.length - maxVisible),
    );
    const end = Math.min(start + maxVisible, this.models.length);
    const rows = this.models.slice(start, end).map((model, offset) => {
      const index = start + offset;
      const key = modelKey(model);
      const mark = this.options.states[key]?.favorite ? "*" : " ";
      const cursor = index === this.selected ? ">" : " ";
      const name = model.name || model.id;
      if (this.options.states[key]?.hidden) {
        const current = key === this.options.current ? " ✓" : "";
        const row = `${mark}[${model.provider}] ${name}${current}`;
        return `${cursor} ${this.options.theme?.fg("dim", row) ?? row}`;
      }
      const provider = this.options.theme
        ? this.options.theme.fg("muted", `[${model.provider}]`)
        : `[${model.provider}]`;
      const current =
        key === this.options.current ? (this.options.theme?.fg("warning", " ✓") ?? " ✓") : "";
      return `${cursor} ${mark}${provider} ${name}${current}`;
    });
    const position =
      this.models.length > maxVisible ? `  (${this.selected + 1}/${this.models.length})` : "";
    const hiddenCount = this.options.models.filter(
      (model) => this.options.states[modelKey(model)]?.hidden,
    ).length;
    const selectedModel = this.models[this.selected];
    const visibilityAction =
      selectedModel && this.options.states[modelKey(selectedModel)]?.hidden ? "unhide" : "hide";
    const lines = [
      `Models · ${this.showHidden ? "All" : "Visible"} · ${hiddenCount} hidden`,
      `${label}${this.input.render(inputWidth)[0] ?? ""}`,
      ...rows,
      rows.length
        ? ""
        : this.showHidden
          ? "  No matching models"
          : "  No matching visible models. Tab shows all.",
      position,
      `Ctrl+F favorite | Ctrl+D ${visibilityAction} | Tab ${this.showHidden ? "show visible" : "show all"}`,
      "Enter select | Esc close",
    ];
    return lines.map((line) => truncateToWidth(line, safe, ""));
  }
  handleInput(data: string): void {
    if (this.disposed) return;
    if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) {
      this.options.done?.({ favorites: this.favorites, hidden: this.hidden });
      return;
    }
    if (matchesKey(data, Key.ctrl("f")) || matchesKey(data, Key.ctrl("d"))) {
      const model = this.models[this.selected];
      if (model) {
        const key = modelKey(model);
        const field = matchesKey(data, Key.ctrl("f")) ? "favorite" : "hidden";
        const value = !this.options.states[key]?.[field];
        this.options.states[key] = { ...this.options.states[key], [field]: value };
        if (field === "favorite") this.favorites[key] = value;
        else this.hidden[key] = value;
        this.refreshModels(key);
      }
    } else if (matchesKey(data, Key.tab)) {
      const model = this.models[this.selected];
      this.showHidden = !this.showHidden;
      this.refreshModels(model ? modelKey(model) : undefined);
    } else if (matchesKey(data, Key.up)) this.selected = Math.max(0, this.selected - 1);
    else if (matchesKey(data, Key.down))
      this.selected = Math.min(Math.max(0, this.models.length - 1), this.selected + 1);
    else if (matchesKey(data, Key.enter)) {
      const model = this.models[this.selected];
      if (model) {
        this.options.done?.({ model, favorites: this.favorites, hidden: this.hidden });
        return;
      }
    } else {
      const before = this.input.getValue();
      this.input.handleInput(data);
      this.query = this.input.getValue();
      if (before !== this.query) {
        this.selected = 0;
        this.refreshModels();
      }
    }
  }
  private refreshModels(selectedKey?: string): void {
    this.models = rankModels(this.options.models, this.options.states, this.query, this.showHidden);
    const index = this.models.findIndex((model) => modelKey(model) === selectedKey);
    this.selected =
      index >= 0 ? index : Math.min(this.selected, Math.max(0, this.models.length - 1));
  }
  invalidate(): void {
    this.input.invalidate();
  }
  dispose(): void {
    this.disposed = true;
    this.input.focused = false;
  }
}

export async function chooseModel(
  ctx: ExtensionCommandContext,
  options: SelectorOptions,
): Promise<SelectorResult> {
  if (ctx.mode === "tui")
    return ctx.ui.custom(
      (_tui, theme, _keys, done) => new ModelSelector({ ...options, theme, done }),
    );
  let showHidden = false;
  for (;;) {
    const sorted = rankModels(options.models, options.states, "", showHidden);
    const choices = sorted.map((model) => {
      const hidden = options.states[modelKey(model)]?.hidden ? " [hidden]" : "";
      return `[${model.provider}] ${model.name || model.id}${hidden}`;
    });
    const toggleView = showHidden ? "Show visible models" : "Show all models";
    const choice = await ctx.ui.select(
      "Select model",
      [...choices, toggleView],
      Object.assign({} as ExtensionUIDialogOptions, {
        [Symbol.for("pi-extensions:input-dialog")]: false,
      }),
    );
    if (choice === toggleView) {
      showHidden = !showHidden;
      continue;
    }
    const model = sorted[choices.indexOf(choice ?? "")];
    return model ? { model } : {};
  }
}
