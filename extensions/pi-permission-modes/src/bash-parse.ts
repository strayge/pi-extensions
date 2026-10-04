import { createRequire } from "node:module";
import path from "node:path";
import type { Access } from "./schema.ts";

export interface ShellAccess { path: string; access: Access; source: string }
interface Node { type: string; text: string; children: Node[]; namedChildren: Node[] }
interface ParsedTree { rootNode: Node; delete(): void }
interface Parser { parse(text: string): ParsedTree | null }
interface Flow { success?: string; failure?: string }
let parserPromise: Promise<Parser | undefined> | undefined;

async function parser(): Promise<Parser | undefined> {
  parserPromise ??= (async () => {
    try {
      const { Parser, Language } = await import("web-tree-sitter");
      const require = createRequire(import.meta.url);
      await Parser.init({ locateFile: () => require.resolve("web-tree-sitter/tree-sitter.wasm") });
      const instance = new Parser();
      instance.setLanguage(await Language.load(require.resolve("tree-sitter-bash/tree-sitter-bash.wasm")));
      return instance as unknown as Parser;
    } catch { return undefined; }
  })();
  return parserPromise;
}

function literal(node: Node): string | undefined {
  if (["simple_expansion", "expansion", "command_substitution", "process_substitution", "arithmetic_expansion", "ansi_c_string"].includes(node.type)) return undefined;
  if (node.children.some((child) => literal(child) === undefined)) return undefined;
  if (node.type === "raw_string") return node.text.slice(1, -1);
  if (node.type === "string") return node.text.slice(1, -1).replace(/\\([\\"$`\n])/g, "$1");
  if (node.type === "concatenation") return node.children.map(literal).join("");
  if (node.type === "word" && /[*?[\]{}~]/.test(node.text.replace(/\\./gs, ""))) return undefined;
  return node.text.replace(/\\(.)/gs, "$1");
}

type Option = "value" | "read" | "target" | "pattern";
const options: Record<string, { flags: string; values?: Record<string, Option>; long?: string[] }> = {
  cat: { flags: "AbEenstTuv", long: ["show-all", "number-nonblank", "show-ends", "number", "squeeze-blank", "show-tabs", "show-nonprinting"] },
  head: { flags: "qv", values: { n: "value", c: "value", lines: "value", bytes: "value" }, long: ["quiet", "silent", "verbose"] },
  tail: { flags: "fFqvr", values: { n: "value", c: "value", lines: "value", bytes: "value", pid: "value", "sleep-interval": "value" }, long: ["follow", "retry", "quiet", "silent", "verbose"] },
  ls: { flags: "aAbBcCdDfFgGhHiklLmMnNopqQrRsStuUvwxX1", values: { I: "value", ignore: "value", "block-size": "value", format: "value", sort: "value", time: "value", "time-style": "value" }, long: ["all", "almost-all", "directory", "human-readable", "recursive", "color", "classify"] },
  wc: { flags: "clmwL", long: ["bytes", "chars", "lines", "words", "max-line-length"] },
  du: { flags: "aHhcklmsx", values: { d: "value", "max-depth": "value", exclude: "value", "block-size": "value" }, long: ["all", "summarize", "human-readable"] },
  stat: { flags: process.platform === "darwin" ? "FLnqrsx" : "fLt", values: process.platform === "darwin" ? { f: "value", t: "value" } : { c: "value", format: "value", printf: "value" } },
  file: { flags: "bEhiIkLnNprsvz", values: { m: "read", f: "read", magic: "read", "files-from": "read", exclude: "value" }, long: ["brief", "mime", "mime-type", "mime-encoding"] },
  cp: { flags: "aAbdfHiklLnPpRrsTuvx", values: { t: "target", "target-directory": "target", suffix: "value" }, long: ["archive", "recursive", "force", "interactive", "no-clobber", "no-target-directory", "preserve", "backup", "verbose"] },
  mv: { flags: "finTuv", values: { t: "target", "target-directory": "target", suffix: "value" }, long: ["force", "interactive", "no-clobber", "no-target-directory", "backup", "verbose"] },
  install: { flags: "bCDdpsTv", values: { m: "value", o: "value", g: "value", t: "target", mode: "value", owner: "value", group: "value", "target-directory": "target" }, long: ["directory", "preserve-timestamps", "verbose"] },
  rm: { flags: "dfiIPRrvW", long: ["force", "recursive", "dir", "verbose", "interactive", "preserve-root", "one-file-system"] },
  rmdir: { flags: "pv", long: ["parents", "verbose", "ignore-fail-on-non-empty"] },
  mkdir: { flags: "pv", values: { m: "value", mode: "value" }, long: ["parents", "verbose"] },
  touch: { flags: "acfmh", values: { r: "read", reference: "read", t: "value", d: "value", date: "value", time: "value" }, long: ["no-create", "no-dereference"] },
  truncate: { flags: "co", values: { s: "value", size: "value", r: "read", reference: "read" }, long: ["no-create", "io-blocks"] },
  grep: { flags: "abcEFiIlLnqRsUvVwxyzHh", values: { e: "pattern", regexp: "pattern", f: "read", file: "read", A: "value", B: "value", C: "value", m: "value", "after-context": "value", "before-context": "value", context: "value", "max-count": "value", include: "value", exclude: "value", "exclude-dir": "value" }, long: ["fixed-strings", "ignore-case", "line-number", "recursive", "invert-match", "color", "colour", "files-with-matches", "files-without-match"] },
  rg: { flags: "acFiIlLnqRsSUuvVwxyzHh", values: { e: "pattern", regexp: "pattern", f: "read", file: "read", g: "value", glob: "value", iglob: "value", t: "value", T: "value", type: "value", "type-not": "value", A: "value", B: "value", C: "value", m: "value", "max-count": "value", "max-depth": "value", "max-filesize": "value", encoding: "value" }, long: ["hidden", "no-ignore", "no-config", "fixed-strings", "ignore-case", "line-number", "files", "files-with-matches", "files-without-match", "json", "color", "pcre2"] },
  sed: { flags: "Enr", values: { e: "pattern", expression: "pattern", f: "read", file: "read" }, long: ["quiet", "silent", "regexp-extended"] },
};

/** Unknown option semantics invalidate operand discovery instead of turning option values into paths. */
function operands(head: string, args: (string | undefined)[]): { files: string[]; reads: string[]; target?: string; pattern: boolean; inPlace: boolean } | undefined {
  const spec = options[head];
  if (!spec || args.some((arg) => arg === undefined)) return undefined;
  const result = { files: [] as string[], reads: [] as string[], target: undefined as string | undefined, pattern: false, inPlace: false };
  let end = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (end || arg === "-" || !arg.startsWith("-")) { result.files.push(arg); continue; }
    if (arg === "--") { end = true; continue; }
    if (["head", "tail"].includes(head) && /^-\d+$/.test(arg)) continue;
    if (head === "sed" && (arg.startsWith("-i") || arg === "--in-place" || arg.startsWith("--in-place="))) {
      result.inPlace = true;
      if (arg === "-i" && process.platform === "darwin") { if (args[++i] === undefined) return undefined; }
      continue;
    }
    const long = arg.startsWith("--");
    const names = long ? [arg.slice(2).split("=")[0]!] : [...arg.slice(1)];
    for (let j = 0; j < names.length; j++) {
      const name = names[j]!;
      const option = spec.values?.[name];
      if (!option) {
        if (!(long ? spec.long?.includes(name) : spec.flags.includes(name))) return undefined;
        continue;
      }
      const attached = long ? (arg.includes("=") ? arg.slice(arg.indexOf("=") + 1) : undefined) : (arg.slice(j + 2) || undefined);
      const value = attached ?? args[++i];
      if (value === undefined) return undefined;
      if (option === "read") result.reads.push(value);
      if (option === "target") result.target = value;
      if (option === "pattern" || (option === "read" && ["grep", "rg", "sed"].includes(head))) result.pattern = true;
      break;
    }
  }
  return result;
}

/** Advisory discovery tracks success/failure cwd separately; unknown flow stays in the OS sandbox. */
export async function discoverShellAccess(command: string, cwd: string, depth = 0): Promise<ShellAccess[]> {
  const instance = await parser();
  if (!instance || depth > 8) return [];
  const tree = instance.parse(command);
  if (!tree) return [];
  const requests: ShellAccess[] = [];
  const functions = new Set<string>();
  let unknownCdPath = !!process.env.CDPATH;
  const merge = (a?: string, b?: string) => a === b ? a : undefined;
  const append = (value: string | undefined, access: Access, current: string | undefined, source: string) => {
    if (!value || value === "-" || (!current && !path.isAbsolute(value))) return;
    requests.push({ path: path.resolve(current ?? "/", value), access, source });
  };
  const sequence = async (nodes: Node[], current?: string): Promise<Flow> => {
    let flow: Flow = { success: current, failure: current };
    for (let i = 0; i < nodes.length; i++) {
      const node = nodes[i]!;
      if ([";", "&", "(", ")", "{", "}"].includes(node.text)) continue;
      const next = await walk(node, current);
      if (nodes[i + 1]?.text === "&") continue;
      flow = next; current = merge(flow.success, flow.failure);
    }
    return flow;
  };
  const walk = async (node: Node, current?: string): Promise<Flow> => {
    const unchanged = { success: current, failure: current };
    if (node.type === "ERROR") return {};
    if (node.type === "function_definition") { functions.add(node.namedChildren[0]?.text ?? ""); return unchanged; }
    if (node.type === "variable_assignment" && node.namedChildren[0]?.text === "CDPATH") unknownCdPath = true;
    if (node.type === "heredoc_redirect" && /['"\\]/.test(node.namedChildren[0]?.text ?? "")) return unchanged;
    if (["subshell", "command_substitution", "process_substitution"].includes(node.type)) {
      await sequence(node.children, current); return unchanged;
    }
    if (node.type === "pipeline") { for (const child of node.namedChildren) await walk(child, current); return unchanged; }
    if (node.type === "list") {
      const operator = node.children.find((child) => child.text === "&&" || child.text === "||")?.text;
      if (operator && node.namedChildren.length === 2) {
        const left = await walk(node.namedChildren[0]!, current);
        const right = await walk(node.namedChildren[1]!, operator === "&&" ? left.success : left.failure);
        return operator === "&&" ? { success: right.success, failure: merge(left.failure, right.failure) }
          : { success: merge(left.success, right.success), failure: right.failure };
      }
    }
    if (node.type === "if_statement") {
      const then = node.children.findIndex((child) => child.text === "then");
      const otherwise = node.children.findIndex((child) => ["else_clause", "elif_clause"].includes(child.type));
      const condition = await sequence(node.children.slice(1, then), current);
      const yes = await sequence(node.children.slice(then + 1, otherwise < 0 ? -1 : otherwise), condition.success);
      const no = otherwise < 0 ? { success: condition.failure, failure: condition.failure }
        : await sequence(node.children[otherwise]!.children.slice(1), condition.failure);
      const after = merge(merge(yes.success, yes.failure), merge(no.success, no.failure));
      return { success: after, failure: after };
    }
    if (["for_statement", "while_statement", "case_statement", "c_style_for_statement"].includes(node.type)) {
      for (const child of node.namedChildren) await walk(child, undefined);
      return {};
    }
    if (node.type === "redirected_statement") {
      for (const child of node.namedChildren.slice(1)) await walk(child, current);
      return node.namedChildren[0] ? walk(node.namedChildren[0], current) : unchanged;
    }
    if (node.type === "file_redirect") {
      // The grammar represents <> as '<' plus an ERROR child; its literal operator is unambiguous.
      const operator = node.text.match(/^(?:\d+)?(<>|<&|&>>|&>|>>|>\||>&|<|>)/)?.[1];
      const target = node.namedChildren.at(-1);
      const value = target ? literal(target) : undefined;
      if (operator && operator !== "<&" && !(operator === ">&" && (value === "-" || /^\d+-?$/.test(value ?? "") || node.namedChildren.some((child) => child.type === "file_descriptor"))))
        append(value, operator === "<" ? "read" : "write", current, node.text);
      for (const child of node.namedChildren) if (literal(child) === undefined) await walk(child, current);
      return unchanged;
    }
    if (node.type === "command") {
      const tokens = node.children.filter((child) => ["command_name", "word", "string", "raw_string", "concatenation", "number"].includes(child.type));
      const [name, ...args] = tokens.map(literal);
      const head = name ? path.basename(name) : "";
      if (name?.includes("/")) append(name, "read", current, node.text);
      for (const child of node.namedChildren) if (!tokens.includes(child) || literal(child) === undefined) await walk(child, current);
      if (functions.has(head)) return {};
      if (head === "cd") {
        const positional = args.filter((arg) => arg !== "--" && arg !== "-L" && arg !== "-P");
        const destination = positional.length === 1 && !positional[0]?.startsWith("-") ? positional[0] : undefined;
        append(destination, "read", current, node.text);
        return { success: destination && !args.includes("-P") && !unknownCdPath && (current || path.isAbsolute(destination)) ? path.resolve(current ?? "/", destination) : undefined, failure: current };
      }
      if (["eval", "source", ".", "pushd", "popd", "command", "builtin"].includes(head)) return {};
      if (["node", "python", "python3", "bash", "sh", "zsh"].includes(head)) {
        if (["bash", "sh", "zsh"].includes(head) && args[0] === "-c" && args[1] && current)
          requests.push(...await discoverShellAccess(args[1], current, depth + 1));
        else if (args[0] && !args[0].startsWith("-")) append(args[0], "read", current, node.text);
        else if (args[0] === "--") append(args[1], "read", current, node.text);
        return unchanged;
      }
      const parsed = operands(head, args);
      if (!parsed) return unchanged;
      for (const file of parsed.reads) append(file, "read", current, node.text);
      if (parsed.target) append(parsed.target, "write", current, node.text);
      let files = parsed.files;
      if (["grep", "rg", "sed"].includes(head) && !parsed.pattern && !args.includes("--files")) files = files.slice(1);
      for (let i = 0; i < files.length; i++) {
        const write = ["mv", "rm", "rmdir", "mkdir", "touch", "truncate"].includes(head) ||
          (head === "install" && (args.includes("-d") || args.includes("--directory"))) ||
          (["cp", "install"].includes(head) && !parsed.target && i === files.length - 1) || (head === "sed" && parsed.inPlace);
        append(files[i], write ? "write" : "read", current, node.text);
      }
      return unchanged;
    }
    return sequence(node.children, current);
  };
  try { await walk(tree.rootNode, cwd); } finally { tree.delete(); }
  const strongest = new Map<string, ShellAccess>();
  for (const request of requests) if (strongest.get(request.path)?.access !== "write") strongest.set(request.path, request);
  return [...strongest.values()];
}
