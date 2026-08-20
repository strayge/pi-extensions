import assert from "node:assert/strict";
import test from "node:test";
import {
  analyzeBash,
  type BashCommand,
  classifyShellInvocation,
  expandShellCommands,
  extractCommands,
  isDynamicCommand,
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
const assignment = (name: string, value: SyntaxNodeLike) =>
  node("variable_assignment", `${name}=${value.text}`, [node("variable_name", name), node("=", "="), value]);
const program = (...kids: SyntaxNodeLike[]) => node("program", "", kids);

test("extractCommands: simple command name + args, not nested", () => {
  const cmds = extractCommands(program(cmd("git", "push", "origin")));
  assert.deepEqual(cmds, [{ name: "git", args: ["push", "origin"], isNested: false }]);
});

test("extractCommands: command-prefix and assignment-only values are preserved", () => {
  const prefixed = node("command", "PATH=./evil:$PATH git status", [
    assignment("PATH", node("concatenation", "./evil:$PATH", [word("./evil:"), node("simple_expansion", "$PATH")])),
    cmdName("git"),
    word("status"),
  ]);
  const only = assignment("DEST", word("../outside"));
  assert.deepEqual(extractCommands(program(prefixed, only)), [
    {
      name: "git",
      args: ["status"],
      assignments: [{ name: "PATH", source: "PATH=./evil:$PATH", value: "./evil:$PATH", dynamic: true }],
      isNested: false,
    },
    {
      name: "",
      args: [],
      assignments: [{ name: "DEST", source: "DEST=../outside", value: "../outside", dynamic: false }],
      isNested: false,
    },
  ]);
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

test("extractCommands: only the enclosing quote pair is stripped from args", () => {
  const simple = node("command", "echo 'hi'", [cmdName("echo"), node("string", "'hi'")]);
  assert.deepEqual(extractCommands(program(simple))[0].args, ["hi"]);

  const nested = node("command", `fish -c "echo x='a b'"`, [
    cmdName("fish"),
    node("string", `"echo x='a b'"`),
  ]);
  assert.deepEqual(extractCommands(program(nested))[0].args, ["echo x='a b'"]);
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
  assert.ok(isPrivilegeEscalation(bc("xargs", "--max-lines", "sudo", "id")));
  assert.ok(isPrivilegeEscalation(bc("xargs", "-l", "sudo", "id")));
  assert.ok(isPrivilegeEscalation(bc("nohup", "env", "sudo", "x"))); // wrappers chain
});

test("isPrivilegeEscalation: no false positives on mere mentions", () => {
  assert.ok(!isPrivilegeEscalation(bc("grep", "sudo", "file.txt"))); // grep is not a wrapper
  assert.ok(!isPrivilegeEscalation(bc("man", "sudo")));
  assert.ok(!isPrivilegeEscalation(bc("echo", "use sudo for that")));
  assert.ok(!isPrivilegeEscalation(bc("env", "ls", "-la"))); // wrapped command is benign
  assert.ok(!isPrivilegeEscalation(bc("env"))); // wrapper with nothing wrapped
  assert.ok(!isPrivilegeEscalation(bc("command", "-v", "sudo"))); // query mode does not execute sudo
});

const ok = (commands: BashCommand[]) => ({ commands, hasError: false });

test("wrapper parsing honors option operands and positional preludes", () => {
  const reviewed = [
    bc("env", "-u", "X", "bash", "-c", "sudo id"),
    bc("env", "--unset", "X", "sudo", "id"),
    bc("stdbuf", "-o", "L", "sudo", "id"),
    bc("timeout", "5s", "sudo", "id"),
    bc("xargs", "-I", "{}", "sudo", "id"),
    bc("xargs", "--max-lines", "sudo", "id"),
  ];
  for (const command of reviewed) {
    const expanded = expandShellCommands((script) => script === "sudo id" ? ok([bc("sudo", "id")]) : ok([]), [command]);
    assert.ok(expanded.commands.some((candidate) => candidate.name === "sudo"), command.args.join(" "));
    assert.equal(outsideReasonFromCommands(expanded.commands, "/p"), "privilege escalation");
  }
});

test("every supported wrapper accepts ordinary valid options without guessing", () => {
  const commands = [
    bc("env", "--unset=X", "printf"),
    bc("command", "-p", "printf"),
    bc("nice", "--adjustment=1", "printf"),
    bc("ionice", "--class=3", "printf"),
    bc("nohup", "--", "printf"),
    bc("setsid", "--fork", "printf"),
    bc("stdbuf", "--output=L", "printf"),
    bc("timeout", "--signal=TERM", "5s", "printf"),
    bc("time", "--format=%e", "printf"),
    bc("xargs", "--replace={}", "printf"),
    bc("xargs", "--max-lines=2", "printf"),
    bc("xargs", "--max-args=2", "printf"),
    bc("xargs", "--max-procs=2", "printf"),
    bc("xargs", "-l2", "printf"),
    bc("xargs", "-L2", "printf"),
    bc("xargs", "-n2", "printf"),
    bc("xargs", "-P2", "printf"),
    bc("exec", "-a", "display-name", "printf"),
    bc("builtin", "--", "printf"),
  ];
  for (const command of commands) {
    const expanded = expandShellCommands(() => ok([]), [command]);
    assert.equal(expanded.commands.at(-1)?.name, "printf", command.name);
    assert.equal(isDynamicCommand(command), false, command.name);
  }
});

test("ambiguous wrapper forms fail closed instead of treating an operand as executable", () => {
  for (const command of [
    bc("env", "--unknown", "sudo", "id"),
    bc("env", "-S", "sudo id"),
    bc("stdbuf", "--output"),
    bc("timeout", "--signal"),
    bc("xargs", "--max-args"),
    bc("exec", "-a"),
  ]) {
    assert.equal(isDynamicCommand(command), true, command.args.join(" "));
  }
});


test("wrapper resolution has no fixed hop limit because argv strictly shortens", () => {
  const wrappers = Array.from({ length: 12 }, () => "env");
  const command = bc(wrappers.shift()!, ...wrappers, "sudo", "id");
  const expanded = expandShellCommands(() => ok([]), [command]);
  assert.equal(expanded.commands.at(-1)?.name, "sudo");
  assert.equal(isDynamicCommand(command), false);
  assert.equal(outsideReasonFromCommands(expanded.commands, "/p"), "privilege escalation");
});

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

  // Script files are uninspectable and are not confused with command strings.
  assert.equal(expandShellCommands(parse, [bc("bash", "script.sh")]).commands.length, 1);
  const beforeNorc = parses.length;
  assert.equal(expandShellCommands(parse, [bc("bash", "--norc", "sudo rm -rf /")]).commands.length, 1);
  assert.equal(parses.length, beforeNorc, "--norc must not be mistaken for a -c option group");
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
  assert.equal(bounded.hasError, true, "commands beyond the recursion bound must fail closed");
});

test("shell invocation classification unwraps commands and distinguishes command options", () => {
  const dynamic = (name: string, args: string[], dynamicArgs: boolean[]): BashCommand => ({
    name,
    args,
    isNested: false,
    dynamicArgs,
  });

  assert.deepEqual(classifyShellInvocation(bc("bash", "-lc", "echo safe")), {
    command: bc("bash", "-lc", "echo safe"),
    interpreter: "bash",
    kind: "command-string",
    script: "echo safe",
    inspectable: true,
  });
  assert.equal(classifyShellInvocation(bc("bash", "--norc", "script.sh"))?.kind, "script-file");
  assert.equal(classifyShellInvocation(bc("fish", "--command", "echo safe"))?.inspectable, true);
  assert.equal(classifyShellInvocation(bc("env", "sh", "-c", "echo safe"))?.kind, "command-string");

  assert.ok(isDynamicCommand(dynamic("bash", ["$script"], [true])));
  assert.ok(isDynamicCommand(dynamic("source", ["$script"], [true])));
  assert.ok(isDynamicCommand(dynamic(".", ["$script"], [true])));
  assert.ok(isDynamicCommand(dynamic("env", ["sh", "-c", "$code"], [false, false, true])));
  assert.ok(isDynamicCommand(bc("bash", "--norc", "script.sh")), "literal script files are still uninspectable");
  assert.ok(!isDynamicCommand(bc("env", "sh", "-lc", "echo safe")));
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

test("expandShellCommands: fish initialization commands execute before and are analyzed with -c", () => {
  const parse = (script: string) => {
    if (script === "sudo id") return ok([bc("sudo", "id")]);
    if (script === "echo safe") return ok([bc("echo", "safe")]);
    return ok([]);
  };
  for (const command of [
    bc("fish", "-C", "sudo id", "-c", "echo safe"),
    bc("fish", "--init-command", "sudo id", "-c", "echo safe"),
  ]) {
    const out = expandShellCommands(parse, [command]);
    assert.deepEqual(out.commands.map((candidate) => candidate.name), ["fish", "sudo", "echo"]);
    assert.equal(outsideReasonFromCommands(out.commands, "/p"), "privilege escalation");
    assert.equal(isDynamicCommand(command), false);
  }
});

test("shell initialization files and dynamic fish init commands are non-grantable", () => {
  for (const command of [
    bc("bash", "--rcfile", "scripts/evil", "-ic", "echo safe"),
    bc("bash", "--init-file=scripts/evil", "-ic", "echo safe"),
    { ...bc("fish", "-C", "$init", "-c", "echo safe"), dynamicArgs: [false, true, false, false] },
    { ...bc("fish", "--init-command", "$init", "-c", "echo safe"), dynamicArgs: [false, true, false, false] },
  ]) {
    assert.equal(isDynamicCommand(command), true, command.args.join(" "));
    assert.equal(expandShellCommands(() => ok([]), [command]).commands.length, 1);
  }
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

test("analyzeBash: prefix assignments are dynamic and path-visible without hiding the effective command", async () => {
  for (const source of [
    "PATH=./evil:$PATH git status",
    "BASH_ENV=./evil bash -c ':'",
    "ENV=./evil sh -c ':'",
    "VALUE=$dynamic git status",
    "ONLY=literal",
    "PATH=./evil env sh -c 'echo safe'",
  ]) {
    const analysis = await analyzeBash(source, "/home/u/proj");
    if (analysis.usedFallback) return;
    assert.equal(analysis.dynamic, true, source);
    assert.ok(analysis.commands.some((command) => command.assignments?.length), source);
  }

  const outside = await analyzeBash("DEST=../secret git status", "/home/u/proj");
  assert.match(outside.outsideReason ?? "", /path outside project: \.\.\/secret/);
  assert.ok(outside.commands.some((command) => command.name === "git"), "effective command remains policy-visible");

  const nested = await analyzeBash("PATH=./evil env sh -c 'sudo id'", "/home/u/proj");
  assert.equal(nested.outsideReason, "privilege escalation");
  assert.ok(nested.commands.some((command) => command.name === "sudo"));
});

test("analyzeBash: dynamic interpreters are non-grantable while literal shell scripts are understood", async () => {
  const variableHead = await analyzeBash("$command --flag", "/home/u/projX");
  if (variableHead.usedFallback) return;
  assert.equal(variableHead.dynamic, true);

  const evaluated = await analyzeBash("eval 'echo safe'", "/home/u/projX");
  assert.equal(evaluated.dynamic, true);

  for (const command of [
    `script="echo safe"; sh -c "$script"`,
    `bash "$script"`,
    `source "$script"`,
    `. "$script"`,
    `env sh -c "$code"`,
    "bash --norc script.sh",
  ]) {
    const analysis = await analyzeBash(command, "/home/u/projX");
    assert.equal(analysis.dynamic, true, command);
  }

  for (const literal of ["sh -c 'echo safe'", `bash -c "echo safe"`, "env sh -lc 'echo safe'"]) {
    const analysis = await analyzeBash(literal, "/home/u/projX");
    assert.equal(analysis.dynamic, false, literal);
    assert.ok(analysis.commands.some((command) => command.name === "echo" && command.isNested), literal);
  }
});

test("analyzeBash: attached fish command values are literally decoded before recursive parsing", async () => {
  const forms = [
    "fish -C'rm *' -c 'echo safe'",
    "fish --init-command='rm *' -c 'echo safe'",
    "fish --init-command-exit='rm *' -c 'echo safe'",
    "fish --command='rm *'",
  ];
  for (const form of forms) {
    const analysis = await analyzeBash(form, "/home/u/proj");
    if (analysis.usedFallback) return;
    assert.ok(
      analysis.commands.some((command) => command.name === "rm" && command.args[0] === "*"),
      form,
    );
    assert.equal(analysis.dynamic, false, form);
  }

  for (const form of [
    "fish -C'cat ../secret' -c 'echo safe'",
    "fish --init-command='cat ../secret' -c 'echo safe'",
    "fish --init-command-exit='cat ../secret' -c 'echo safe'",
    "fish --command='cat ../secret'",
  ]) {
    const analysis = await analyzeBash(form, "/home/u/proj");
    if (analysis.usedFallback) return;
    assert.match(analysis.outsideReason ?? "", /path outside project: \.\.\/secret/, form);
  }
});

test("analyzeBash: attached dynamic fish values remain non-grantable", async () => {
  for (const form of [
    "fish -C$init -c 'echo safe'",
    "fish --init-command=$init -c 'echo safe'",
    "fish --init-command-exit=$init -c 'echo safe'",
    "fish --command=$code",
    "fish --command=$'echo safe'",
  ]) {
    const analysis = await analyzeBash(form, "/home/u/proj");
    if (analysis.usedFallback) return;
    assert.equal(analysis.dynamic, true, form);
  }
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

  const nestedQuotes = await analyzeBash(
    `fish -i -c "npm test -- --test-name-pattern='patched sandbox runtime'"`,
    "/home/u/projX",
  );
  assert.equal(nestedQuotes.unparsed, false, "inner quotes at the end of a double-quoted script must be preserved");
  assert.deepEqual(
    nestedQuotes.commands.map((c) => c.name),
    ["fish", "npm"],
  );
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
    `arr=(1 2 3); echo \${arr[@]}`,
    "find . -name '*.ts' -exec grep -l x {} \\;",
    "pytest -k 'not slow' --maxfail=1",
  ]) {
    const a = await analyzeBash(command, "/home/u/projX");
    if (a.usedFallback) return;
    assert.equal(a.unparsed, false, `valid bash must not be flagged: ${command}`);
  }
});
