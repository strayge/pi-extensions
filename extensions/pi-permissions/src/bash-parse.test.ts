import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { discoverShellAccess } from "./bash-parse.ts";

const cwd = "/workspace";
async function paths(command: string) {
  return (await discoverShellAccess(command, cwd)).map(({ path: file, access }) => `${access}:${file}`).sort();
}
function expected(read: string[] = [], write: string[] = []) {
  return [...read.map((p) => `read:${path.resolve(cwd, p)}`), ...write.map((p) => `write:${path.resolve(cwd, p)}`)].sort();
}

test("option values are not mistaken for operands and explicit option paths retain their access", async () => {
  const cases: [string, string[], string[]][] = [
    ["head -n 5 file; tail --bytes=10 other", ["file", "other"], []],
    ["cp -av -t dest source1 source2", ["source1", "source2"], ["dest"]],
    ["cp --target-directory=dest source; mv -- old new", ["source"], ["dest", "old", "new"]],
    ["install -m 755 -o user -g staff source dest", ["source"], ["dest"]],
    ["touch -t 202609241200 -r reference result; truncate -s 10 other", ["reference"], ["result", "other"]],
    ["mkdir -m 700 new; rm -- -named", [], ["new", "-named"]],
    ["grep -in -e pattern -f patterns file", ["patterns", "file"], []],
    ["rg -g '*.ts' --max-count 5 -- 'needle' src; rg --files directory", ["src", "directory"], []],
    [`sed ${process.platform === "darwin" ? "-i ''" : "-i"} -e 's/old/new/' file`, [], ["file"]],
    ["sed -i.bak -f script file", ["script"], ["file"]],
    ["node -e 'code'; python3 -c 'code'; node -- script.js argument", ["script.js"], []],
    ["cat -- -file", ["-file"], []],
  ];
  for (const [command, read, write] of cases) assert.deepEqual(await paths(command), expected(read, write), command);
  assert.deepEqual(await paths("head --unknown-option value file"), []);
  assert.deepEqual(await paths('cp "$dynamic" destination'), []);
});

test("descriptor duplication and heredoc bodies are not filesystem redirects", async () => {
  assert.deepEqual(await paths("cat <input 2>&1 3<&0 >output 4<>both &>>all"), expected(["input"], ["output", "both", "all"]));
  assert.deepEqual(await paths("cat <<EOF\nnot-a-path\nEOF\ncat <<<'not-a-path'"), []);
  assert.deepEqual(await paths("cat <<EOF\n$(cat nested)\nEOF"), expected(["nested"]));
  assert.deepEqual(await paths("cat <<'EOF'\n$(cat not-executed)\nEOF"), []);
  assert.deepEqual(await paths("cat >&output"), expected([], ["output"]));
  assert.deepEqual(await paths("cd next >before && cat after"), expected(["next", "next/after"], ["before"]));
});

test("conditional cd only changes the branch where success is known", async () => {
  assert.deepEqual(await paths("cd next && cat success"), expected(["next", "next/success"]));
  assert.deepEqual(await paths("cd next || cat failed"), expected(["next", "failed"]));
  assert.deepEqual(await paths("cd next; cat ambiguous; cat /absolute"), expected(["next", "/absolute"]));
  assert.deepEqual(await paths("cd one && cd two && cat file; cat ambiguous"), expected(["one", "one/two", "one/two/file"]));
  assert.deepEqual(await paths("if cd next; then cat yes; else cat no; fi; cat ambiguous"), expected(["next", "next/yes", "no"]));
  assert.deepEqual(await paths('cd "$dynamic" && cat ambiguous; cat /absolute'), expected(["/absolute"]));
  assert.deepEqual(await paths("cd -P symlink && cat uncertain"), expected(["symlink"]));
  assert.deepEqual(await paths("CDPATH=/elsewhere; cd relative && cat uncertain"), expected(["relative"]));
});

test("subshells and nested shell programs share local flow without leaking cwd outward", async () => {
  assert.deepEqual(await paths("(cd one && cat file); cat outside"), expected(["one", "one/file", "outside"]));
  assert.deepEqual(await paths("(cd one && (cd two && cat nested)); cat outside"), expected(["one", "one/two", "one/two/nested", "outside"]));
  assert.deepEqual(await paths("bash -c 'cd next && cat file'; cat outside"), expected(["next", "next/file", "outside"]));
  assert.deepEqual(await paths("cat $(cd next && cat file); cat outside"), expected(["next", "next/file", "outside"]));
  assert.deepEqual(await paths("cd next | cat input; cat outside"), expected(["next", "input", "outside"]));
  assert.deepEqual(await paths("cd next & cat outside"), expected(["next", "outside"]));
});

test("unexecuted function bodies and dynamic shell state do not invent reliable paths", async () => {
  assert.deepEqual(await paths("f() { cd next; cat never; }; cat before; f; cat uncertain; cat /absolute"), expected(["before", "/absolute"]));
  assert.deepEqual(await paths("source script; cat uncertain; cat /absolute"), expected(["/absolute"]));
  assert.deepEqual(await paths("cat 'literal*.txt' escaped\\?.txt; echo text >out; cat out"), expected(["literal*.txt", "escaped?.txt"], ["out"]));
});
