import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { initTheme, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { editDirectoryScope } from "./directory-scope.ts";
import { bindPath } from "./paths.ts";

function fixture(t: { after: (cleanup: () => void) => void }) {
  const root = bindPath(mkdtempSync(path.join(tmpdir(), "permission-scope-ui-"))).canonical;
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const parent = path.join(root, "configuration-設定\u00a0native");
  const requested = path.join(parent, "app");
  mkdirSync(requested, { recursive: true });
  return { root, parent, requested };
}

type Factory = Parameters<ExtensionContext["ui"]["custom"]>[0];
type Dialog = Awaited<ReturnType<Factory>>;

function tuiContext(cwd: string, visit: (component: Dialog, index: number) => void): ExtensionContext {
  initTheme("dark", false);
  let dialogs = 0;
  return { cwd, hasUI: true, mode: "tui", ui: {
    custom: async (factory: Factory) => {
      let result: unknown;
      let finished = false;
      const component = await factory(
        { requestRender: () => {} } as Parameters<Factory>[0],
        { fg: (_color: string, text: string) => text, bold: (text: string) => text } as Parameters<Factory>[1],
        {} as Parameters<Factory>[2],
        (value) => { result = value; finished = true; },
      );
      try {
        visit(component, dialogs++);
        assert.ok(finished, "the dialog must finish through its callback");
        return result;
      } finally { component.dispose?.(); }
    },
  } } as unknown as ExtensionContext;
}

test("scope shortcuts list the requested directory and nearest parents without a filesystem-root shortcut", async (t) => {
  const f = fixture(t);
  const ctx = { cwd: f.root, hasUI: true, mode: "rpc", ui: {
    select: async (title: string, options: string[]) => {
      assert.ok(title.startsWith("Choose directory scope · Read-only\n\n"));
      assert.ok(title.includes(`Requested  ${f.requested}\nCurrent    ${f.requested}`));
      assert.deepEqual(options.slice(0, 3), [`${f.requested}  (requested directory)`, f.parent, f.root]);
      assert.ok(!options.includes(path.parse(f.requested).root));
      assert.ok(options.every((option) => !option.includes("(parent)")));
      assert.equal(options.at(-1), "Enter a path manually…");
      return f.parent;
    },
  } } as unknown as ExtensionContext;
  assert.deepEqual(await editDirectoryScope(ctx, f.requested, f.requested, "read"), bindPath(f.parent));
});

test("the scope picker highlights the current scope and wraps complete native paths at narrow widths", async (t) => {
  const f = fixture(t);
  const ctx = tuiContext(f.root, (component) => {
    const wide = component.render(1024).join("\n");
    assert.ok(wide.includes(`→ ${f.parent}`));
    assert.ok(wide.includes(`${f.requested}  (requested directory)`));
    for (const width of [1, 8, 20, 40, 80]) {
      const lines = component.render(width);
      for (const line of lines) assert.ok(visibleWidth(line) <= width, `line exceeds ${width} columns`);
      if (width > 1) {
        const text = stripTerminalSequences(lines.join("")).replaceAll(" ", "");
        assert.ok(text.includes(`${f.requested}(requesteddirectory)`), `requested path was cropped at ${width} columns`);
        assert.ok(text.includes(`→${f.parent}`), `selected path was cropped at ${width} columns`);
      }
    }
    component.handleInput?.("\r");
  });
  assert.deepEqual(await editDirectoryScope(ctx, f.requested, f.parent, "write"), bindPath(f.parent));
});

test("manual entry is prefilled with the current scope and still permits explicit filesystem-root access", async (t) => {
  const f = fixture(t);
  for (const current of [f.requested, "/"]) {
    const ctx = tuiContext(f.root, (component, index) => {
      if (index === 0) {
        if (current === f.requested) component.handleInput?.("\u001b[A");
        else assert.ok(component.render(1024).join("\n").includes("→ Enter a path manually…"));
      } else {
        assert.ok(component.render(1024).join("\n").includes(current));
        assert.ok("focused" in component);
        for (const width of [1, 8, 20, 80]) {
          for (const line of component.render(width)) assert.ok(visibleWidth(line) <= width);
        }
      }
      component.handleInput?.("\r");
    });
    assert.deepEqual(await editDirectoryScope(ctx, f.requested, current, "read"), bindPath(current));
  }
});

test("cancelling either the scope picker or its manual input returns no replacement scope", async (t) => {
  const f = fixture(t);
  for (const manual of [false, true]) {
    const ctx = tuiContext(f.root, (component, index) => {
      if (manual && index === 0) {
        component.handleInput?.("\u001b[A");
        component.handleInput?.("\r");
      } else component.handleInput?.("\u001b");
    });
    assert.equal(await editDirectoryScope(ctx, f.requested, f.requested, "read"), undefined);
  }
});

test("abort signals dismiss both custom scope dialogs without returning a stale selection", async (t) => {
  const f = fixture(t);
  for (const manual of [false, true]) {
    const controller = new AbortController();
    const ctx = tuiContext(f.root, (component, index) => {
      if (manual && index === 0) {
        component.handleInput?.("\u001b[A");
        component.handleInput?.("\r");
      } else controller.abort();
    });
    await assert.rejects(editDirectoryScope(ctx, f.requested, f.requested, "write", controller.signal), { name: "AbortError" });
  }
});

test("manual scope must still cover the requested target", async (t) => {
  const f = fixture(t);
  const other = path.join(f.root, "other"); mkdirSync(other);
  const ctx = { cwd: f.root, hasUI: true, mode: "rpc", ui: {
    select: async () => "Enter a path manually…",
    input: async (_title: string, initial: string) => {
      assert.equal(initial, f.requested);
      return other;
    },
  } } as unknown as ExtensionContext;
  await assert.rejects(editDirectoryScope(ctx, f.requested, f.requested, "read"), /must contain the requested target/);
});
