import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ApprovalRequest } from "./approvals.ts";
import { approvalUI, networkUI } from "./file-approval.ts";
import { approvalDialogOptions } from "./input-dialog.ts";
import { bindPath, revalidate } from "./paths.ts";

function fixture(t: { after: (cleanup: () => void) => void }) {
  const root = bindPath(mkdtempSync(path.join(tmpdir(), "permission-approval-ui-"))).canonical;
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const directory = path.join(root, "directory");
  mkdirSync(directory);
  const request: ApprovalRequest = {
    kind: "directory", path: directory, access: "write", reason: "Update configuration", create: false,
  };
  return { root, directory, request };
}

function context(cwd: string, ui: Partial<ExtensionContext["ui"]>): ExtensionContext {
  return { cwd, hasUI: true, ui: {
    ...ui,
    select: async (...args: Parameters<ExtensionContext["ui"]["select"]>) => args[0].startsWith("Choose directory scope")
      ? "Enter a path manually…" : ui.select!(...args),
  } } as ExtensionContext;
}

const directoryOptions = ["Allow for this session", "Remember for this project", "Save globally", "Edit directory scope", "Deny and block for this session", "Deny"];

test("directory approval chooses scope and lifetime in one menu", async (t) => {
  const f = fixture(t);
  for (const [choice, lifetime] of [["Allow for this session", "session"], ["Remember for this project", "project"], ["Save globally", "global"]]) {
    let prompts = 0;
    const ask = approvalUI(() => context(f.root, {
      select: async (title, options) => {
        prompts++;
        assert.deepEqual(options, directoryOptions);
        assert.equal(title, `Directory access · Read/write\n\nPath    ${f.directory}\nScope   Directory and all descendants\n\nReason\n${f.request.reason}\n\nNote: Blocking write access does not block reads.\n      Reads still require permission.`);
        return choice;
      },
    }));
    const answer = await ask(f.request);
    assert.equal(prompts, 1);
    assert.equal(answer?.lifetime, lifetime);
    assert.equal(answer?.directory, f.directory);
    assert.deepEqual(answer?.binding, bindPath(f.directory));
  }
});

test("filesystem approval and every native scope-edit step retain the request's input intent", async (t) => {
  const f = fixture(t);
  const marker = Symbol.for("pi-extensions:input-dialog");
  for (const agentWait of [undefined, false]) {
    const controller = new AbortController();
    let prompts = 0;
    const checkOptions = (options: Parameters<ExtensionContext["ui"]["select"]>[2]) => {
      assert.equal(options?.signal, controller.signal);
      assert.equal(Reflect.get(options!, marker), agentWait === false ? false : undefined);
    };
    const ctx = { cwd: f.root, hasUI: true, mode: "rpc", ui: {
      select: async (title, _items, options) => {
        checkOptions(options);
        prompts++;
        if (title.startsWith("Choose directory scope")) return "Enter a path manually…";
        return prompts === 1 ? "Edit directory scope" : "Allow for this session";
      },
      input: async (_title, current, options) => {
        checkOptions(options);
        prompts++;
        assert.equal(current, f.directory);
        return f.root;
      },
    } } as ExtensionContext;
    const request = Object.freeze({ ...f.request, agentWait });
    const answer = await approvalUI(() => ctx)(request, controller.signal);
    assert.equal(answer?.directory, f.root);
    assert.equal(answer?.lifetime, "session");
    assert.equal(prompts, 4);
  }
});

test("native opt-out metadata preserves existing dialog options without mutating them", () => {
  const signal = new AbortController().signal;
  const existing = { signal, timeout: 1234 };
  const options = approvalDialogOptions(false, existing);
  assert.equal(options.signal, signal);
  assert.equal(options.timeout, 1234);
  assert.equal(Reflect.get({ ...options }, Symbol.for("pi-extensions:input-dialog")), false);
  assert.deepEqual(existing, { signal, timeout: 1234 });
  assert.equal(approvalDialogOptions(undefined, existing), existing);
});

test("network approvals remain tracked and preserve the owner cancellation signal", async (t) => {
  const f = fixture(t); const signal = new AbortController().signal;
  const ctx = context(f.root, { select: async (title, _items, options) => {
    assert.equal(title, "Network access: example.test:443");
    assert.equal(options?.signal, signal);
    assert.equal(Reflect.get(options!, Symbol.for("pi-extensions:input-dialog")), undefined);
    return "Allow for this session";
  } });
  assert.equal(await networkUI(() => ctx, () => signal)("example.test", 443), "allow-session");
});

test("denying or dismissing the menu never opens another prompt", async (t) => {
  const f = fixture(t);
  for (const choice of ["Deny", undefined]) {
    let prompts = 0;
    const ask = approvalUI(() => context(f.root, {
      select: async () => { prompts++; return choice; },
    }));
    assert.equal(await ask(f.request), undefined);
    assert.equal(prompts, 1);
  }
});

test("edited scope returns to explicit approval and refreshes the creation warning", async (t) => {
  const f = fixture(t);
  let prompts = 0;
  let edits = 0;
  const ask = approvalUI(() => context(f.root, {
    select: async (title, options) => {
      prompts++;
      assert.deepEqual(options, directoryOptions);
      if (prompts === 1) {
        assert.ok(title.includes("On approval\nThe displayed directory will be created."));
        return "Edit directory scope";
      }
      assert.equal(edits, 1);
      assert.ok(title.includes(`Path       ${f.directory}`));
      assert.ok(title.includes(`Requested  ${path.join(f.directory, "missing")}`));
      assert.ok(!title.includes("will be created"));
      return "Remember for this project";
    },
    input: async (title, initial) => {
      edits++;
      assert.ok(title.startsWith("Directory to authorize\n\n"));
      assert.equal(initial, path.join(f.directory, "missing"));
      return "directory";
    },
  }));
  const answer = await ask({ ...f.request, path: path.join(f.directory, "missing"), create: true });
  assert.equal(prompts, 2);
  assert.equal(answer?.lifetime, "project");
  assert.equal(answer?.directory, f.directory);
  assert.deepEqual(answer?.binding, bindPath(f.directory));
});

test("repeated edits use the current scope and cancellation preserves it", async (t) => {
  const f = fixture(t);
  let prompts = 0;
  let edits = 0;
  const ask = approvalUI(() => context(f.root, {
    select: async (title) => {
      prompts++;
      assert.ok(title.includes(prompts === 1 ? f.directory : `Path       ${f.root}`));
      return prompts <= 3 ? "Edit directory scope" : "Allow for this session";
    },
    input: async (_title, initial) => {
      edits++;
      assert.equal(initial, edits === 1 ? f.directory : f.root);
      return edits === 1 ? "." : edits === 2 ? undefined : "";
    },
  }));
  const answer = await ask(f.request);
  assert.equal(prompts, 4);
  assert.equal(edits, 3);
  assert.equal(answer?.directory, f.root);
  assert.equal(answer?.lifetime, "session");
});

test("edited scope retains its identity from before the approval menu", async (t) => {
  const f = fixture(t);
  let prompts = 0;
  const ask = approvalUI(() => context(f.root, {
    select: async () => {
      if (++prompts === 1) return "Edit directory scope";
      renameSync(f.directory, `${f.directory}-old`);
      mkdirSync(f.directory);
      return "Allow for this session";
    },
    input: async () => f.directory,
  }));
  const answer = await ask(f.request);
  assert.ok(answer?.binding);
  assert.equal(revalidate(answer.binding), false);
});

test("exact-file approval offers global saving without widening the scope", async (t) => {
  const f = fixture(t);
  const ask = approvalUI(() => context(f.root, {
    select: async (title, options) => {
      assert.ok(title.startsWith("File access · Read/write\n\n"));
      assert.ok(title.includes("Scope   This file only"));
      assert.deepEqual(options, ["Allow for this session", "Remember for this project", "Save globally", "Deny and block for this session", "Deny"]);
      return "Save globally";
    },
  }));
  assert.deepEqual(await ask({ ...f.request, kind: "file" }), { action: "grant", lifetime: "global" });
});

test("path-rule exceptions keep one menu without scope editing", async (t) => {
  const f = fixture(t);
  let prompts = 0;
  const ask = approvalUI(() => context(f.root, {
    select: async (title, options) => {
      prompts++;
      assert.ok(title.startsWith("Path-rule exception · Read-only\n\n"));
      assert.ok(title.includes(`Path    ${f.directory}`));
      assert.ok(title.includes("This requires separate approval under a path rule."));
      assert.deepEqual(options, ["Allow for this session", "Remember for this project", "Deny and block for this session", "Deny"]);
      return "Allow for this session";
    },
  }));
  assert.deepEqual(await ask({ ...f.request, kind: "exception", scope: "tree", access: "read" }), { action: "grant", lifetime: "session" });
  assert.equal(prompts, 1);
});

test("explicit session blocking shows scope and denial semantics without selecting a lifetime", async (t) => {
  const f = fixture(t);
  for (const [kind, scope, access] of [["directory", "tree", "write"], ["file", "file", "read"], ["exception", "file", "write"], ["exception", "tree", "read"]] as const) {
    const ask = approvalUI(() => context(f.root, {
      select: async (title, options) => {
        assert.ok(options.includes("Deny and block for this session"));
        assert.ok(title.includes(`Scope   ${scope === "file" ? "This file only" : "Directory and all descendants"}`));
        assert.ok(title.includes(access === "read" ? "Blocking read access also blocks writes" : "Blocking write access does not block reads"));
        return "Deny and block for this session";
      },
    }));
    const answer = await ask({ ...f.request, kind, scope, access });
    assert.equal(answer?.action, "block");
    assert.equal(answer?.lifetime, undefined);
    assert.equal(answer?.binding?.canonical, kind === "directory" ? f.directory : undefined);
  }
});

test("edited blocking returns the binding explicitly displayed in the second menu", async (t) => {
  const f = fixture(t); let prompts = 0;
  const ask = approvalUI(() => context(f.root, {
    select: async (title) => {
      if (++prompts === 1) return "Edit directory scope";
      assert.ok(title.includes(`Path       ${f.root}`));
      return "Deny and block for this session";
    },
    input: async () => f.root,
  }));
  assert.deepEqual(await ask(f.request), { action: "block", directory: f.root, binding: bindPath(f.root) });
});

test("cancellation after choosing block never returns a block answer", async (t) => {
  const f = fixture(t); const controller = new AbortController();
  const ask = approvalUI(() => context(f.root, {
    select: async () => { controller.abort(); return "Deny and block for this session"; },
  }));
  await assert.rejects(ask(f.request, controller.signal), { name: "AbortError" });
});

test("cancellation during scope editing stops before another approval menu", async (t) => {
  const f = fixture(t);
  const controller = new AbortController();
  let prompts = 0;
  const ask = approvalUI(() => context(f.root, {
    select: async (_title, _options, options) => {
      prompts++;
      assert.equal(options?.signal, controller.signal);
      return "Edit directory scope";
    },
    input: async (_title, _initial, options) => {
      assert.equal(options?.signal, controller.signal);
      controller.abort();
      return f.root;
    },
  }));
  await assert.rejects(ask(f.request, controller.signal), { name: "AbortError" });
  assert.equal(prompts, 1);
});

test("parent shortcuts return to approval with the requested target and selected scope visible", async (t) => {
  const f = fixture(t);
  let prompts = 0;
  const ctx = { cwd: f.root, hasUI: true, ui: {
    select: async (title: string, options: string[]) => {
      prompts++;
      if (prompts === 1) return "Edit directory scope";
      if (prompts === 2) {
        assert.ok(title.startsWith("Choose directory scope"));
        assert.ok(options.includes(f.root));
        return f.root;
      }
      assert.ok(title.includes(`Path       ${f.root}\nRequested  ${f.directory}`));
      assert.deepEqual(options, directoryOptions);
      return "Allow for this session";
    },
  } } as unknown as ExtensionContext;
  assert.deepEqual(await approvalUI(() => ctx)(f.request), {
    action: "grant", lifetime: "session", directory: f.root, binding: bindPath(f.root),
  });
  assert.equal(prompts, 3);
});
