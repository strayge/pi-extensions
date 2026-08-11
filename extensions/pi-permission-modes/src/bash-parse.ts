/**
 * Bash command analysis via tree-sitter (real AST), with a regex fallback.
 *
 * Replaces the foolable token scan for the common case: `extractCommands` walks
 * the tree-sitter-bash CST into the list of commands in a line — including those
 * nested in `$(...)`, backticks, and subshells — so privilege escalation and
 * out-of-project path arguments are detected even when hidden inside
 * substitutions. Shell `-c` scripts (`bash -c '…'`) are re-parsed recursively so
 * their inner commands are seen too, and privilege escalation is detected
 * through wrapper commands (`env sudo …`, `nice -n 10 sudo …`). When the WASM
 * grammar can't be loaded, `analyzeBash` degrades to the original
 * `bashConfirmReason` heuristic (heuristics.ts), so behavior is never worse
 * than before.
 *
 * `extractCommands` is pure and works over a minimal node shape, so it's
 * unit-tested with hand-built trees (no WASM); only the lazy parser init touches
 * the runtime.
 */

import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { bashConfirmReason, PRIVILEGE_RE } from "./heuristics.ts";
import { isOutside, SAFE_OUTSIDE_RE } from "./paths.ts";

/** One command extracted from a bash line. */
export interface BashCommand {
  /** Command head, e.g. "git", "sudo", "cat". */
  name: string;
  /** Remaining tokens (args), quotes stripped. */
  args: string[];
  /** True when the command sits inside `$(...)`, backticks, or a subshell. */
  isNested: boolean;
}

/** Minimal structural view of a tree-sitter node (real SyntaxNode satisfies it). */
export interface SyntaxNodeLike {
  type: string;
  text: string;
  children: SyntaxNodeLike[];
}

/** Node types that introduce a nested execution context. */
const NESTING = new Set(["command_substitution", "subshell", "process_substitution"]);
/** Child node types treated as command arguments. */
const ARG_TYPES = new Set([
  "word",
  "string",
  "raw_string",
  "ansi_c_string",
  "concatenation",
  "number",
  "simple_expansion",
  "expansion",
]);

function stripQuotes(s: string): string {
  if (s.length < 2) return s;
  const first = s[0];
  const last = s[s.length - 1];
  if ((first === "'" || first === '"') && last === first) return s.slice(1, -1);
  if (s.startsWith("$'") && last === "'") return s.slice(2, -1);
  return s;
}

function parseCommand(node: SyntaxNodeLike, isNested: boolean): BashCommand {
  let name = "";
  const args: string[] = [];
  for (const child of node.children ?? []) {
    if (child.type === "command_name") {
      if (!name) name = child.text.trim();
    } else if (ARG_TYPES.has(child.type)) {
      args.push(stripQuotes(child.text));
    }
  }
  return { name, args, isNested };
}

/** Walk a CST (or fake tree) into the list of commands, marking nested ones. */
export function extractCommands(root: SyntaxNodeLike): BashCommand[] {
  const out: BashCommand[] = [];
  const walk = (node: SyntaxNodeLike, nested: boolean) => {
    const inNest = nested || NESTING.has(node.type);
    if (node.type === "command") out.push(parseCommand(node, inNest));
    for (const c of node.children ?? []) walk(c, inNest);
  };
  walk(root, false);
  return out;
}

/**
 * Command heads that run their argument list as another command, so privilege
 * escalation can hide one level down (`env sudo …`, `nice -n 10 sudo …`,
 * `xargs sudo …`). Shells with `-c` are handled separately (the script is a
 * string needing a re-parse — see `expandShellCommands`).
 */
const WRAPPER_COMMANDS = new Set([
  "env",
  "command",
  "nice",
  "ionice",
  "nohup",
  "setsid",
  "stdbuf",
  "timeout",
  "time",
  "xargs",
  "exec",
  "builtin",
]);

/** Wrapper arguments to skip when looking for the wrapped command: flags
 * (`-n`, `--`), VAR=value assignments (env), and bare numbers (timeout 5,
 * nice -n 10). */
const SKIPPABLE_WRAPPER_ARG = /^(-|\w+=|\d+$)/;

/**
 * True when the command escalates privileges — directly (`sudo …`) or through
 * known wrapper commands (`env PATH=/x sudo …`, `nice -n 10 doas …`): each
 * wrapper is unwrapped (skipping its flags/assignments/numeric args) and every
 * effective command head is tested. Bounded, so a pathological chain of
 * wrappers can't loop.
 */
export function isPrivilegeEscalation(c: BashCommand): boolean {
  let head = c.name;
  let rest = c.args;
  for (let hops = 0; hops < 8; hops++) {
    if (PRIVILEGE_RE.test(path.basename(head))) return true;
    if (!WRAPPER_COMMANDS.has(path.basename(head))) return false;
    const idx = rest.findIndex((a) => !SKIPPABLE_WRAPPER_ARG.test(a));
    if (idx === -1) return false;
    head = rest[idx];
    rest = rest.slice(idx + 1);
  }
  return false;
}

/** Shells whose `-c <script>` argument is itself a shell program. */
const SHELL_COMMANDS = new Set(["sh", "bash", "zsh", "dash", "ksh", "fish"]);

/** Shells the bash grammar only approximates; POSIX-ish ones it reads directly. */
const NON_POSIX_SHELLS = new Set(["fish"]);

const FISH_CONNECTIVES = new Set(["and", "or", "not", "!"]);

/** One parsed script, plus whether the grammar hit error nodes. */
export interface ParsedScript {
  commands: BashCommand[];
  hasError: boolean;
}

/**
 * Replace fish's `and`/`or`/`not` modifiers with the command they modify. The
 * bash grammar has no notion of them, so it reads `and sudo id` as a command
 * named `and` taking `sudo id` as arguments — hiding the real head from both
 * privilege detection and policy patterns. Bounded, so `not not not …` cannot
 * loop; a modifier with nothing after it is left alone.
 */
export function splitFishConnectives(commands: BashCommand[]): BashCommand[] {
  const out: BashCommand[] = [];
  for (const c of commands) {
    let cur = c;
    for (let hops = 0; hops < 4 && FISH_CONNECTIVES.has(path.basename(cur.name)) && cur.args.length > 0; hops++) {
      cur = { name: cur.args[0], args: cur.args.slice(1), isNested: cur.isNested };
    }
    out.push(cur);
  }
  return out;
}

/** The `-c` script of a shell command (`bash -c '…'`, `sh -lc '…'`, `fish -i -c '…'`)
 * together with the shell that runs it, or undefined when the command isn't a
 * shell or has no `-c` script. */
function shellCScript(c: BashCommand): { script: string; shell: string } | undefined {
  const shell = path.basename(c.name);
  if (!SHELL_COMMANDS.has(shell)) return undefined;
  let sawC = false;
  for (const a of c.args) {
    if (a.startsWith("-")) {
      if (a.includes("c")) sawC = true;
      continue;
    }
    // First non-flag arg: the script when -c was given, else a script file
    // path (which we can't inspect — the path itself is still policy-matched).
    return sawC ? { script: a, shell } : undefined;
  }
  return undefined;
}

/**
 * Expand `sh|bash|… -c '<script>'` commands by re-parsing the script and
 * appending its commands (marked nested), recursively and depth-limited — so
 * privilege, path-escape, and policy matching all see what the inner shell
 * would run. `parse` is injected (the tree-sitter parser in production, a fake
 * in tests); a script that fails to parse expands to nothing.
 */
export function expandShellCommands(
  parse: (script: string) => ParsedScript,
  commands: BashCommand[],
  depth = 0,
): ParsedScript {
  if (depth >= 3) return { commands, hasError: false };
  const out: BashCommand[] = [];
  let hasError = false;
  for (const c of commands) {
    out.push(c);
    const found = shellCScript(c);
    if (!found) continue;
    let inner: BashCommand[] = [];
    try {
      const parsed = parse(found.script);
      // Propagated, not swallowed: an unreadable script would otherwise leave
      // only the innocuous-looking outer `fish -c` for policy to judge.
      hasError ||= parsed.hasError;
      inner = parsed.commands.map((i) => ({ ...i, isNested: true }));
      if (NON_POSIX_SHELLS.has(found.shell)) inner = splitFishConnectives(inner);
    } catch {
      // unparsable inner script → nothing to expand; the shell command itself
      // was already emitted and stays subject to policy
      hasError = true;
    }
    const expanded = expandShellCommands(parse, inner, depth + 1);
    hasError ||= expanded.hasError;
    out.push(...expanded.commands);
  }
  return { commands: out, hasError };
}

/**
 * Reason to prompt (escape / privilege) derived from extracted commands — the
 * AST-based equivalent of `bashConfirmReason`, but it also sees commands and
 * paths nested inside substitutions/subshells.
 */
export function outsideReasonFromCommands(commands: BashCommand[], root: string): string | undefined {
  for (const c of commands) {
    if (isPrivilegeEscalation(c)) return "privilege escalation";
    for (const tok of [c.name, ...c.args]) {
      let target: string | undefined;
      if (tok.startsWith("/")) target = tok;
      else if (tok === "~" || tok.startsWith("~/")) target = path.join(os.homedir(), tok.slice(1));
      else if (tok.includes("/") || tok === "..") target = path.resolve(root, tok);
      else continue;
      if (SAFE_OUTSIDE_RE.test(target)) continue;
      if (isOutside(root, target)) return `path outside project: ${tok}`;
    }
  }
  return undefined;
}

/** A parser that turns a command string into commands (real or, in tests, fake). */
export interface BashParser {
  parse(command: string): ParsedScript;
}

/** `hasError` is a property on current tree-sitter, a method on older ones. */
function nodeHasError(node: unknown): boolean {
  const n = node as { hasError?: boolean | (() => boolean) };
  if (typeof n?.hasError === "function") return n.hasError() === true;
  return n?.hasError === true;
}

let parserPromise: Promise<BashParser | undefined> | undefined;

async function initParser(): Promise<BashParser | undefined> {
  try {
    const { Parser, Language } = await import("web-tree-sitter");
    const require = createRequire(import.meta.url);
    const coreWasm = require.resolve("web-tree-sitter/tree-sitter.wasm");
    const bashWasm = require.resolve("tree-sitter-bash/tree-sitter-bash.wasm");
    await Parser.init({ locateFile: () => coreWasm });
    const lang = await Language.load(bashWasm);
    const parser = new Parser();
    parser.setLanguage(lang);
    return {
      parse: (command: string) => {
        const tree = parser.parse(command);
        if (!tree) return { commands: [], hasError: true };
        return {
          commands: extractCommands(tree.rootNode as unknown as SyntaxNodeLike),
          hasError: nodeHasError(tree.rootNode),
        };
      },
    };
  } catch {
    return undefined; // → analyzeBash falls back to the regex heuristic
  }
}

/** Lazy singleton tree-sitter parser (undefined if the WASM can't be loaded). */
export function getTreeSitterParser(): Promise<BashParser | undefined> {
  parserPromise ??= initParser();
  return parserPromise;
}

export interface BashAnalysis {
  /** Extracted commands (empty when the heuristic fallback was used). */
  commands: BashCommand[];
  /** Escape/privilege reason to force a prompt, or undefined. */
  outsideReason: string | undefined;
  /** True when tree-sitter was unavailable and the regex heuristic was used. */
  usedFallback: boolean;
  /**
   * True when the grammar hit error nodes, so `commands` may omit what the
   * shell would actually run: fish's `for … end` parses to nothing at all,
   * `switch … end` to its head alone. Callers must fail closed on this.
   */
  unparsed: boolean;
}

/** Analyze a bash command via tree-sitter, falling back to the regex heuristic. */
export async function analyzeBash(command: string, root: string): Promise<BashAnalysis> {
  const parser = await getTreeSitterParser();
  if (parser) {
    try {
      // Expand shell -c scripts so `bash -c 'sudo …'` exposes its inner
      // commands to privilege/escape detection and policy matching alike.
      const top = parser.parse(command);
      const expanded = expandShellCommands((s) => parser.parse(s), top.commands);
      return {
        commands: expanded.commands,
        outsideReason: outsideReasonFromCommands(expanded.commands, root),
        usedFallback: false,
        unparsed: top.hasError || expanded.hasError,
      };
    } catch {
      // parse failure → fall through to the heuristic
    }
  }
  return {
    commands: [],
    outsideReason: bashConfirmReason(command, root),
    usedFallback: true,
    unparsed: false,
  };
}
