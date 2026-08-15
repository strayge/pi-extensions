import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { CURSOR_MARKER, TUI_KEYBINDINGS, KeybindingsManager, type KeybindingsConfig, type TUI, visibleWidth } from "@earendil-works/pi-tui";
import {
  OUTSIDE_ALLOW_ONCE,
  OUTSIDE_CUSTOM_SCOPE,
  OUTSIDE_EDIT_SCOPE,
  OutsideFileApprovalComponent,
  ancestorScopes,
  isRootWidePattern,
  promptOutsideFileApproval,
  sanitizeForDisplay,
  scopeChoices,
  scopeMatches,
  validateCustomPattern,
  type OutsideFilePromptResult,
} from "./file-approval.ts";

test("scope choices include the exact request and narrow-to-broad recursive trees", () => {
  const choices = scopeChoices("/tmp/dir1/dir2/file.tmp");
  assert.deepEqual(
    choices.slice(0, 4).map((choice) => choice.scope),
    [
      { kind: "exact", value: "/tmp/dir1/dir2/file.tmp" },
      { kind: "tree", value: "/tmp/dir1/dir2" },
      { kind: "tree", value: "/tmp/dir1" },
      { kind: "tree", value: "/tmp" },
    ],
  );
});

test("existing directory targets include their own tree and root-level targets do not produce /*", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "permission-scope-"));
  try {
    const directory = path.join(root, "dir");
    mkdirSync(directory);
    writeFileSync(path.join(directory, "file.txt"), "ok");
    assert.deepEqual(ancestorScopes(directory)[0], { kind: "tree", value: directory });
    assert.deepEqual(ancestorScopes("/file.txt"), []);
    assert.ok(ancestorScopes(directory).every((scope) => scope.value !== "/"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("scope generation deduplicates normalized ancestors while exact and glob remain distinct", () => {
  const scopes = scopeChoices("/tmp/dir/../dir/file").map((choice) => choice.scope).filter(Boolean);
  assert.equal(new Set(scopes.map((scope) => `${scope!.kind}:${scope!.value}`)).size, scopes.length);
  assert.equal(scopes[0]?.kind, "exact");
  assert.ok(scopes.some((scope) => scope?.kind === "tree" && scope.value === "/tmp/dir"));
});

test("glob scopes recurse and exact scopes keep wildcard characters literal", () => {
  assert.equal(scopeMatches({ kind: "glob", value: "/tmp/*" }, "/tmp/a/b/c"), true);
  assert.equal(scopeMatches({ kind: "glob", value: "/tmp/*" }, "/var/a"), false);
  assert.equal(scopeMatches({ kind: "glob", value: "/tmp/dir/*" }, "/tmp/dir/../dir/file"), true);
  assert.equal(scopeMatches({ kind: "exact", value: "/tmp/file*?.txt" }, "/tmp/file*?.txt"), true);
  assert.equal(scopeMatches({ kind: "exact", value: "/tmp/file*?.txt" }, "/tmp/file123.txt"), false);
});

test("root-wide detection normalizes the static prefix before the first wildcard", () => {
  for (const pattern of ["/?*", "/*?", "?*", "*?", "./?*", "foo/../?*", "/tmp/../?*", "/**/**/*"]) {
    assert.equal(isRootWidePattern(pattern), true, pattern);
    assert.match(validateCustomPattern(pattern, "/tmp/a").error ?? "", /Root-wide/);
  }
  for (const pattern of ["/tmp/?*", "/tmp/*", "/tmp/../safe?*"]) {
    assert.equal(isRootWidePattern(pattern), false, pattern);
  }
});

test("custom patterns require a request match and reject unsafe forms", () => {
  assert.deepEqual(validateCustomPattern("/tmp/*", "/tmp/a/b"), { ok: true, value: "/tmp/*" });
  assert.match(validateCustomPattern("/var/*", "/tmp/a").error ?? "", /does not match/);
  assert.match(validateCustomPattern("\u0000", "/tmp/a").error ?? "", /control/);
  assert.match(validateCustomPattern(" ", "/tmp/a").error ?? "", /empty/);
});

function keybindings(userBindings: KeybindingsConfig = {}): KeybindingsManager {
  return new KeybindingsManager(TUI_KEYBINDINGS, userBindings);
}

function theme(): Theme {
  return {
    fg(color: string, text: string) {
      const codes: Record<string, string> = { mdLink: "34", accent: "33", dim: "2", text: "37", error: "31" };
      return `\u001b[${codes[color] ?? "37"}m${text}\u001b[0m`;
    },
  } as unknown as Theme;
}

function component(
  result: { value?: OutsideFilePromptResult; renders: number },
  bindings = keybindings(),
): OutsideFileApprovalComponent {
  const tui = { requestRender: () => result.renders++ } as unknown as TUI;
  return new OutsideFileApprovalComponent(
    tui,
    theme(),
    bindings,
    { toolName: "read", requested: "/tmp/dir/file.txt", projectEligible: true, globalEligible: true },
    (value) => {
      result.value = value;
    },
  );
}

test("component keeps edit and decision navigation local, with three Escape levels", () => {
  const result: { renders: number; value?: OutsideFilePromptResult } = { renders: 0 };
  const ui = component(result);
  ui.handleInput("e");
  assert.equal(ui.currentView, "selector");
  ui.handleInput("\u001b");
  assert.equal(ui.currentView, "outer");

  ui.handleInput("e");
  ui.handleInput("\u001b[B");
  ui.handleInput("\r");
  assert.equal(ui.currentView, "outer");
  assert.equal(ui.currentScope.kind, "tree");

  ui.handleInput("e");
  ui.handleInput("\u001b[B");
  ui.handleInput("\u001b[B");
  ui.handleInput("\u001b[B");
  ui.handleInput("\r");
  assert.equal(ui.currentView, "custom");
  ui.handleInput("\u001b");
  assert.equal(ui.currentView, "selector");
  ui.handleInput("\u001b");
  assert.equal(ui.currentView, "outer");

  ui.handleInput("\u001b");
  assert.equal(result.value?.decision, "deny");
  assert.ok(result.renders > 0);
});

test("component uses mdLink for the edit affordance and clamps narrow renders", () => {
  const result: { renders: number; value?: OutsideFilePromptResult } = { renders: 0 };
  const ui = component(result);
  const lines = ui.render(24);
  assert.ok(lines.some((line) => line.includes("[edit]")));
  assert.ok(lines.some((line) => line.includes("\u001b[34m[edit]")));
  assert.ok(lines.every((line) => visibleWidth(line) <= 24));
  const linkWidth = visibleWidth("\u001b[34m[edit]\u001b[0m");
  const linkLines = ui.render(linkWidth);
  assert.ok(linkLines.some((line) => line.includes("[edit]")));
  assert.ok(linkLines.every((line) => visibleWidth(line) <= linkWidth));
});

test("component honors configured selector keys and applies the selected scope", () => {
  const result: { renders: number; value?: OutsideFilePromptResult } = { renders: 0 };
  const ui = component(result, keybindings({ "tui.select.down": "j" }));
  ui.handleInput("e");
  ui.handleInput("j");
  ui.handleInput("\r");
  assert.equal(ui.currentScope.kind, "tree");
});

test("valid custom input commits the outer scope and returns to the outer prompt", () => {
  const result: { renders: number; value?: OutsideFilePromptResult } = { renders: 0 };
  const ui = component(result);
  ui.handleInput("e");
  ui.handleInput("\u001b[B");
  ui.handleInput("\u001b[B");
  ui.handleInput("\u001b[B");
  ui.handleInput("\r");
  assert.equal(ui.currentView, "custom");
  ui.handleInput("/tmp/dir/*");
  ui.handleInput("\r");
  assert.equal(ui.currentView, "outer");
  assert.deepEqual(ui.currentScope, { kind: "glob", value: "/tmp/dir/*" });
  ui.handleInput("\r");
  assert.equal(result.value?.decision, "once");
  assert.deepEqual(result.value?.scope, { kind: "glob", value: "/tmp/dir/*" });
});

test("custom Input sanitizes bracketed terminal controls without losing text or its cursor marker", () => {
  const result: { renders: number; value?: OutsideFilePromptResult } = { renders: 0 };
  const ui = component(result);
  ui.handleInput("e");
  ui.handleInput("\u001b[B");
  ui.handleInput("\u001b[B");
  ui.handleInput("\u001b[B");
  ui.handleInput("\r");
  ui.focused = true;

  ui.handleInput("\u001b[200~/tmp/\u001b]8;;https://unsafe.example\u0007*\u001b[201~");
  ui.handleInput("x");
  const rendered = ui.render(120).join("\n");
  assert.equal(rendered.includes("/tmp/*x"), true);
  assert.equal(rendered.includes("\u001b]8;;https://unsafe.example"), false);
  assert.equal(rendered.replaceAll(CURSOR_MARKER, "").includes("\u0007"), false);
  assert.equal(rendered.includes(CURSOR_MARKER), true);

  // An unframed control string is discarded, while subsequent ordinary input
  // still reaches Input.
  ui.handleInput("\u001b]8;;https://unsafe.example\u0007");
  ui.handleInput("y");
  assert.equal(ui.render(120).join("\n").includes("/tmp/*xy"), true);
});

test("Escape while the outer edit affordance is focused denies", () => {
  const result: { renders: number; value?: OutsideFilePromptResult } = { renders: 0 };
  const ui = component(result);
  ui.handleInput("\t");
  ui.handleInput("\u001b");
  assert.equal(result.value?.decision, "deny");
});

test("an exact wildcard filename is not silently prefetched as a custom glob", () => {
  const result: { renders: number; value?: OutsideFilePromptResult } = { renders: 0 };
  const tui = { requestRender: () => result.renders++ } as unknown as TUI;
  const ui = new OutsideFileApprovalComponent(
    tui,
    theme(),
    keybindings(),
    { toolName: "read", requested: "/tmp/file*?.txt", projectEligible: true, globalEligible: true },
    (value) => {
      result.value = value;
    },
  );
  ui.handleInput("e");
  ui.handleInput("\u001b[B");
  ui.handleInput("\u001b[B");
  ui.handleInput("\r");
  assert.equal(ui.currentView, "custom");
  ui.handleInput("\r");
  assert.equal(ui.currentView, "custom");
  assert.deepEqual(ui.currentScope, { kind: "exact", value: "/tmp/file*?.txt" });
});

test("Kitty arrow input, IME focus, and invalidation use the injected component APIs", () => {
  const result: { renders: number; value?: OutsideFilePromptResult } = { renders: 0 };
  const ui = component(result);
  ui.handleInput("e");
  ui.focused = true;
  assert.equal(ui.render(80).join("\n").includes(CURSOR_MARKER), false);
  ui.handleInput("\u001b[1;1B");
  assert.equal(ui.currentView, "selector");
  ui.handleInput("\u001b[1;1B");
  ui.handleInput("\r");
  assert.equal(ui.currentView, "outer");
  ui.handleInput("e");
  ui.handleInput("\u001b[1;1B");
  ui.handleInput("\u001b[1;1B");
  ui.handleInput("\u001b[1;1B");
  ui.handleInput("\r");
  assert.equal(ui.currentView, "custom");
  assert.ok(ui.render(80).join("\n").includes(CURSOR_MARKER));
  ui.invalidate();
  assert.ok(ui.render(80).length > 0);
});

test("invalidate causes themed content to be rendered with the current theme", () => {
  let accent = "33";
  const dynamicTheme = {
    fg(color: string, text: string) {
      const code = color === "accent" ? accent : color === "mdLink" ? "34" : "37";
      return `\\u001b[${code}m${text}\\u001b[0m`;
    },
  } as unknown as Theme;
  const tui = { requestRender: () => {} } as unknown as TUI;
  const ui = new OutsideFileApprovalComponent(
    tui,
    dynamicTheme,
    keybindings(),
    { toolName: "read", requested: "/tmp/file", projectEligible: true, globalEligible: true },
    () => {},
  );
  assert.ok(ui.render(80).some((line) => line.includes("\\u001b[33m")));
  accent = "35";
  ui.invalidate();
  assert.ok(ui.render(80).some((line) => line.includes("\\u001b[35m")));
});

test("tree scopes bind existing symlinks and missing tails canonically", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "permission-scope-links-"));
  try {
    const real = path.join(root, "real");
    const other = path.join(root, "other");
    mkdirSync(path.join(real, "existing"), { recursive: true });
    mkdirSync(other);
    symlinkSync(real, path.join(root, "link"));
    const requested = "link/missing/output.txt";
    const choices = scopeChoices(requested, root);
    assert.deepEqual(choices[0]?.scope, { kind: "exact", value: path.join(real, "missing/output.txt") });
    assert.deepEqual(choices[1]?.scope, { kind: "tree", value: path.join(real, "missing") });
    assert.equal(choices[1]?.displayValue, "link/missing/*");
    assert.equal(scopeMatches(choices[0]!.scope!, requested, root), true);
    assert.equal(scopeMatches(choices[1]!.scope!, "link/missing/deeper.txt", root), true);

    rmSync(path.join(root, "link"));
    symlinkSync(other, path.join(root, "link"));
    assert.equal(scopeMatches(choices[0]!.scope!, requested, root), false);
    assert.equal(scopeMatches(choices[1]!.scope!, "link/missing/deeper.txt", root), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("custom globs bind their static prefix before matching", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "permission-glob-links-"));
  try {
    const real = path.join(root, "real");
    const other = path.join(root, "other");
    mkdirSync(real);
    mkdirSync(other);
    symlinkSync(real, path.join(root, "link"));
    const request = "link/file.txt";
    const validation = validateCustomPattern("link/*", request, root);
    assert.equal(validation.ok, true);
    assert.equal(validation.value, `${real}/*`);
    assert.equal(scopeMatches({ kind: "glob", value: validation.value! }, request, root), true);
    rmSync(path.join(root, "link"));
    symlinkSync(other, path.join(root, "link"));
    assert.equal(scopeMatches({ kind: "glob", value: validation.value! }, request, root), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("requested and scope strings are escaped before TUI or RPC rendering", async () => {
  assert.equal(sanitizeForDisplay("\u001b"), "\\x1b");
  const requested = "/tmp/name\n\u001b]0;spoof\u0007.txt";
  const result: { renders: number; value?: OutsideFilePromptResult } = { renders: 0 };
  const tui = { requestRender: () => result.renders++ } as unknown as TUI;
  const ui = new OutsideFileApprovalComponent(
    tui,
    theme(),
    keybindings(),
    { toolName: "read\u001b[31m", requested, projectEligible: true, globalEligible: true },
    (value) => {
      result.value = value;
    },
  );
  const rendered = ui.render(160).join("\n");
  assert.ok(rendered.includes("\\n"));
  assert.ok(rendered.includes("\\x1b"));
  assert.equal(rendered.includes("\u001b]0;spoof"), false);

  const titles: string[] = [];
  const rpc = await promptOutsideFileApproval(
    {
      mode: "rpc",
      hasUI: true,
      ui: {
        custom: async () => undefined as never,
        async select(title) {
          titles.push(title);
          return "Deny";
        },
        async input() {
          return undefined;
        },
        notify() {},
      },
    },
    { toolName: "read\u001b[31m", requested, cwd: process.cwd(), projectEligible: false, globalEligible: false },
  );
  assert.equal(rpc.decision, "deny");
  assert.ok(titles[0]?.includes("\\n"));
  assert.equal(titles[0]?.includes("\u001b]0;spoof"), false);
});

test("RPC cancellation walks custom → selector → outer and preserves fail-closed behavior", async () => {
  const selects = [OUTSIDE_EDIT_SCOPE, OUTSIDE_CUSTOM_SCOPE, undefined, "Deny"] as Array<string | undefined>;
  const inputs: Array<string | undefined> = [undefined];
  const views: string[] = [];
  const result = await promptOutsideFileApproval(
    {
      mode: "rpc",
      hasUI: true,
      ui: {
        custom: async () => undefined as never,
        async select(title) {
          views.push(title.startsWith("Outside project") ? "outer" : "selector");
          return selects.shift();
        },
        async input() {
          return inputs.shift();
        },
        notify() {},
      },
    },
    { toolName: "read", requested: "/tmp/file", cwd: process.cwd(), projectEligible: false, globalEligible: false },
  );
  assert.equal(result.decision, "deny");
  assert.deepEqual(views, ["outer", "selector", "selector", "outer"]);
  assert.deepEqual(selects, []);
});

test("RPC custom scope commits before returning to the outer decision", async () => {
  const selects = [OUTSIDE_EDIT_SCOPE, OUTSIDE_CUSTOM_SCOPE, OUTSIDE_ALLOW_ONCE] as Array<string | undefined>;
  const inputs: Array<string | undefined> = ["/tmp/*"];
  const result = await promptOutsideFileApproval(
    {
      mode: "rpc",
      hasUI: true,
      ui: {
        custom: async () => undefined as never,
        async select() {
          return selects.shift();
        },
        async input() {
          return inputs.shift();
        },
        notify() {},
      },
    },
    { toolName: "read", requested: "/tmp/file", cwd: process.cwd(), projectEligible: false, globalEligible: false },
  );
  assert.deepEqual(result, { decision: "once", scope: { kind: "glob", value: "/tmp/*" } });
  assert.deepEqual(selects, []);
});

test("outer Enter returns the initially focused once decision", () => {
  const result: { renders: number; value?: OutsideFilePromptResult } = { renders: 0 };
  const ui = component(result);
  ui.handleInput("\r");
  assert.equal(result.value?.decision, "once");
  ui.handleInput("\u001b");
  assert.equal(result.value?.decision, "once");
});