import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ApprovalRequest } from "./approvals.ts";
import { approvalUI } from "./file-approval.ts";
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
  return { cwd, hasUI: true, ui } as ExtensionContext;
}

const directoryOptions = ["Allow for this session", "Remember for this project", "Save globally", "Edit directory scope", "Deny"];

test("directory approval chooses scope and lifetime in one menu", async (t) => {
  const f = fixture(t);
  for (const [choice, lifetime] of [["Allow for this session", "session"], ["Remember for this project", "project"], ["Save globally", "global"]]) {
    let prompts = 0;
    const ask = approvalUI(() => context(f.root, {
      select: async (title, options) => {
        prompts++;
        assert.deepEqual(options, directoryOptions);
        assert.ok(title.includes(`R/W ${f.directory}`));
        assert.ok(title.includes(f.request.reason));
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
        assert.ok(title.includes("The approved directory will be created."));
        return "Edit directory scope";
      }
      assert.equal(edits, 1);
      assert.ok(title.includes(`R/W ${f.directory}`));
      assert.ok(!title.includes("will be created"));
      return "Remember for this project";
    },
    input: async (title, initial) => {
      edits++;
      assert.equal(title, "Directory scope");
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
      assert.ok(title.includes(prompts === 1 ? f.directory : `R/W ${f.root}`));
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
      assert.ok(title.includes("Exact-file grant"));
      assert.deepEqual(options, ["Allow for this session", "Remember for this project", "Save globally", "Deny"]);
      return "Save globally";
    },
  }));
  assert.deepEqual(await ask({ ...f.request, kind: "file" }), { lifetime: "global" });
});

test("path-rule exceptions keep one menu without scope editing", async (t) => {
  const f = fixture(t);
  let prompts = 0;
  const ask = approvalUI(() => context(f.root, {
    select: async (title, options) => {
      prompts++;
      assert.ok(title.includes(`Separate path-rule exception: R/O ${f.directory}`));
      assert.deepEqual(options, ["Allow for this session", "Remember for this project", "Deny"]);
      return "Allow for this session";
    },
  }));
  assert.deepEqual(await ask({ ...f.request, kind: "exception", access: "read" }), { lifetime: "session" });
  assert.equal(prompts, 1);
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
