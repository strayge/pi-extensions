import type { ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";
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
  private selected = 0;
  private models: ModelLike[];
  private disposed = false;
  private readonly favorites: Record<string, boolean> = {};
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
      const provider = this.options.theme
        ? this.options.theme.fg("muted", `[${model.provider}]`)
        : `[${model.provider}]`;
      const current =
        key === this.options.current ? (this.options.theme?.fg("warning", " ✓") ?? " ✓") : "";
      return `${index === this.selected ? ">" : " "} ${mark}${provider} ${model.name || model.id}${current}`;
    });
    const position =
      this.models.length > maxVisible ? `  (${this.selected + 1}/${this.models.length})` : "";
    const lines = [
      "Models",
      `${label}${this.input.render(inputWidth)[0] ?? ""}`,
      ...rows,
      rows.length ? "" : "  No matching models",
      position,
      "Ctrl+F favorite | Enter select | Esc close",
    ];
    return lines.map((line) => truncateToWidth(line, safe, ""));
  }
  handleInput(data: string): void {
    if (this.disposed) return;
    if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) {
      this.options.done?.({ favorites: this.favorites });
      return;
    }
    if (matchesKey(data, Key.ctrl("f"))) {
      const model = this.models[this.selected];
      if (model) {
        const key = modelKey(model);
        this.options.states[key] = {
          ...this.options.states[key],
          favorite: !this.options.states[key]?.favorite,
        };
        this.favorites[key] = Boolean(this.options.states[key].favorite);
        const selectedKey = key;
        this.models = rankModels(this.options.models, this.options.states, this.query);
        this.selected = Math.max(
          0,
          this.models.findIndex((candidate) => modelKey(candidate) === selectedKey),
        );
      }
    } else if (matchesKey(data, Key.up)) this.selected = Math.max(0, this.selected - 1);
    else if (matchesKey(data, Key.down))
      this.selected = Math.min(Math.max(0, this.models.length - 1), this.selected + 1);
    else if (matchesKey(data, Key.enter)) {
      const model = this.models[this.selected];
      if (model) {
        this.options.done?.({ model, favorites: this.favorites });
        return;
      }
    } else {
      const before = this.input.getValue();
      this.input.handleInput(data);
      this.query = this.input.getValue();
      if (before !== this.query) {
        this.models = rankModels(this.options.models, this.options.states, this.query);
        this.selected = 0;
      }
    }
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
  const sorted = rankModels(options.models, options.states);
  const choices = sorted.map((model) => `[${model.provider}] ${model.name || model.id}`);
  const choice = await ctx.ui.select("Select model", choices);
  const model = sorted[choices.indexOf(choice ?? "")];
  return model ? { model } : {};
}
