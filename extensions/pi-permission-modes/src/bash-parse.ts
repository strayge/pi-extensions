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

/** One environment assignment applied before a command invocation. */
export interface BashAssignment {
  name: string;
  /** Original assignment spelling retained for an unambiguous approval prompt. */
  source: string;
  /** Decoded literal value, or the unevaluated source spelling when dynamic. */
  value: string;
  dynamic: boolean;
}

/** One command extracted from a bash line. */
export interface BashCommand {
  /** Command head, e.g. "git", "sudo", "cat"; empty for assignment-only statements. */
  name: string;
  /** Remaining tokens (args), quotes stripped. */
  args: string[];
  /** Environment assignments applied by the shell before this invocation. */
  assignments?: BashAssignment[];
  /** True when the command sits inside `$(...)`, backticks, or a subshell. */
  isNested: boolean;
  /** True when the command head is produced by expansion. */
  dynamic?: boolean;
  /** Argument positions whose values are produced or changed by expansion. */
  dynamicArgs?: boolean[];
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

function decodeBackslashes(value: string, doubleQuoted: boolean): string | undefined {
  let decoded = "";
  for (let index = 0; index < value.length; index++) {
    const character = value[index]!;
    if (character !== "\\") {
      decoded += character;
      continue;
    }
    const next = value[++index];
    if (next === undefined) return undefined;
    if (next === "\n") continue;
    if (!doubleQuoted || ["$", "`", '"', "\\"].includes(next)) decoded += next;
    else decoded += `\\${next}`;
  }
  return decoded;
}

/** Decode one expansion-free shell word without evaluating shell syntax. */
function decodeLiteralNode(node: SyntaxNodeLike): string | undefined {
  if (nodeIsDynamic(node)) return undefined;
  if (node.type === "command_name") {
    return node.children?.length === 1 ? decodeLiteralNode(node.children[0]!) : undefined;
  }
  if (node.type === "concatenation") {
    let decoded = "";
    for (const child of node.children ?? []) {
      const part = decodeLiteralNode(child);
      if (part === undefined) return undefined;
      decoded += part;
    }
    return decoded;
  }
  if (node.type === "raw_string" || (node.type === "string" && node.text.startsWith("'"))) {
    return node.text.length >= 2 && node.text.endsWith("'") ? node.text.slice(1, -1) : undefined;
  }
  if (node.type === "string") {
    return node.text.length >= 2 && node.text.endsWith('"')
      ? decodeBackslashes(node.text.slice(1, -1), true)
      : undefined;
  }
  if (node.type === "word" || node.type === "number") return decodeBackslashes(node.text, false);
  // ANSI-C strings have a larger escape grammar. Treating an unsupported
  // literal as dynamic is safer than analyzing a spelling the shell will alter.
  return undefined;
}

function fallbackTokenText(value: string): string {
  if (value.length < 2) return value;
  const first = value[0];
  const last = value[value.length - 1];
  if ((first === "'" || first === '"') && last === first) return value.slice(1, -1);
  return value;
}

const DYNAMIC_NODES = new Set([
  "simple_expansion",
  "expansion",
  "command_substitution",
  "process_substitution",
  "arithmetic_expansion",
]);

function nodeIsDynamic(node: SyntaxNodeLike): boolean {
  return DYNAMIC_NODES.has(node.type) || (node.children ?? []).some(nodeIsDynamic);
}

function parseAssignment(node: SyntaxNodeLike): BashAssignment {
  const equals = node.text.indexOf("=");
  const name = equals < 0 ? node.text : node.text.slice(0, equals);
  const valueSource = equals < 0 ? "" : node.text.slice(equals + 1);
  const valueNodes = (node.children ?? []).filter((child) => child.type !== "variable_name" && child.type !== "=");
  const valueNode = valueNodes.length === 1 ? valueNodes[0] : undefined;
  const literal = valueNode ? decodeLiteralNode(valueNode) : valueNodes.length === 0 ? "" : undefined;
  return { name, source: node.text, value: literal ?? valueSource, dynamic: literal === undefined };
}

function parseCommand(node: SyntaxNodeLike, isNested: boolean): BashCommand {
  let name = "";
  let dynamic = false;
  const args: string[] = [];
  const assignments: BashAssignment[] = [];
  const dynamicArgs: boolean[] = [];
  for (const child of node.children ?? []) {
    if (child.type === "variable_assignment") {
      assignments.push(parseAssignment(child));
    } else if (child.type === "command_name") {
      if (!name) {
        const literal = decodeLiteralNode(child);
        name = literal ?? fallbackTokenText(child.text.trim());
        dynamic = literal === undefined;
      }
    } else if (ARG_TYPES.has(child.type)) {
      const literal = decodeLiteralNode(child);
      args.push(literal ?? fallbackTokenText(child.text));
      dynamicArgs.push(literal === undefined);
    }
  }
  return {
    name,
    args,
    ...(assignments.length > 0 ? { assignments } : {}),
    isNested,
    ...(dynamic ? { dynamic: true } : {}),
    ...(dynamicArgs.some(Boolean) ? { dynamicArgs } : {}),
  };
}

/** Walk a CST (or fake tree) into the list of commands, marking nested ones. */
export function extractCommands(root: SyntaxNodeLike): BashCommand[] {
  const out: BashCommand[] = [];
  const walk = (node: SyntaxNodeLike, nested: boolean, parentType?: string) => {
    const inNest = nested || NESTING.has(node.type);
    if (node.type === "command") out.push(parseCommand(node, inNest));
    else if (node.type === "variable_assignment" && parentType !== "command") {
      out.push({ name: "", args: [], assignments: [parseAssignment(node)], isNested: inNest });
    }
    for (const c of node.children ?? []) walk(c, inNest, node.type);
  };
  walk(root, false);
  return out;
}

/** Result of parsing one command-running wrapper. */
type WrapperResult =
  | { kind: "command"; command: BashCommand }
  | { kind: "none" }
  | { kind: "ambiguous" };

const HELP_OR_VERSION = new Set(["--help", "--version", "-h", "-V"]);

function nestedCommand(command: BashCommand, index: number): BashCommand {
  const dynamicArgs = command.dynamicArgs?.slice(index + 1);
  return {
    name: command.args[index]!,
    args: command.args.slice(index + 1),
    isNested: command.isNested,
    ...(command.dynamicArgs?.[index] === true ? { dynamic: true } : {}),
    ...(dynamicArgs?.some(Boolean) ? { dynamicArgs } : {}),
  };
}

function commandAt(command: BashCommand, index: number): WrapperResult {
  return index < command.args.length ? { kind: "command", command: nestedCommand(command, index) } : { kind: "none" };
}

function longOption(argument: string): { name: string; attached: boolean } {
  const equals = argument.indexOf("=");
  return equals < 0
    ? { name: argument, attached: false }
    : { name: argument.slice(0, equals), attached: true };
}

function optionOperand(command: BashCommand, index: number, attached: boolean): number | undefined {
  if (attached) return index + 1;
  return index + 1 < command.args.length ? index + 2 : undefined;
}

/**
 * Parse the option grammar of every wrapper we claim to see through. Unknown
 * options are deliberately ambiguous: guessing an argv boundary would let an
 * option operand be mistaken for the executable.
 */
function wrappedCommand(command: BashCommand): WrapperResult | undefined {
  const wrapper = path.basename(command.name);
  const args = command.args;
  let index = 0;
  let options = true;

  if (wrapper === "env") {
    while (index < args.length) {
      const argument = args[index]!;
      if (options && argument === "--") { options = false; index++; continue; }
      if (options && argument === "-") { index++; continue; }
      if (options && HELP_OR_VERSION.has(argument)) return { kind: "none" };
      if (options && argument.startsWith("--")) {
        const option = longOption(argument);
        if (["--ignore-environment", "--null", "--debug"].includes(option.name)) { index++; continue; }
        if (["--unset", "--chdir", "--split-string"].includes(option.name)) {
          const next = optionOperand(command, index, option.attached);
          if (next === undefined || option.name === "--split-string") return { kind: "ambiguous" };
          index = next;
          continue;
        }
        if (["--block-signal", "--default-signal", "--ignore-signal"].includes(option.name)) { index++; continue; }
        return { kind: "ambiguous" };
      }
      if (options && /^-[iuCS]/.test(argument)) {
        if (argument === "-i") { index++; continue; }
        if (/^-[uCS].+/.test(argument)) {
          if (argument.startsWith("-S")) return { kind: "ambiguous" };
          index++;
          continue;
        }
        if (argument === "-u" || argument === "-C" || argument === "-S") {
          if (index + 1 >= args.length || argument === "-S") return { kind: "ambiguous" };
          index += 2;
          continue;
        }
        return { kind: "ambiguous" };
      }
      if (options && argument.startsWith("-")) return { kind: "ambiguous" };
      if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(argument)) { index++; continue; }
      return commandAt(command, index);
    }
    return { kind: "none" };
  }

  if (wrapper === "command") {
    let query = false;
    while (index < args.length && options) {
      const argument = args[index]!;
      if (argument === "--") { options = false; index++; break; }
      if (!argument.startsWith("-") || argument === "-") break;
      if (!/^-[pVv]+$/.test(argument)) return { kind: "ambiguous" };
      query ||= /[Vv]/.test(argument);
      index++;
    }
    return query ? { kind: "none" } : commandAt(command, index);
  }

  if (wrapper === "nice") {
    while (index < args.length) {
      const argument = args[index]!;
      if (argument === "--") return commandAt(command, index + 1);
      if (HELP_OR_VERSION.has(argument)) return { kind: "none" };
      if (/^-[0-9]+$/.test(argument) || /^-n.+/.test(argument) || argument.startsWith("--adjustment=")) { index++; continue; }
      if (argument === "-n" || argument === "--adjustment") {
        if (index + 1 >= args.length) return { kind: "ambiguous" };
        index += 2;
        continue;
      }
      if (argument.startsWith("-")) return { kind: "ambiguous" };
      return commandAt(command, index);
    }
    return { kind: "none" };
  }

  if (wrapper === "ionice") {
    let processSelection = false;
    while (index < args.length) {
      const argument = args[index]!;
      if (argument === "--") return processSelection ? { kind: "none" } : commandAt(command, index + 1);
      if (HELP_OR_VERSION.has(argument)) return { kind: "none" };
      const option = argument.startsWith("--") ? longOption(argument) : undefined;
      if (option && ["--class", "--classdata", "--pid", "--pgid", "--uid"].includes(option.name)) {
        const next = optionOperand(command, index, option.attached);
        if (next === undefined) return { kind: "ambiguous" };
        processSelection ||= ["--pid", "--pgid", "--uid"].includes(option.name);
        index = next;
        continue;
      }
      if (["-c", "-n", "-p", "-P", "-u"].includes(argument)) {
        if (index + 1 >= args.length) return { kind: "ambiguous" };
        processSelection ||= ["-p", "-P", "-u"].includes(argument);
        index += 2;
        continue;
      }
      if (/^-[cnpPu].+/.test(argument)) { processSelection ||= /^-[pPu]/.test(argument); index++; continue; }
      if (argument === "-t" || argument === "--ignore") { index++; continue; }
      if (argument.startsWith("-")) return { kind: "ambiguous" };
      return processSelection ? { kind: "none" } : commandAt(command, index);
    }
    return { kind: "none" };
  }

  if (wrapper === "nohup" || wrapper === "setsid") {
    const flags = wrapper === "setsid" ? new Set(["-c", "--ctty", "-f", "--fork", "-w", "--wait"]) : new Set<string>();
    while (index < args.length) {
      const argument = args[index]!;
      if (argument === "--") return commandAt(command, index + 1);
      if (HELP_OR_VERSION.has(argument)) return { kind: "none" };
      if (flags.has(argument)) { index++; continue; }
      if (argument.startsWith("-")) return { kind: "ambiguous" };
      return commandAt(command, index);
    }
    return { kind: "none" };
  }

  if (wrapper === "stdbuf") {
    while (index < args.length) {
      const argument = args[index]!;
      if (argument === "--") return commandAt(command, index + 1);
      if (HELP_OR_VERSION.has(argument)) return { kind: "none" };
      const option = argument.startsWith("--") ? longOption(argument) : undefined;
      if (option && ["--input", "--output", "--error"].includes(option.name)) {
        const next = optionOperand(command, index, option.attached);
        if (next === undefined) return { kind: "ambiguous" };
        index = next;
        continue;
      }
      if (/^-[ioe].+/.test(argument)) { index++; continue; }
      if (["-i", "-o", "-e"].includes(argument)) {
        if (index + 1 >= args.length) return { kind: "ambiguous" };
        index += 2;
        continue;
      }
      if (argument.startsWith("-")) return { kind: "ambiguous" };
      return commandAt(command, index);
    }
    return { kind: "none" };
  }

  if (wrapper === "timeout") {
    while (index < args.length) {
      const argument = args[index]!;
      if (argument === "--") { index++; break; }
      if (HELP_OR_VERSION.has(argument)) return { kind: "none" };
      if (["-v", "--verbose", "--foreground", "--preserve-status"].includes(argument)) { index++; continue; }
      const option = argument.startsWith("--") ? longOption(argument) : undefined;
      if (option && ["--kill-after", "--signal"].includes(option.name)) {
        const next = optionOperand(command, index, option.attached);
        if (next === undefined) return { kind: "ambiguous" };
        index = next;
        continue;
      }
      if (/^-[ks].+/.test(argument)) { index++; continue; }
      if (argument === "-k" || argument === "-s") {
        if (index + 1 >= args.length) return { kind: "ambiguous" };
        index += 2;
        continue;
      }
      if (argument.startsWith("-")) return { kind: "ambiguous" };
      break;
    }
    if (index >= args.length) return { kind: "none" };
    // DURATION is a mandatory positional prelude, not the executable.
    return commandAt(command, index + 1);
  }

  if (wrapper === "time") {
    while (index < args.length) {
      const argument = args[index]!;
      if (argument === "--") return commandAt(command, index + 1);
      if (HELP_OR_VERSION.has(argument)) return { kind: "none" };
      if (["-a", "--append", "-p", "--portability", "-v", "--verbose", "--quiet"].includes(argument)) { index++; continue; }
      const option = argument.startsWith("--") ? longOption(argument) : undefined;
      if (option && ["--format", "--output"].includes(option.name)) {
        const next = optionOperand(command, index, option.attached);
        if (next === undefined) return { kind: "ambiguous" };
        index = next;
        continue;
      }
      if (/^-[fo].+/.test(argument)) { index++; continue; }
      if (argument === "-f" || argument === "-o") {
        if (index + 1 >= args.length) return { kind: "ambiguous" };
        index += 2;
        continue;
      }
      if (argument.startsWith("-")) return { kind: "ambiguous" };
      return commandAt(command, index);
    }
    return { kind: "none" };
  }

  if (wrapper === "xargs") {
    while (index < args.length) {
      const argument = args[index]!;
      if (argument === "--") return commandAt(command, index + 1);
      if (HELP_OR_VERSION.has(argument)) return { kind: "none" };
      if (["-0", "--null", "-o", "--open-tty", "-p", "--interactive", "-r", "--no-run-if-empty", "-t", "--verbose", "-x", "--exit", "--show-limits"].includes(argument)) { index++; continue; }
      const option = argument.startsWith("--") ? longOption(argument) : undefined;
      if (option && ["--arg-file", "--delimiter", "--max-args", "--max-procs", "--max-chars", "--process-slot-var"].includes(option.name)) {
        const next = optionOperand(command, index, option.attached);
        if (next === undefined) return { kind: "ambiguous" };
        index = next;
        continue;
      }
      if (option && ["--eof", "--replace", "--max-lines"].includes(option.name)) {
        // GNU optional option arguments are consumed only when attached. In
        // particular, bare --max-lines defaults to one and leaves COMMAND next.
        index++;
        continue;
      }
      if (["-a", "-d", "-E", "-I", "-L", "-n", "-P", "-s"].includes(argument)) {
        if (index + 1 >= args.length) return { kind: "ambiguous" };
        index += 2;
        continue;
      }
      if (/^-[adEILnPs].+/.test(argument) || /^-[eil].*/.test(argument)) { index++; continue; }
      if (argument.startsWith("-")) return { kind: "ambiguous" };
      return commandAt(command, index);
    }
    // GNU xargs defaults to echo when COMMAND is omitted.
    return { kind: "command", command: { name: "echo", args: [], isNested: command.isNested } };
  }

  if (wrapper === "exec") {
    while (index < args.length) {
      const argument = args[index]!;
      if (argument === "--") return commandAt(command, index + 1);
      if (argument === "-c" || argument === "-l" || argument === "-cl" || argument === "-lc") { index++; continue; }
      if (argument === "-a") {
        if (index + 1 >= args.length) return { kind: "ambiguous" };
        index += 2;
        continue;
      }
      if (argument.startsWith("-a") && argument.length > 2) { index++; continue; }
      if (argument.startsWith("-")) return { kind: "ambiguous" };
      return commandAt(command, index);
    }
    return { kind: "none" };
  }

  if (wrapper === "builtin") {
    if (args[0] === "--") index = 1;
    else if (args[0]?.startsWith("-")) return { kind: "ambiguous" };
    return commandAt(command, index);
  }

  return undefined;
}

interface EffectiveResolution {
  command: BashCommand;
  chain: BashCommand[];
  ambiguous: boolean;
}

function resolveEffectiveCommand(command: BashCommand): EffectiveResolution {
  let current = command;
  const chain: BashCommand[] = [];
  while (true) {
    const result = wrappedCommand(current);
    if (!result || result.kind === "none") return { command: current, chain, ambiguous: false };
    if (result.kind === "ambiguous") return { command: current, chain, ambiguous: true };
    // Every supported wrapper removes its own executable and any option prefix,
    // so argv strictly shortens and no independent hop limit is needed.
    current = result.command;
    chain.push(current);
  }
}

/** Resolve supported command-running wrappers to the command they execute. */
export function effectiveCommand(c: BashCommand): BashCommand {
  const resolved = resolveEffectiveCommand(c);
  return resolved.ambiguous ? { ...resolved.command, dynamic: true } : resolved.command;
}

/**
 * True when the command escalates privileges — directly (`sudo …`) or through
 * known wrapper commands (`env PATH=/x sudo …`, `nice -n 10 doas …`). Wrapper
 * resolution is shared with interpreter classification so the two safeguards
 * cannot disagree about which command will actually run.
 */
export function isPrivilegeEscalation(c: BashCommand): boolean {
  return PRIVILEGE_RE.test(path.basename(effectiveCommand(c).name));
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
      const dynamicArgs = cur.dynamicArgs?.slice(1);
      cur = {
        name: cur.args[0]!,
        args: cur.args.slice(1),
        isNested: cur.isNested,
        ...(cur.dynamicArgs?.[0] === true ? { dynamic: true } : {}),
        ...(dynamicArgs?.some(Boolean) ? { dynamicArgs } : {}),
      };
    }
    out.push(cur);
  }
  return out;
}

const LONG_COMMAND_OPTIONS: Readonly<Record<string, ReadonlySet<string>>> = {
  fish: new Set(["--command"]),
};

const SHORT_OPTIONS_WITH_VALUE: Readonly<Record<string, ReadonlySet<string>>> = {
  bash: new Set(["-O", "-o", "+O", "+o"]),
  dash: new Set(["-o", "+o"]),
  fish: new Set(["-C", "-d", "-D"]),
  ksh: new Set(["-o", "+o"]),
  sh: new Set(["-o", "+o"]),
  zsh: new Set(["-o", "+o"]),
};

/** Single-character flags that may legally share a token with `-c`. */
const GROUPABLE_SHORT_OPTIONS: Readonly<Record<string, ReadonlySet<string>>> = {
  bash: new Set("abefhkmnptuvxBCEHPTDcilrs"),
  dash: new Set("aCefnuvxIimqVEbpcils"),
  fish: new Set("cfilNnP"),
  ksh: new Set("abcefhikmnprstuvxcl"),
  sh: new Set("abefhkmnptuvxcilrs"),
  zsh: new Set("abcdefiklmnoprstuvxCDFILNPRSTXc"),
};

const LONG_OPTIONS_WITH_VALUE: Readonly<Record<string, ReadonlySet<string>>> = {
  bash: new Set(["--init-file", "--rcfile"]),
  fish: new Set(["--features", "--init-command", "--init-command-exit"]),
};

export interface ShellInvocation {
  /** Effective interpreter after supported wrappers have been removed. */
  command: BashCommand;
  interpreter: string;
  kind: "command-string" | "script-file" | "stdin" | "eval" | "source";
  /** Present only when an inspectable literal command string was found. */
  script?: string;
  /** Literal initialization commands executed before `script`, in order. */
  initializationScripts?: string[];
  /** True only when every interpreted command source can be recursively parsed. */
  inspectable: boolean;
}

function isShortCommandOption(argument: string, interpreter: string): boolean {
  if (!/^-[A-Za-z]+$/.test(argument)) return false;
  const options = [...argument.slice(1)];
  const supported = GROUPABLE_SHORT_OPTIONS[interpreter] ?? new Set<string>();
  return options.includes("c") && options.every((option) => supported.has(option));
}

function commandStringArgument(
  command: BashCommand,
  interpreter: string,
): { script?: string; initializationScripts?: string[]; inspectable: boolean } | undefined {
  let commandMode = false;
  let unsafeInitialization = false;
  const initializationScripts: string[] = [];
  const longCommands = LONG_COMMAND_OPTIONS[interpreter] ?? new Set<string>();
  const shortValues = SHORT_OPTIONS_WITH_VALUE[interpreter] ?? new Set<string>();
  const longValues = LONG_OPTIONS_WITH_VALUE[interpreter] ?? new Set<string>();

  for (let index = 0; index < command.args.length; index++) {
    const argument = command.args[index]!;
    if (argument === "--") continue;

    const option = longOption(argument);
    if (longCommands.has(option.name)) {
      commandMode = true;
      if (option.attached) {
        const script = argument.slice(argument.indexOf("=") + 1);
        return {
          script,
          ...(initializationScripts.length > 0 ? { initializationScripts } : {}),
          inspectable: !unsafeInitialization && command.dynamicArgs?.[index] !== true,
        };
      }
      continue;
    }

    if (interpreter === "fish" && ["--init-command", "--init-command-exit"].includes(option.name)) {
      const valueIndex = option.attached ? index : index + 1;
      if (!option.attached) index++;
      if (valueIndex >= command.args.length || command.dynamicArgs?.[valueIndex]) unsafeInitialization = true;
      else initializationScripts.push(option.attached ? argument.slice(argument.indexOf("=") + 1) : command.args[valueIndex]!);
      continue;
    }
    if (interpreter === "fish" && (argument === "-C" || argument.startsWith("-C"))) {
      const attached = argument.length > 2;
      const valueIndex = attached ? index : index + 1;
      if (!attached) index++;
      if (valueIndex >= command.args.length || command.dynamicArgs?.[valueIndex]) unsafeInitialization = true;
      else initializationScripts.push(attached ? argument.slice(2) : command.args[valueIndex]!);
      continue;
    }

    if (interpreter === "bash" && ["--init-file", "--rcfile"].includes(option.name)) {
      unsafeInitialization = true;
      if (!option.attached) index++;
      continue;
    }

    if (argument.startsWith("--")) {
      if (longValues.has(option.name) && !option.attached) index++;
      continue;
    }
    if (/^-[^-]+$/.test(argument)) {
      if (shortValues.has(argument)) {
        index++;
        continue;
      }
      if (isShortCommandOption(argument, interpreter)) commandMode = true;
      continue;
    }
    if (argument.startsWith("+") && shortValues.has(argument)) {
      index++;
      continue;
    }

    if (!commandMode) return undefined;
    return {
      script: argument,
      ...(initializationScripts.length > 0 ? { initializationScripts } : {}),
      inspectable: !unsafeInitialization && command.dynamicArgs?.[index] !== true,
    };
  }
  return commandMode
    ? {
        ...(initializationScripts.length > 0 ? { initializationScripts } : {}),
        inspectable: false,
      }
    : undefined;
}

/**
 * Classify commands whose executable body is interpreted rather than directly
 * visible in the outer AST. Script files, stdin, source, and eval are not
 * inspectable; only a literal shell command string can be recursively parsed.
 */
export function classifyShellInvocation(c: BashCommand): ShellInvocation | undefined {
  const resolved = resolveEffectiveCommand(c);
  if (resolved.ambiguous) return undefined;
  const command = resolved.command;
  const interpreter = path.basename(command.name);
  if (interpreter === "eval") {
    return { command, interpreter, kind: "eval", inspectable: false };
  }
  if (interpreter === "source" || interpreter === ".") {
    return { command, interpreter, kind: "source", inspectable: false };
  }
  if (!SHELL_COMMANDS.has(interpreter)) return undefined;

  const found = commandStringArgument(command, interpreter);
  if (found) {
    return {
      command,
      interpreter,
      kind: "command-string",
      ...(found.script !== undefined ? { script: found.script } : {}),
      ...(found.initializationScripts !== undefined ? { initializationScripts: found.initializationScripts } : {}),
      inspectable: found.inspectable,
    };
  }
  return {
    command,
    interpreter,
    kind: command.args.length > 0 ? "script-file" : "stdin",
    inspectable: false,
  };
}

/** True when policy cannot identify every command an invocation will execute. */
export function isDynamicCommand(c: BashCommand): boolean {
  if (c.assignments?.length) return true;
  const resolved = resolveEffectiveCommand(c);
  if (resolved.ambiguous || resolved.command.dynamic) return true;
  const invocation = classifyShellInvocation(c);
  return invocation !== undefined && !invocation.inspectable;
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
  const out: BashCommand[] = [];
  let hasError = false;
  for (const c of commands) {
    out.push(c);
    const resolved = resolveEffectiveCommand(c);
    // Policy must see the executable behind wrappers, not only the outer argv.
    // Each link is retained because a nested wrapper can itself be denied.
    for (const nested of resolved.chain) out.push({ ...nested, isNested: true });

    const found = classifyShellInvocation(c);
    if (found?.kind !== "command-string" || !found.inspectable || found.script === undefined) continue;
    if (depth >= 3) {
      // The body is known to contain another interpreter, but expanding it any
      // further would defeat the recursion bound. Preserve the bound without
      // treating unseen commands as safe.
      hasError = true;
      continue;
    }
    const scripts = [...(found.initializationScripts ?? []), found.script];
    for (const script of scripts) {
      let inner: BashCommand[] = [];
      try {
        const parsed = parse(script);
        // Propagated, not swallowed: an unreadable script would otherwise leave
        // only the innocuous-looking outer `fish -c` for policy to judge.
        hasError ||= parsed.hasError;
        inner = parsed.commands.map((i) => ({ ...i, isNested: true }));
        if (NON_POSIX_SHELLS.has(found.interpreter)) inner = splitFishConnectives(inner);
      } catch {
        // Unparsable inner script stays subject to a fail-closed one-shot prompt.
        hasError = true;
      }
      const expanded = expandShellCommands(parse, inner, depth + 1);
      hasError ||= expanded.hasError;
      out.push(...expanded.commands);
    }
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
    const assignmentValues = c.assignments?.map((assignment) => assignment.value) ?? [];
    for (const tok of [c.name, ...c.args, ...assignmentValues]) {
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

/** Override parser availability for tests that exercise the heuristic fallback. */
export function overrideBashParserForTesting(parser: BashParser | undefined): () => void {
  const previous = parserPromise;
  parserPromise = Promise.resolve(parser);
  return () => {
    parserPromise = previous;
  };
}

export interface BashAnalysis {
  /** Extracted commands (empty when the heuristic fallback was used). */
  commands: BashCommand[];
  /** Escape/privilege reason to force a prompt, or undefined. */
  outsideReason: string | undefined;
  /** True when tree-sitter was unavailable and the regex heuristic was used. */
  usedFallback: boolean;
  /** True when expansion or an interpreter hides the command that will run. */
  dynamic: boolean;
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
        dynamic: expanded.commands.some(isDynamicCommand),
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
    dynamic: false,
    unparsed: false,
  };
}
