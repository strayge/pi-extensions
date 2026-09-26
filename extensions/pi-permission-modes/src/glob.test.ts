import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { compileGlob } from "./glob.ts";

const fd = "/home/user/.pi/agent/bin/fd";
test("public fd glob corpus agrees with native fd including Unicode byte semantics", { skip: !existsSync(fd) }, () => {
  const dir = mkdtempSync(path.join(tmpdir(), "permission-glob-"));
  const files = [
    "a",
    "b",
    "Case.TXT",
    "é",
    "é.txt",
    "😀",
    "a.txt",
    "dir/a.txt",
    "dir/deep/b.txt",
    "literal*.txt",
    "]",
    "foo/bar",
  ];
  try {
    for (const file of files) {
      mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
      writeFileSync(path.join(dir, file), "match");
    }
    for (const pattern of [
      "",
      "*",
      "?",
      "??",
      "*.txt",
      "[ab]",
      "[!a]",
      "[^a]",
      "[!]",
      "[^]",
      "[",
      "[]]",
      "{a,b}",
      "{a,{b,c}}",
      "literal\\*.txt",
      "dir/*.txt",
      "dir/**/*.txt",
      "**/*.txt",
      "{a,b}{a,b}",
      `${dir}/*.txt`,
    ]) {
      const full = pattern.includes("/");
      const effective = full && !pattern.startsWith("/") && !pattern.startsWith("**/") ? `**/${pattern}` : pattern;
      const native = spawnSync(
        fd,
        ["--glob", "--hidden", "--no-ignore", "--type", "f", ...(full ? ["--full-path"] : []), "--", effective, dir],
        { encoding: "utf8" },
      );
      let match: (candidate: string) => boolean;
      try {
        match = compileGlob(effective, "fd");
      } catch {
        assert.notEqual(native.status, 0, pattern);
        continue;
      }
      assert.equal(native.status, 0, `${pattern}: adapter accepted invalid native glob`);
      const expected = native.stdout
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((p) => path.relative(dir, p))
        .sort();
      const actual = files.filter((f) => match(full ? path.join(dir, f) : path.basename(f))).sort();
      assert.deepEqual(actual, expected, pattern);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("sequential alternatives do not expand combinations or ignore cancellation", () => {
  const signal = AbortSignal.abort();
  assert.throws(() => compileGlob("{a,b}".repeat(24), "fd", signal));
  const match = compileGlob("{a,aa}".repeat(30) + "b", "fd");
  assert.equal(match("a".repeat(60)), false);
  assert.equal(match("a".repeat(60) + "b"), true);
  for (const invalid of ["[!]", "[^]", "{a,{b,c}}", "["]) assert.throws(() => compileGlob(invalid, "rg"), invalid);
  assert.equal(compileGlob("*.txt", "rg")("Case.TXT"), false);
});
