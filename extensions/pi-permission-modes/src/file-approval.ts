import fs from "node:fs";
import path from "node:path";
import type { Theme } from "@earendil-works/pi-coding-agent";
import {
  Input,
  matchesKey,
  truncateToWidth,
  type Component,
  type Focusable,
  type KeyId,
  type KeybindingsManager,
  type TUI,
  visibleWidth,
} from "@earendil-works/pi-tui";
import { expandHome, matchPattern } from "./resolve.ts";
import { canonicalizePath } from "./paths.ts";
import type { FileScope } from "./schema.ts";

export type { FileScope } from "./schema.ts";

export type OutsideFileDecision = "once" | "session" | "project" | "global" | "deny";

export interface OutsideFilePromptResult {
  decision: OutsideFileDecision;
  scope: FileScope;
}

export interface OutsideFilePromptRequest {
  toolName: string;
  requested: string;
  /** The cwd against which model-supplied relative paths are resolved. */
  cwd?: string;
  projectEligible: boolean;
  globalEligible: boolean;
}

export const OUTSIDE_ALLOW_ONCE = "Allow this request once";
export const OUTSIDE_ALLOW_SESSION = "Allow scope for session";
export const OUTSIDE_REMEMBER_PROJECT = "Remember for this project";
export const OUTSIDE_REMEMBER_GLOBAL = "Remember globally";
export const OUTSIDE_DENY = "Deny";
export const OUTSIDE_EDIT_SCOPE = "Edit scope…";
export const OUTSIDE_CUSTOM_SCOPE = "Custom pattern…";

const MAX_SCOPE_LENGTH = 4096;

function hasControlCharacters(value: string): boolean {
  return [...value].some((character) => {
    const code = character.charCodeAt(0);
    return code <= 0x1f || code === 0x7f || (code >= 0x80 && code <= 0x9f);
  });
}

/** Replace terminal control bytes with visible escape text before rendering. */
export function sanitizeForDisplay(value: string): string {
  let result = "";
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code === 0x09) result += "\\t";
    else if (code === 0x0a) result += "\\n";
    else if (code === 0x0d) result += "\\r";
    else if (code < 0x20 || code === 0x7f) result += `\\x${code.toString(16).padStart(2, "0")}`;
    else if (code >= 0x80 && code <= 0x9f) result += `\\u${code.toString(16).padStart(4, "0")}`;
    else result += character;
  }
  return result;
}

export interface ScopeChoice {
  scope?: FileScope;
  label: string;
  /** A user-facing representation, separate from the canonical policy value. */
  displayValue?: string;
}

function normalizedPath(value: string): string {
  return path.normalize(value);
}

/** Root-wide glob patterns are intentionally unavailable from the approval prompt. */
export function isRootWidePattern(value: string): boolean {
  const normalized = value.trim().replaceAll("\\", "/");
  const wildcard = normalized.search(/[?*]/u);
  if (wildcard < 0) return false;

  // Only the literal prefix constrains a glob. Normalize it separately so a
  // traversal before the first wildcard cannot disguise the root it covers.
  const staticPrefix = path.normalize(normalized.slice(0, wildcard) || ".");
  const resolvedPrefix = path.resolve(staticPrefix);
  return staticPrefix === "." || resolvedPrefix === path.resolve(".") || resolvedPrefix === path.parse(resolvedPrefix).root;
}

const PASTE_START = "\u001b[200~";
const PASTE_END = "\u001b[201~";

type UnsafeControlString = "osc" | "control";

function unsafeControlStringStart(value: string, index: number): { kind: UnsafeControlString; length: number } | undefined {
  const code = value.charCodeAt(index);
  if (code === 0x9d) return { kind: "osc", length: 1 };
  if (code === 0x90 || code === 0x98 || code === 0x9e || code === 0x9f) return { kind: "control", length: 1 };
  if (code !== 0x1b) return undefined;
  const next = value.charCodeAt(index + 1);
  if (next === 0x5d) return { kind: "osc", length: 2 };
  if (next === 0x50 || next === 0x58 || next === 0x5e || next === 0x5f) return { kind: "control", length: 2 };
  return undefined;
}

function controlStringEnd(value: string, index: number, kind: UnsafeControlString): number {
  for (let cursor = index; cursor < value.length; cursor++) {
    const code = value.charCodeAt(cursor);
    if (code === 0x9c) return cursor + 1;
    if (code === 0x1b && value.charCodeAt(cursor + 1) === 0x5c) return cursor + 2;
    if (kind === "osc" && code === 0x07) return cursor + 1;
  }
  return -1;
}

function csiEnd(value: string, index: number): number {
  const first = value.charCodeAt(index);
  const cursor = first === 0x9b ? index + 1 : index + 2;
  for (let end = cursor; end < value.length; end++) {
    const code = value.charCodeAt(end);
    if (code >= 0x40 && code <= 0x7e) return end + 1;
  }
  return -1;
}

function sanitizePastePayload(value: string): string {
  let result = "";
  let index = 0;
  while (index < value.length) {
    const stringStart = unsafeControlStringStart(value, index);
    if (stringStart) {
      const end = controlStringEnd(value, index + stringStart.length, stringStart.kind);
      if (end < 0) break;
      index = end;
      continue;
    }

    const code = value.charCodeAt(index);
    if (code === 0x9b || (code === 0x1b && value.charCodeAt(index + 1) === 0x5b)) {
      const end = csiEnd(value, index);
      if (end < 0) break;
      index = end;
      continue;
    }
    if (code === 0x1b) {
      index += Math.min(2, value.length - index);
      continue;
    }
    if (code === 0x09) {
      result += "    ";
      index++;
      continue;
    }
    if (code < 0x20 || code === 0x7f || (code >= 0x80 && code <= 0x9f)) {
      index++;
      continue;
    }
    result += value[index];
    index++;
  }
  return result;
}

interface SanitizedInput {
  value: string;
  state: UnsafeControlString | undefined;
  pasteRemainder?: string;
}

/** Remove unframed terminal control strings while leaving key sequences intact. */
function sanitizeUnframedInput(value: string, state?: UnsafeControlString): SanitizedInput {
  let result = "";
  let index = 0;
  let active = state;
  while (index < value.length) {
    if (active) {
      const end = controlStringEnd(value, index, active);
      if (end < 0) return { value: result, state: active };
      active = undefined;
      index = end;
      continue;
    }

    if (value.startsWith(PASTE_START, index)) {
      return { value: `${result}${PASTE_START}`, state: undefined, pasteRemainder: value.slice(index + PASTE_START.length) };
    }
    const stringStart = unsafeControlStringStart(value, index);
    if (stringStart) {
      const end = controlStringEnd(value, index + stringStart.length, stringStart.kind);
      if (end < 0) return { value: result, state: stringStart.kind };
      index = end;
      continue;
    }
    result += value[index];
    index++;
  }
  return { value: result, state: active };
}

function scopeShape(scope: unknown): scope is FileScope {
  if (!scope || typeof scope !== "object" || Array.isArray(scope)) return false;
  const candidate = scope as { kind?: unknown; value?: unknown };
  return (
    Object.keys(candidate).every((key) => key === "kind" || key === "value") &&
    (candidate.kind === "exact" || candidate.kind === "tree" || candidate.kind === "glob") &&
    typeof candidate.value === "string" &&
    candidate.value.length > 0 &&
    candidate.value.length <= MAX_SCOPE_LENGTH &&
    !hasControlCharacters(candidate.value)
  );
}

function targetForComparison(target: string, cwd?: string): string {
  if (cwd === undefined && !path.isAbsolute(target)) return normalizedPath(target);
  return canonicalizePath(expandHome(target), cwd);
}

function boundScopeValue(scope: FileScope, cwd?: string): string {
  if (cwd === undefined && !path.isAbsolute(scope.value)) return normalizedPath(scope.value);
  return normalizedPath(scope.value);
}

function containsPath(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

/** Match a typed scope without allowing a failed matcher to become an allow. */
export function scopeMatches(scope: FileScope, target: string, cwd?: string): boolean {
  if (!scopeShape(scope)) return false;
  const targetValue = targetForComparison(target, cwd);
  const scopeValue = boundScopeValue(scope, cwd);
  if (scope.kind === "exact") return scopeValue === targetValue;
  if (scope.kind === "tree") return containsPath(scopeValue, targetValue);
  try {
    return matchPattern(scopeValue, targetValue);
  } catch {
    return false;
  }
}

export function scopeKey(scope: FileScope): string {
  return `${scope.kind}:${scope.value}`;
}

function scopeDirectoryCandidates(requested: string, cwd?: string): Array<{ scope: FileScope; displayValue: string }> {
  const expanded = expandHome(requested);
  const source = cwd === undefined ? normalizedPath(expanded) : path.resolve(cwd, expanded);
  const displaySource = normalizedPath(expanded);
  const targetIsDirectory = (() => {
    try {
      return fs.statSync(source).isDirectory();
    } catch {
      return false;
    }
  })();
  const result: Array<{ scope: FileScope; displayValue: string }> = [];
  let current = targetIsDirectory ? source : path.dirname(source);
  let displayCurrent = targetIsDirectory ? displaySource : path.dirname(displaySource);
  const root = path.parse(current).root;

  while (current && current !== root && current !== ".") {
    const displayValue = `${displayCurrent}${path.sep}*`;
    const value = cwd === undefined ? normalizedPath(current) : canonicalizePath(current, cwd);
    if (value !== path.parse(value).root) result.push({ scope: { kind: "tree", value }, displayValue });
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
    displayCurrent = path.dirname(displayCurrent);
  }
  return result;
}

/** Return generated literal tree scopes from narrow to broad. */
export function ancestorScopes(requested: string, cwd?: string): FileScope[] {
  return scopeDirectoryCandidates(requested, cwd).map(({ scope }) => scope);
}

function requestPath(requested: string, cwd?: string): string {
  return cwd === undefined ? requested : canonicalizePath(expandHome(requested), cwd);
}

/** Build selector choices while retaining a separate display form for each value. */
export function scopeChoices(requested: string, cwd?: string): ScopeChoice[] {
  const exact: FileScope = { kind: "exact", value: requestPath(requested, cwd) };
  const seen = new Set<string>([scopeKey(exact)]);
  const choices: ScopeChoice[] = [{ scope: exact, label: "Exact", displayValue: requested }];
  for (const candidate of scopeDirectoryCandidates(requested, cwd)) {
    if (seen.has(scopeKey(candidate.scope))) continue;
    seen.add(scopeKey(candidate.scope));
    const index = choices.length;
    choices.push({
      scope: candidate.scope,
      label: index === 1 ? "Directory tree" : index === 2 ? "Parent tree" : "Ancestor tree",
      displayValue: candidate.displayValue,
    });
  }
  choices.push({ label: OUTSIDE_CUSTOM_SCOPE });
  return choices;
}

export function describeScope(scope: FileScope): string {
  if (scope.kind === "exact") return `Exact: ${sanitizeForDisplay(scope.value)}`;
  if (scope.kind === "tree") return `Tree: ${sanitizeForDisplay(scope.value)}/*`;
  return `Glob: ${sanitizeForDisplay(scope.value)}`;
}

export interface ScopeValidation {
  ok: boolean;
  value?: string;
  /** Raw, trimmed text used only for the UI; policy always uses `value`. */
  display?: string;
  error?: string;
}

function canonicalizeGlobPattern(value: string, cwd: string): string | undefined {
  const expanded = expandHome(value);
  const absolute = path.resolve(cwd, expanded);
  const wildcard = absolute.search(/[?*]/u);
  if (wildcard < 0) return canonicalizePath(absolute, cwd);
  const cut = absolute.lastIndexOf(path.sep, wildcard);
  if (cut <= 0) return absolute;
  const staticPrefix = absolute.slice(0, cut);
  const suffix = absolute.slice(cut);
  const canonicalPrefix = canonicalizePath(staticPrefix, cwd);
  const result = `${canonicalPrefix}${suffix}`;
  return isRootWidePattern(result) ? undefined : result;
}

/** Bind a UI or configuration scope to canonical filesystem targets. */
export function canonicalizeScope(scope: FileScope, cwd: string = process.cwd()): FileScope | undefined {
  if (!scopeShape(scope)) return undefined;
  if (!path.isAbsolute(scope.value)) return undefined;
  if (scope.kind === "glob") {
    const value = canonicalizeGlobPattern(scope.value, cwd);
    if (!value || isRootWidePattern(value)) return undefined;
    return { kind: "glob", value };
  }
  const value = canonicalizePath(scope.value, cwd);
  if (scope.kind === "tree" && value === path.parse(value).root) return undefined;
  return { kind: scope.kind, value };
}

/** Validate a custom glob and require it to cover the original request. */
export function validateCustomPattern(raw: string, requested: string, cwd?: string): ScopeValidation {
  const display = raw.trim();
  if (!display) return { ok: false, error: "Pattern cannot be empty." };
  if (display.length > MAX_SCOPE_LENGTH) return { ok: false, error: "Pattern is too long." };
  if (hasControlCharacters(display)) return { ok: false, error: "Pattern contains control characters." };
  if (isRootWidePattern(display)) return { ok: false, error: "Root-wide patterns are not accepted here." };

  const value = cwd === undefined ? display : canonicalizeGlobPattern(display, cwd);
  if (!value || isRootWidePattern(value)) return { ok: false, error: "Pattern cannot be safely bound to this path." };
  const target = requestPath(requested, cwd);
  if (!scopeMatches({ kind: "glob", value }, target, cwd)) {
    return { ok: false, error: "Pattern does not match the requested path." };
  }
  return cwd === undefined ? { ok: true, value } : { ok: true, value, display };
}

/** Validate a stored scope before canonical binding and configuration loading. */
export function isValidStoredScope(scope: unknown): scope is FileScope {
  if (!scopeShape(scope) || !path.isAbsolute(scope.value)) return false;
  if (scope.kind === "glob" && isRootWidePattern(scope.value)) return false;
  if (scope.kind === "tree" && scope.value === path.parse(scope.value).root) return false;
  return true;
}

function fit(line: string, width: number): string {
  return truncateToWidth(line, Math.max(1, width), "");
}

function styledPath(theme: Theme, value: string): string {
  return theme.fg("text", sanitizeForDisplay(value));
}

function keyMatches(
  keybindings: KeybindingsManager,
  data: string,
  binding: Parameters<KeybindingsManager["matches"]>[1],
  fallback: KeyId,
): boolean {
  return keybindings.matches(data, binding) || matchesKey(data, fallback);
}

/**
 * One component owns the outer decision, selector, and custom input views. A
 * committed scope changes only when a selector choice or valid custom pattern
 * is confirmed; every back action remains fail-closed at the outer boundary.
 */
export class OutsideFileApprovalComponent implements Component, Focusable {
  private view: "outer" | "selector" | "custom" = "outer";
  private outerFocus: "decision" | "edit" = "decision";
  private decisionIndex = 0;
  private selectorIndex = 0;
  private draftScope: FileScope;
  private scope: FileScope;
  private scopeDisplay: string;
  private customError: string | undefined;
  private readonly choices: ScopeChoice[];
  private readonly input: Input;
  private pasteBuffer = "";
  private pasting = false;
  private unsafeControlString: UnsafeControlString | undefined;
  private focusedValue = false;
  private completed = false;
  private readonly tui: TUI;
  private readonly theme: Theme;
  private readonly keybindings: KeybindingsManager;
  private readonly request: OutsideFilePromptRequest;
  private readonly cwd: string;
  private readonly done: (result: OutsideFilePromptResult) => void;

  constructor(
    tui: TUI,
    theme: Theme,
    keybindings: KeybindingsManager,
    request: OutsideFilePromptRequest,
    done: (result: OutsideFilePromptResult) => void,
  ) {
    this.tui = tui;
    this.theme = theme;
    this.keybindings = keybindings;
    this.request = request;
    this.cwd = request.cwd ?? process.cwd();
    this.done = done;
    this.scope = { kind: "exact", value: requestPath(request.requested, this.cwd) };
    this.scopeDisplay = request.requested;
    this.draftScope = this.scope;
    this.choices = scopeChoices(request.requested, this.cwd);
    this.selectorIndex = this.findChoice(this.scope);
    this.input = new Input();
    this.input.onEscape = () => this.backFromCustom();
    this.input.onSubmit = (value) => this.commitCustom(value);
  }

  get focused(): boolean {
    return this.focusedValue;
  }

  set focused(value: boolean) {
    this.focusedValue = value;
    this.syncInputFocus();
  }

  get currentScope(): FileScope {
    return this.scope;
  }

  get currentView(): "outer" | "selector" | "custom" {
    return this.view;
  }

  private syncInputFocus(): void {
    this.input.focused = this.focusedValue && this.view === "custom";
  }

  private resetInputSanitizer(): void {
    this.pasteBuffer = "";
    this.pasting = false;
    this.unsafeControlString = undefined;
  }

  private forwardSanitizedInput(data: string): void {
    if (!data) return;
    if (!this.pasting) {
      const sanitized = sanitizeUnframedInput(data, this.unsafeControlString);
      this.unsafeControlString = sanitized.state;
      if (sanitized.pasteRemainder === undefined) {
        this.input.handleInput(sanitized.value);
        return;
      }
      const prefix = sanitized.value.slice(0, -PASTE_START.length);
      this.input.handleInput(prefix);
      this.pasting = true;
      this.pasteBuffer = sanitized.pasteRemainder;
    } else {
      this.pasteBuffer += data;
    }

    const end = this.pasteBuffer.indexOf(PASTE_END);
    if (end < 0) return;
    const payload = this.pasteBuffer.slice(0, end);
    const remaining = this.pasteBuffer.slice(end + PASTE_END.length);
    this.input.handleInput(`${PASTE_START}${sanitizePastePayload(payload)}${PASTE_END}`);
    this.pasteBuffer = "";
    this.pasting = false;
    if (remaining) this.forwardSanitizedInput(remaining);
  }

  private refresh(): void {
    this.syncInputFocus();
    this.tui.requestRender();
  }

  private findChoice(scope: FileScope): number {
    const index = this.choices.findIndex((choice) => choice.scope && scopeKey(choice.scope) === scopeKey(scope));
    return index >= 0 ? index : this.choices.length - 1;
  }

  private complete(decision: OutsideFileDecision): void {
    if (this.completed) return;
    this.completed = true;
    this.done({ decision, scope: this.scope });
  }

  private decisionChoices(): Array<{ label: string; decision: OutsideFileDecision }> {
    const choices: Array<{ label: string; decision: OutsideFileDecision }> = [
      { label: OUTSIDE_ALLOW_ONCE, decision: "once" },
      { label: OUTSIDE_ALLOW_SESSION, decision: "session" },
    ];
    if (this.request.projectEligible) choices.push({ label: OUTSIDE_REMEMBER_PROJECT, decision: "project" });
    if (this.request.globalEligible) choices.push({ label: OUTSIDE_REMEMBER_GLOBAL, decision: "global" });
    choices.push({ label: OUTSIDE_DENY, decision: "deny" });
    return choices;
  }

  private openSelector(): void {
    this.view = "selector";
    this.draftScope = this.scope;
    this.selectorIndex = this.findChoice(this.scope);
    this.customError = undefined;
    this.refresh();
  }

  private openCustom(): void {
    this.view = "custom";
    this.customError = undefined;
    this.resetInputSanitizer();
    // An exact filename containing `*` or `?` is intentionally not prefilled
    // into a glob editor. The user must type a pattern explicitly.
    const initial = this.draftScope.kind === "glob" ? this.draftScope.value : "";
    this.input.setValue(hasControlCharacters(initial) ? sanitizeForDisplay(initial) : initial);
    this.refresh();
  }

  private backFromCustom(): void {
    this.resetInputSanitizer();
    this.view = "selector";
    this.customError = undefined;
    this.refresh();
  }

  private commitCustom(raw: string): void {
    const validation = validateCustomPattern(raw, this.request.requested, this.cwd);
    if (!validation.ok || !validation.value) {
      this.customError = validation.error;
      this.refresh();
      return;
    }
    this.scope = { kind: "glob", value: validation.value };
    this.scopeDisplay = validation.display ?? validation.value;
    this.draftScope = this.scope;
    this.resetInputSanitizer();
    this.customError = undefined;
    // A valid custom submission is itself the confirmation action. Returning
    // directly to the outer prompt prevents the custom value being stranded in
    // an uncommitted selector draft.
    this.view = "outer";
    this.outerFocus = "decision";
    this.decisionIndex = 0;
    this.refresh();
  }

  private selectScope(): void {
    const selected = this.choices[this.selectorIndex];
    if (!selected) return;
    if (!selected.scope) {
      this.draftScope = this.scope;
      this.openCustom();
      return;
    }
    this.scope = selected.scope;
    this.scopeDisplay = selected.displayValue ?? selected.scope.value;
    this.draftScope = this.scope;
    this.view = "outer";
    this.outerFocus = "decision";
    this.decisionIndex = 0;
    this.refresh();
  }

  handleInput(data: string): void {
    if (this.completed) return;
    if (this.view === "custom") {
      // Input uses the process-wide keybinding registry internally. Check the
      // injected manager first so custom bindings and Kitty CSI-u keys follow
      // the active prompt's bindings as well.
      if (keyMatches(this.keybindings, data, "tui.select.cancel", "escape")) {
        this.backFromCustom();
        return;
      }
      if (keyMatches(this.keybindings, data, "tui.input.submit", "enter")) {
        this.commitCustom(this.input.getValue());
        return;
      }
      this.forwardSanitizedInput(data);
      this.refresh();
      return;
    }

    if (this.view === "selector") {
      if (keyMatches(this.keybindings, data, "tui.select.cancel", "escape")) {
        this.view = "outer";
        this.draftScope = this.scope;
        this.customError = undefined;
        this.refresh();
        return;
      }
      if (keyMatches(this.keybindings, data, "tui.select.up", "up")) {
        this.selectorIndex = Math.max(0, this.selectorIndex - 1);
        this.refresh();
        return;
      }
      if (keyMatches(this.keybindings, data, "tui.select.down", "down")) {
        this.selectorIndex = Math.min(this.choices.length - 1, this.selectorIndex + 1);
        this.refresh();
        return;
      }
      if (keyMatches(this.keybindings, data, "tui.select.confirm", "enter")) {
        this.selectScope();
        return;
      }
      return;
    }

    if (keyMatches(this.keybindings, data, "tui.select.cancel", "escape")) {
      this.complete("deny");
      return;
    }
    if (matchesKey(data, "e")) {
      this.openSelector();
      return;
    }
    if (keyMatches(this.keybindings, data, "tui.input.tab", "tab") || matchesKey(data, "shift+tab")) {
      this.outerFocus = this.outerFocus === "edit" ? "decision" : "edit";
      this.refresh();
      return;
    }
    if (this.outerFocus === "edit") {
      if (keyMatches(this.keybindings, data, "tui.select.confirm", "enter")) {
        this.openSelector();
      } else if (
        keyMatches(this.keybindings, data, "tui.select.up", "up") ||
        keyMatches(this.keybindings, data, "tui.select.down", "down")
      ) {
        this.outerFocus = "decision";
        this.refresh();
      }
      return;
    }
    const decisions = this.decisionChoices();
    if (keyMatches(this.keybindings, data, "tui.select.up", "up")) {
      this.decisionIndex = Math.max(0, this.decisionIndex - 1);
      this.refresh();
      return;
    }
    if (keyMatches(this.keybindings, data, "tui.select.down", "down")) {
      this.decisionIndex = Math.min(decisions.length - 1, this.decisionIndex + 1);
      this.refresh();
      return;
    }
    if (keyMatches(this.keybindings, data, "tui.select.confirm", "enter")) {
      this.complete(decisions[this.decisionIndex]?.decision ?? "deny");
    }
  }

  private renderScopeLine(width: number): string {
    const prefix = "Scope:     ";
    const link = this.theme.fg("mdLink", "[edit]");
    const linkWidth = visibleWidth(link);
    if (width <= linkWidth) return truncateToWidth(link, Math.max(1, width), "");

    const gapWidth = Math.min(2, width - linkWidth);
    const leftWidth = width - linkWidth - gapWidth;
    const left = truncateToWidth(`${prefix}${styledPath(this.theme, this.scopeDisplay)}`, leftWidth, "");
    return `${left}${" ".repeat(gapWidth)}${link}`;
  }

  private renderOuter(width: number): string[] {
    const lines = [
      this.theme.fg("accent", `Outside project — allow ${sanitizeForDisplay(this.request.toolName)}?`),
      "",
      fit(`Requested: ${styledPath(this.theme, this.request.requested)}`, width),
      this.renderScopeLine(width),
      "",
    ];
    const decisions = this.decisionChoices();
    for (let i = 0; i < decisions.length; i++) {
      const selected = this.outerFocus === "decision" && i === this.decisionIndex;
      const prefix = selected ? this.theme.fg("accent", "→ ") : "  ";
      lines.push(fit(`${prefix}${decisions[i]!.label}`, width));
    }
    lines.push("", fit(this.theme.fg("dim", "↑↓ choose • Enter confirm • Tab/e edit scope • Esc deny"), width));
    return lines.map((line) => fit(line, width));
  }

  private renderSelector(width: number): string[] {
    const lines = [
      this.theme.fg("accent", "Choose access scope"),
      "",
      fit(`Requested: ${styledPath(this.theme, this.request.requested)}`, width),
      fit(this.theme.fg("dim", "* includes descendants at any depth."), width),
      "",
    ];
    for (let i = 0; i < this.choices.length; i++) {
      const choice = this.choices[i]!;
      const selected = i === this.selectorIndex;
      const prefix = selected ? this.theme.fg("accent", "→ ") : "  ";
      const text = choice.scope ? `${choice.label}: ${sanitizeForDisplay(choice.displayValue ?? choice.scope.value)}` : choice.label;
      lines.push(fit(`${prefix}${text}`, width));
    }
    lines.push("", fit(this.theme.fg("dim", "↑↓ choose • Enter apply • Esc back"), width));
    return lines.map((line) => fit(line, width));
  }

  private renderCustom(width: number): string[] {
    const lines = [
      this.theme.fg("accent", "Custom access pattern"),
      "",
      fit(`Requested: ${styledPath(this.theme, this.request.requested)}`, width),
      fit("Pattern:   ", width),
    ];
    const inputWidth = Math.max(1, width - visibleWidth("Pattern:   "));
    const renderedInput = this.input.render(inputWidth);
    lines[lines.length - 1] = fit(`Pattern:   ${renderedInput[0] ?? ""}`, width);
    if (this.customError) lines.push(fit(this.theme.fg("error", sanitizeForDisplay(this.customError)), width));
    lines.push("", fit(this.theme.fg("dim", "Enter apply • Esc back"), width));
    return lines.map((line) => fit(line, width));
  }

  render(width: number): string[] {
    const safeWidth = Math.max(1, width);
    if (this.view === "selector") return this.renderSelector(safeWidth);
    if (this.view === "custom") return this.renderCustom(safeWidth);
    return this.renderOuter(safeWidth);
  }

  invalidate(): void {
    this.input.invalidate();
  }
}

function displayScopeLines(request: OutsideFilePromptRequest, scopeDisplay: string): string {
  return `Requested: ${sanitizeForDisplay(request.requested)}\nScope:     ${sanitizeForDisplay(scopeDisplay)}`;
}

function choiceLabel(choice: ScopeChoice): string {
  return choice.scope ? `${choice.label}: ${sanitizeForDisplay(choice.displayValue ?? choice.scope.value)}` : choice.label;
}

/**
 * Prompt in TUI mode with the stateful component, or use the RPC select/input
 * primitives. Custom cancellation returns to the selector, selector
 * cancellation returns to the outer decision, and only outer cancellation
 * denies the request.
 */
export async function promptOutsideFileApproval(
  ctx: {
    mode: string;
    hasUI: boolean;
    ui: {
      custom<T>(factory: (tui: TUI, theme: Theme, keybindings: KeybindingsManager, done: (value: T) => void) => Component): Promise<T>;
      select(title: string, options: string[]): Promise<string | undefined>;
      input(title: string, placeholder?: string): Promise<string | undefined>;
      notify(message: string, level?: "info" | "warning" | "error"): void;
    };
  },
  request: OutsideFilePromptRequest,
): Promise<OutsideFilePromptResult> {
  const cwd = request.cwd ?? process.cwd();
  const exact: FileScope = { kind: "exact", value: requestPath(request.requested, cwd) };
  if (!ctx.hasUI) return { decision: "deny", scope: exact };

  if (ctx.mode === "tui") {
    const result = await ctx.ui.custom<OutsideFilePromptResult | undefined>(
      (tui, theme, keybindings, done) => new OutsideFileApprovalComponent(tui, theme, keybindings, request, done),
    );
    return result ?? { decision: "deny", scope: exact };
  }

  let scope: FileScope = exact;
  let scopeDisplay = request.requested;
  const choices = scopeChoices(request.requested, cwd);
  const selectorOptions = choices.map(choiceLabel);
  const decisionOptions = [OUTSIDE_ALLOW_ONCE, OUTSIDE_ALLOW_SESSION];
  if (request.projectEligible) decisionOptions.push(OUTSIDE_REMEMBER_PROJECT);
  if (request.globalEligible) decisionOptions.push(OUTSIDE_REMEMBER_GLOBAL);
  decisionOptions.push(OUTSIDE_DENY);

  let view: "outer" | "selector" | "custom" = "outer";
  while (true) {
    if (view === "outer") {
      const choice = await ctx.ui.select(
        `Outside project — allow ${sanitizeForDisplay(request.toolName)}?\n${displayScopeLines(request, scopeDisplay)}`,
        [...decisionOptions.slice(0, 2), OUTSIDE_EDIT_SCOPE, ...decisionOptions.slice(2)],
      );
      if (choice === undefined || choice === OUTSIDE_DENY) return { decision: "deny", scope };
      if (choice === OUTSIDE_ALLOW_ONCE) return { decision: "once", scope };
      if (choice === OUTSIDE_ALLOW_SESSION) return { decision: "session", scope };
      if (choice === OUTSIDE_REMEMBER_PROJECT) return { decision: "project", scope };
      if (choice === OUTSIDE_REMEMBER_GLOBAL) return { decision: "global", scope };
      if (choice === OUTSIDE_EDIT_SCOPE) view = "selector";
      continue;
    }

    if (view === "selector") {
      const selected = await ctx.ui.select(
        `Choose access scope\n${displayScopeLines(request, scopeDisplay)}\n* includes descendants at any depth.`,
        selectorOptions,
      );
      if (selected === undefined) {
        view = "outer";
        continue;
      }
      const selectedChoice = choices[selectorOptions.indexOf(selected)];
      if (!selectedChoice) continue;
      if (selectedChoice.scope) {
        scope = selectedChoice.scope;
        scopeDisplay = selectedChoice.displayValue ?? selectedChoice.scope.value;
        view = "outer";
      } else {
        view = "custom";
      }
      continue;
    }

    const value = await ctx.ui.input("Custom access pattern", scope.kind === "glob" ? sanitizeForDisplay(scopeDisplay) : "");
    if (value === undefined) {
      view = "selector";
      continue;
    }
    const validation = validateCustomPattern(value, request.requested, cwd);
    if (!validation.ok || !validation.value) {
      ctx.ui.notify(validation.error ?? "Invalid pattern.", "warning");
      continue;
    }
    scope = { kind: "glob", value: validation.value };
    scopeDisplay = validation.display ?? validation.value;
    view = "outer";
  }
}
