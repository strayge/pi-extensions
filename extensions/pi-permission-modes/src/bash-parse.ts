import { createRequire } from "node:module";
import path from "node:path";
import type { Access } from "./schema.ts";

export interface ShellAccess {
  path: string;
  access: Access;
  source: string;
}
interface Node {
  type: string;
  text: string;
  children: Node[];
  namedChildren?: Node[];
}
interface ParsedTree {
  rootNode: Node;
  delete(): void;
}
interface Parser {
  parse(text: string): ParsedTree | null;
}
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
    } catch {
      return undefined;
    }
  })();
  return parserPromise;
}

function literal(node: Node): string | undefined {
  if (
    ["simple_expansion", "expansion", "command_substitution", "process_substitution", "arithmetic_expansion"].includes(
      node.type,
    )
  )
    return undefined;
  if ((node.children ?? []).some((child) => literal(child) === undefined)) return undefined;
  if (node.type === "raw_string") return node.text.slice(1, -1);
  if (node.type === "string") return node.text.slice(1, -1).replace(/\\([\\"$`\n])/g, "$1");
  if (node.type === "concatenation") return node.children.map(literal).join("");
  if (node.type === "ansi_c_string") return undefined;
  if (node.type === "word" && /[*?[\]{}~]/.test(node.text)) return undefined;
  return node.text.replace(/\\(.)/gs, "$1");
}

/** Discovery is advisory: unknown syntax stays sandboxed and never gains a command approval. */
export async function discoverShellAccess(command: string, cwd: string, depth = 0): Promise<ShellAccess[]> {
  const instance = await parser();
  if (!instance || depth > 8) return [];
  const tree = instance.parse(command);
  if (!tree) return [];
  const requests: ShellAccess[] = [];
  const append = (value: string | undefined, access: Access, current: string | undefined, source: string) => {
    if (!value || !current || value === "-" || value.startsWith("-")) return;
    requests.push({ path: path.resolve(current, value), access, source });
  };
  const walk = async (node: Node, location: { cwd?: string }): Promise<void> => {
    if (node.type === "ERROR") {
      location.cwd = undefined;
      return;
    }
    if (["subshell", "command_substitution", "process_substitution", "function_definition"].includes(node.type)) {
      for (const child of node.children) await walk(child, { cwd: location.cwd });
      return;
    }
    if (node.type === "file_redirect") {
      const operator = node.children.find((c) => [">", ">>", "<", "<>", ">|", "&>", "&>>"].includes(c.text))?.text;
      const target = node.children.at(-1);
      if (operator && target) append(literal(target), operator === "<" ? "read" : "write", location.cwd, node.text);
      return;
    }
    if (node.type === "command") {
      const tokens = node.children.filter((child) =>
        ["command_name", "word", "string", "raw_string", "concatenation", "number"].includes(child.type),
      );
      const values = tokens.map(literal);
      const name = values[0];
      const args = values.slice(1);
      if (name?.includes("/")) append(name, "read", location.cwd, node.text);
      const head = name ? path.basename(name) : "";
      if (head === "cd") {
        const destination = args.length === 1 ? args[0] : undefined;
        append(destination, "read", location.cwd, node.text);
        location.cwd = destination && location.cwd ? path.resolve(location.cwd, destination) : undefined;
      } else if (["cp", "mv", "install"].includes(head)) {
        const operands = args.filter((a) => a !== undefined && !a.startsWith("-"));
        for (let i = 0; i < operands.length; i++)
          append(operands[i], head === "mv" || i === operands.length - 1 ? "write" : "read", location.cwd, node.text);
      } else if (["rm", "rmdir", "mkdir", "touch", "truncate"].includes(head)) {
        for (const arg of args) append(arg, "write", location.cwd, node.text);
      } else if (["cat", "head", "tail", "ls", "stat", "wc", "du", "file"].includes(head)) {
        for (const arg of args) append(arg, "read", location.cwd, node.text);
      } else if (["node", "python", "python3", "bash", "sh", "zsh"].includes(head)) {
        if (["bash", "sh", "zsh"].includes(head) && args[0] === "-c" && args[1] && location.cwd)
          requests.push(...(await discoverShellAccess(args[1], location.cwd, depth + 1)));
        else if (args[0] && !args[0].startsWith("-")) append(args[0], "read", location.cwd, node.text);
      } else if (["grep", "rg", "sed"].includes(head)) {
        const operands = args.filter((arg) => arg !== undefined && !arg.startsWith("-"));
        for (const arg of operands.slice(1))
          append(
            arg,
            head === "sed" && args.some((a) => a === "-i" || a?.startsWith("--in-place")) ? "write" : "read",
            location.cwd,
            node.text,
          );
      }
      for (const child of node.children)
        if (!["command_name", "word", "string", "raw_string", "concatenation", "number"].includes(child.type))
          await walk(child, { cwd: location.cwd });
      return;
    }
    for (const child of node.children ?? []) await walk(child, location);
  };
  try {
    await walk(tree.rootNode, { cwd });
  } finally {
    tree.delete();
  }
  const strongest = new Map<string, ShellAccess>();
  for (const request of requests)
    if (strongest.get(request.path)?.access !== "write") strongest.set(request.path, request);
  return [...strongest.values()];
}
