import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import test from "node:test";

// Two startup boundaries must stay cheap. index.ts (extension load) defers
// the runtime itself to the first shortcut press, and runtime.ts defers the
// native recorder, transcribe-cpp, and the TUI until they are actually used.
// Strip types from the TS source so type-only imports are erased, as at runtime.
// Dynamic import() calls never match the static `from`/`import "…"` pattern.
const NATIVE_OR_TUI = ["audio", "transcription", "visualizer", "file-audio"];
const BOUNDARIES: Record<string, string[]> = {
  index: ["runtime", ...NATIVE_OR_TUI],
  runtime: [...NATIVE_OR_TUI, "models"],
};

function staticImports(module: string): string[] {
  const source = stripTypeScriptTypes(readFileSync(new URL(`../src/${module}.ts`, import.meta.url), "utf8"));
  return [...source.matchAll(/(?:from|import) "\.\/([a-z.-]+)\.ts"/g)].map((match) => match[1]!);
}

function eagerGraph(root: string): Set<string> {
  const seen = new Set<string>();
  const queue = [root];
  for (let module = queue.shift(); module; module = queue.shift()) {
    if (seen.has(module)) continue;
    seen.add(module);
    queue.push(...staticImports(module));
  }
  return seen;
}

for (const [root, forbidden] of Object.entries(BOUNDARIES)) {
  test(`${root}.ts does not statically load deferred modules`, () => {
    const reachable = eagerGraph(root);
    for (const module of forbidden) {
      assert.equal(reachable.has(module), false, `${module}.ts is statically reachable from ${root}.ts`);
    }
  });
}
