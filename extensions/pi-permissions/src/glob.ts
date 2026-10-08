/** A Thompson automaton keeps sequential brace alternatives linear instead of expanding products. */
type Edge = { to: number; byte?: number; test?: (byte: number) => boolean };
type State = Edge[];
export type GlobMode = "fd" | "rg";

export function compileGlob(pattern: string, mode: GlobMode, signal?: AbortSignal): (candidate: string) => boolean {
  signal?.throwIfAborted();
  const insensitive = mode === "fd" && !/[A-Z]/.test(pattern);
  const source = Buffer.from(insensitive ? pattern.replace(/[A-Z]/g, (c) => c.toLowerCase()) : pattern).toString(
    "latin1",
  );
  const states: State[] = [];
  const state = () => {
    states.push([]);
    return states.length - 1;
  };
  const epsilon = (from: number, to: number) => states[from]!.push({ to });
  let offset = 0;
  const parse = (depth = 0): [number, number] => {
    const begin = state();
    let end = begin;
    while (offset < source.length) {
      signal?.throwIfAborted();
      const c = source[offset++]!;
      if (depth && (c === "," || c === "}")) {
        offset--;
        break;
      }
      const next = state();
      if (c === "{") {
        if (mode === "rg" && depth) throw new Error("Invalid glob: nested alternate groups are not allowed");
        // A depth cap prevents stack overflow without restricting ordinary sequential alternates.
        if (depth > 128) throw new Error("Glob nesting exceeds the safe parser depth");
        for (;;) {
          const [a, b] = parse(depth + 1);
          epsilon(end, a);
          epsilon(b, next);
          const separator = source[offset++];
          if (separator === "}") break;
          if (separator !== ",") throw new Error("Invalid glob: unclosed alternate group");
        }
      } else if (c === "}") {
        throw new Error("Invalid glob: unopened alternate group");
      } else if (c === "*") {
        let globstar = false;
        if (source[offset] === "*") {
          offset++;
          globstar = true;
        }
        if (globstar && source[offset] === "/" && (offset === 2 || source[offset - 3] === "/")) {
          offset++;
          // A recursive prefix consumes whole directories or nothing.
          const loop = state();
          epsilon(end, next);
          epsilon(end, loop);
          states[loop]!.push({ to: loop, test: () => true }, { to: next, byte: 47 });
        } else {
          epsilon(end, next);
          states[end]!.push({ to: end, test: (b) => globstar || b !== 47 });
        }
      } else if (c === "?") {
        states[end]!.push({ to: next, test: (b) => b !== 47 });
      } else if (c === "[") {
        let negate = false;
        if (source[offset] === "!" || source[offset] === "^") {
          negate = true;
          offset++;
        }
        const members: number[] = [];
        if (source[offset] === "]") members.push(source.charCodeAt(offset++));
        while (offset < source.length && source[offset] !== "]") {
          let code = source.charCodeAt(offset++);
          if (code === 92 && offset < source.length) code = source.charCodeAt(offset++);
          members.push(code);
        }
        if (source[offset++] !== "]" || !members.length)
          throw new Error("Invalid glob: unclosed or empty character class");
        const allowed = new Set<number>();
        for (let i = 0; i < members.length; i++) {
          if (members[i + 1] === 45 && members[i + 2] !== undefined) {
            const from = members[i]!;
            const to = members[i + 2]!;
            if (from > to) throw new Error("Invalid glob: reversed character range");
            for (let value = from; value <= to; value++) allowed.add(value);
            i += 2;
          } else allowed.add(members[i]!);
        }
        states[end]!.push({ to: next, test: (b) => b !== 47 && (negate ? !allowed.has(b) : allowed.has(b)) });
      } else {
        let byte = c.charCodeAt(0);
        if (c === "\\") {
          if (offset === source.length) throw new Error("Invalid glob: dangling escape");
          byte = source.charCodeAt(offset++);
        }
        states[end]!.push({ to: next, byte });
      }
      end = next;
    }
    return [begin, end];
  };
  const [begin, end] = parse();
  const closure = (initial: Set<number>) => {
    const result = new Set(initial);
    const queue = [...initial];
    for (let i = 0; i < queue.length; i++) {
      for (const edge of states[queue[i]!]!)
        if (edge.byte === undefined && !edge.test && !result.has(edge.to)) {
          result.add(edge.to);
          queue.push(edge.to);
        }
    }
    return result;
  };
  return (candidate) => {
    signal?.throwIfAborted();
    if (mode === "fd" && !pattern) return true;
    const bytes = Buffer.from(insensitive ? candidate.replace(/[A-Z]/g, (c) => c.toLowerCase()) : candidate);
    let current = closure(new Set([begin]));
    for (const byte of bytes) {
      signal?.throwIfAborted();
      const next = new Set<number>();
      for (const index of current)
        for (const edge of states[index]!) if (edge.byte === byte || edge.test?.(byte)) next.add(edge.to);
      current = closure(next);
      if (!current.size) return false;
    }
    return current.has(end);
  };
}
