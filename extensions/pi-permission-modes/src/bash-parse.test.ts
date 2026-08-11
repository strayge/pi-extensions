import assert from "node:assert/strict";
import test from "node:test";
import {
  analyzeBash,
  type BashCommand,
  expandShellCommands,
  extractCommands,
  isPrivilegeEscalation,
  outsideReasonFromCommands,
  splitFishConnectives,
  type SyntaxNodeLike,
} from "./bash-parse.ts";

// --- fake CST builders (mirror the tree-sitter-bash grammar shape) ----------
const node = (type: string, text: string, children: SyntaxNodeLike[] = []): SyntaxNodeLike => ({ type, text, children });
const word = (t: string) => node("word", t);
const cmdName = (t: string) => node("command_name", t, [word(t)]);
const cmd = (name: string, ...args: string[]) =>
  node("command", [name, ...args].join(" "), [cmdName(name), ...args.map(word)]);
const program = (...kids: SyntaxNodeLike[]) => node("program", "", kids);

test("extractCommands: simple command name + args, not nested", () => {
  const cmds = extractCommands(program(cmd("git", "push", "origin")));
  assert.deepEqual(cmds, [{ name: "git", args: ["push", "origin"], isNested: false }]);
});

test("extractCommands: command nested in $(...) is marked nested", () => {
  // echo $(sudo rm -rf /etc)
  const echo = node("command", "echo $(...)", [
    cmdName("echo"),
    node("command_substitution", "$(...)", [cmd("sudo", "rm", "-rf", "/etc")]),
  ]);
  const cmds = extractCommands(program(echo));
  assert.equal(cmds.length, 2);
  assert.deepEqual(cmds[0], { name: "echo", args: [], isNested: false });
  assert.deepEqual(cmds[1], { name: "sudo", args: ["rm", "-rf", "/etc"], isNested: true });
});

test("extractCommands: commands in a subshell are nested", () => {
  const sub = node("subshell", "(...)", [cmd("cd", "/tmp"), cmd("ls")]);
  const cmds = extractCommands(program(sub));
  assert.deepEqual(
    cmds.map((c) => [c.name, c.isNested]),
    [
      ["cd", true],
      ["ls", true],
    ],
  );
});

test("extractCommands: quotes are stripped from args", () => {
  const c = node("command", "echo 'hi'", [cmdName("echo"), node("string", "'hi'")]);
  assert.deepEqual(extractCommands(program(c))[0].args, ["hi"]);
});

test("outsideReasonFromCommands: privilege escalation by command name", () => {
  assert.equal(outsideReasonFromCommands([{ name: "sudo", args: ["apt"], isNested: false }], "/p"), "privilege escalation");
  // even nested (the extractor already flattened it)
  assert.equal(outsideReasonFromCommands([{ name: "doas", args: [], isNested: true }], "/p"), "privilege escalation");
});

test("outsideReasonFromCommands: out-of-project path argument", () => {
  const root = "/home/u/proj";
  assert.match(
    outsideReasonFromCommands([{ name: "cat", args: ["../secret.txt"], isNested: false }], root) ?? "",
    /path outside project: \.\.\/secret\.txt/,
  );
  assert.equal(outsideReasonFromCommands([{ name: "cat", args: ["src/app.ts"], isNested: false }], root), undefined);
});

test("outsideReasonFromCommands: /dev/null is allowed", () => {
  assert.equal(outsideReasonFromCommands([{ name: "echo", args: [], isNested: false }], "/p"), undefined);
  assert.equal(
    outsideReasonFromCommands([{ name: "cat", args: ["/dev/null"], isNested: false }], "/home/u/proj"),
    undefined,
  );
});

const bc = (name: string, ...args: string[]): BashCommand => ({ name, args, isNested: false });

test("isPrivilegeEscalation: direct and through wrapper commands", () => {
  assert.ok(isPrivilegeEscalation(bc("sudo", "apt", "install")));
  assert.ok(isPrivilegeEscalation(bc("/usr/bin/sudo", "x")));
  assert.ok(isPrivilegeEscalation(bc("env", "sudo", "rm")));
  assert.ok(isPrivilegeEscalation(bc("env", "PATH=/x", "sudo", "rm"))); // skips assignments
  assert.ok(isPrivilegeEscalation(bc("nice", "-n", "10", "sudo", "x"))); // skips flags + numbers
  assert.ok(isPrivilegeEscalation(bc("timeout", "5", "doas", "x")));
  assert.ok(isPrivilegeEscalation(bc("xargs", "-0", "sudo", "rm")));
  assert.ok(isPrivilegeEscalation(bc("nohup", "env", "sudo", "x"))); // wrappers chain
});

test("isPrivilegeEscalation: no false positives on mere mentions", () => {
  assert.ok(!isPrivilegeEscalation(bc("grep", "sudo", "file.txt"))); // grep is not a wrapper
  assert.ok(!isPrivilegeEscalation(bc("man", "sudo")));
  assert.ok(!isPrivilegeEscalation(bc("echo", "use sudo for that")));
  assert.ok(!isPrivilegeEscalation(bc("env", "ls", "-la"))); // wrapped command is benign
  assert.ok(!isPrivilegeEscalation(bc("env"))); // wrapper with nothing wrapped
});

const ok = (commands: BashCommand[]) => ({ commands, hasError: false });

test("expandShellCommands: bash -c scripts are re-parsed, recursively and depth-limited", () => {
  const parses: string[] = [];
  const parse = (s: string) => {
    parses.push(s);
    if (s === "sudo rm -rf /") return ok([bc("sudo", "rm", "-rf", "/")]);
    if (s === "bash -c 'sudo x'") return ok([bc("bash", "-c", "sudo x")]);
    if (s === "sudo x") return ok([bc("sudo", "x")]);
    return ok([]);
  };

  // Simple: the inner command joins the list, marked nested.
  const simple = expandShellCommands(parse, [bc("bash", "-c", "sudo rm -rf /")]);
  assert.deepEqual(
    simple.commands.map((c) => [c.name, c.isNested]),
    [
      ["bash", false],
      ["sudo", true],
    ],
  );

  // Combined flags (`sh -lc`) and absolute shell paths count too.
  assert.equal(expandShellCommands(parse, [bc("sh", "-lc", "sudo rm -rf /")]).commands.length, 2);
  assert.equal(expandShellCommands(parse, [bc("/bin/bash", "-c", "sudo rm -rf /")]).commands.length, 2);

  // No -c → a script file we can't inspect; nothing is expanded.
  assert.equal(expandShellCommands(parse, [bc("bash", "script.sh")]).commands.length, 1);
  // Non-shell commands are never expanded.
  assert.equal(expandShellCommands(parse, [bc("git", "-c", "user.name=x", "log")]).commands.length, 1);

  // Nested shells expand recursively: bash -c "bash -c 'sudo x'".
  const nested = expandShellCommands(parse, [bc("bash", "-c", "bash -c 'sudo x'")]);
  assert.deepEqual(
    nested.commands.map((c) => c.name),
    ["bash", "bash", "sudo"],
  );

  // Depth limit: self-referential scripts stop expanding instead of looping.
  const loop = (s: string) => (s === "loop" ? ok([bc("bash", "-c", "loop")]) : ok([]));
  const bounded = expandShellCommands(loop, [bc("bash", "-c", "loop")]);
  assert.ok(bounded.commands.length <= 4);
});

test("expandShellCommands: fish -c scripts expand like any other shell", () => {
  const parse = (s: string) =>
    s === "cd sub && pytest -k t" ? ok([bc("cd", "sub"), bc("pytest", "-k", "t")]) : ok([]);
  const out = expandShellCommands(parse, [bc("fish", "-i", "-c", "cd sub && pytest -k t")]);
  assert.deepEqual(
    out.commands.map((c) => [c.name, c.isNested]),
    [
      ["fish", false],
      ["cd", true],
      ["pytest", true],
    ],
  );
  assert.equal(out.hasError, false);
});

test("expandShellCommands: fish connectives are unwrapped so the real head is judged", () => {
  // The bash grammar reads `and sudo id` as a command named "and".
  const parse = (s: string) => (s === "echo hi; and sudo id" ? ok([bc("echo", "hi"), bc("and", "sudo", "id")]) : ok([]));
  const out = expandShellCommands(parse, [bc("fish", "-c", "echo hi; and sudo id")]);
  assert.deepEqual(
    out.commands.map((c) => c.name),
    ["fish", "echo", "sudo"],
  );
  // ...and only for fish: a POSIX shell has no such modifier, so `and` stands.
  const posix = expandShellCommands(parse, [bc("bash", "-c", "echo hi; and sudo id")]);
  assert.deepEqual(
    posix.commands.map((c) => c.name),
    ["bash", "echo", "and"],
  );
});

test("splitFishConnectives: unwraps and/or/not, bounded, leaves other commands alone", () => {
  assert.deepEqual(splitFishConnectives([bc("or", "sudo", "id")]), [
    { name: "sudo", args: ["id"], isNested: false },
  ]);
  assert.deepEqual(splitFishConnectives([bc("not", "and", "sudo", "id")]), [
    { name: "sudo", args: ["id"], isNested: false },
  ]);
  // Nothing to modify → left alone, so a real command named `and` still matches.
  assert.deepEqual(splitFishConnectives([bc("and")]), [bc("and")]);
  assert.deepEqual(splitFishConnectives([bc("git", "status")]), [bc("git", "status")]);
});

test("expandShellCommands: an unparsable inner script is reported, not silently dropped", () => {
  // What the bash grammar does with fish's `for … end`: no commands, an error.
  const parse = () => ({ commands: [] as BashCommand[], hasError: true });
  const out = expandShellCommands(parse, [bc("fish", "-c", "for f in *.py; sudo id; end")]);
  assert.equal(out.hasError, true, "the caller must be able to fail closed");
  assert.deepEqual(
    out.commands.map((c) => c.name),
    ["fish"],
  );

  const throws = () => {
    throw new Error("boom");
  };
  assert.equal(expandShellCommands(throws, [bc("fish", "-c", "x")]).hasError, true);
});

test("outsideReasonFromCommands: wrapped privilege escalation is reported", () => {
  assert.equal(outsideReasonFromCommands([bc("env", "sudo", "rm")], "/p"), "privilege escalation");
  assert.equal(outsideReasonFromCommands([bc("grep", "sudo", "x.txt")], "/p"), undefined);
});

test("analyzeBash: real grammar detects nested privilege + escape (skips if WASM absent)", async () => {
  const a = await analyzeBash("echo $(sudo rm -rf /etc) && cat ../x", "/home/u/projX");
  if (a.usedFallback) return; // tree-sitter WASM unavailable in this env — heuristic path
  assert.ok(a.commands.some((c) => c.name === "sudo" && c.isNested), "nested sudo extracted");
  assert.ok(a.outsideReason, "an escape/privilege reason is reported");
});

test("analyzeBash: real grammar sees through wrappers and shell -c (skips if WASM absent)", async () => {
  const wrapped = await analyzeBash("env PATH=/x sudo rm -rf /", "/home/u/projX");
  if (wrapped.usedFallback) return; // tree-sitter WASM unavailable in this env
  assert.equal(wrapped.outsideReason, "privilege escalation");

  const shellC = await analyzeBash("bash -c 'sudo rm -rf /etc'", "/home/u/projX");
  assert.equal(shellC.outsideReason, "privilege escalation");
  assert.ok(shellC.commands.some((c) => c.name === "sudo" && c.isNested), "inner sudo extracted from -c script");

  // The inner script's path args are policy-visible too.
  const shellPath = await analyzeBash("sh -c 'cat /etc/passwd'", "/home/u/projX");
  assert.match(shellPath.outsideReason ?? "", /path outside project/);

  // A benign mention is not privilege escalation in the AST path.
  const benign = await analyzeBash("grep sudo README.md", "/home/u/projX");
  assert.equal(benign.outsideReason, undefined);
});

test("analyzeBash: fish -c inner commands are extracted (skips if WASM absent)", async () => {
  const a = await analyzeBash("fish -i -c 'cd subdir && pytest -k testname'", "/home/u/projX");
  if (a.usedFallback) return; // tree-sitter WASM unavailable in this env
  assert.deepEqual(
    a.commands.map((c) => c.name),
    ["fish", "cd", "pytest"],
    "the wrapped commands are visible to policy, not buried in an argument",
  );
  assert.equal(a.unparsed, false, "bash-compatible fish parses cleanly");
  assert.equal(a.outsideReason, undefined);
});

test("analyzeBash: fish syntax the bash grammar cannot read is flagged (skips if WASM absent)", async () => {
  // `switch` is the reason a zero-command check is not enough: it still yields
  // its head, so only the error nodes reveal that `sudo` went missing.
  for (const script of ["for f in *.py; sudo id; end", "switch $x; case a; sudo id; end"]) {
    const a = await analyzeBash(`fish -i -c '${script}'`, "/home/u/projX");
    if (a.usedFallback) return;
    assert.equal(a.unparsed, true, `unparsed must be set for: ${script}`);
    assert.ok(!a.commands.some((c) => c.name === "sudo"), "the hidden command is indeed not extracted");
  }
});

test("analyzeBash: fish connectives expose the escalated command (skips if WASM absent)", async () => {
  const a = await analyzeBash("fish -i -c 'echo hi; and sudo id'", "/home/u/projX");
  if (a.usedFallback) return;
  assert.ok(
    a.commands.some((c) => c.name === "sudo"),
    "`and sudo id` must not hide sudo inside the args of a command named `and`",
  );
  assert.equal(a.outsideReason, "privilege escalation");
});

test("analyzeBash: ordinary bash keeps parsing cleanly (skips if WASM absent)", async () => {
  // Guards against the unparsed flag turning into constant prompting.
  for (const command of [
    "cat <<'EOF'\nhi\nEOF",
    "diff <(ls a) <(ls b)",
    "for f in *.py; do echo $f; done",
    "arr=(1 2 3); echo ${arr[@]}",
    "find . -name '*.ts' -exec grep -l x {} \\;",
    "pytest -k 'not slow' --maxfail=1",
  ]) {
    const a = await analyzeBash(command, "/home/u/projX");
    if (a.usedFallback) return;
    assert.equal(a.unparsed, false, `valid bash must not be flagged: ${command}`);
  }
});
