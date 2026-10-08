import { assertBinding, bindFile, contains, resolvePermissionBinding, within } from "./paths.ts";
import { assertNativeSemantics } from "./native-semantics.ts";
import type { Access, FilesystemSnapshot, PathBinding, PermissionBinding, ResolvedRule, RuleAction } from "./schema.ts";

export interface Decision {
  action: RuleAction;
  directory: boolean;
  exceptions: { rule: ResolvedRule; access: Access }[];
}
interface Candidate { boundary: string; action: RuleAction; rule?: ResolvedRule; receipt?: Access }
interface Outcome { action: RuleAction | "missing"; exceptions: Decision["exceptions"] }
const activated = new WeakMap<PermissionBinding, PermissionBinding>();

/** Dormant positives never fabricate host objects; activation pins their newly valid boundary. */
export function positiveTarget(binding: PermissionBinding | undefined, scope: "file" | "tree"): { state: "active" | "dormant" | "blocked"; binding?: PathBinding; reason?: string } {
  if (!binding) return { state: "blocked", reason: "No validated target binding" };
  try {
    const pinned = activated.get(binding) ?? binding;
    const current = resolvePermissionBinding(pinned, true);
    if (current.missing.length) return { state: "dormant" };
    if (current.identity.type !== (scope === "file" ? "file" : "directory")) return { state: "blocked", reason: "target type does not match declared scope" };
    if ("parent" in pinned ? pinned.parent.missing.length : pinned.missing.length)
      activated.set(binding, scope === "file" ? bindFile(current) : current);
    return { state: "active", binding: current };
  } catch (error) { return { state: "blocked", reason: String(error) }; }
}
function matchesRestriction(rule: ResolvedRule, binding: PathBinding, target: PathBinding): boolean {
  if (!rule.binding) return false;
  if (process.platform === "darwin" && binding.missing.length && target.missing.length && within(binding.prefix, target.canonical)) return true;
  return contains(rule.binding, target, rule.scope) || (rule.scope === "file" ? rule.binding.lexical === target.lexical : within(rule.binding.lexical, target.lexical));
}
function winner(candidates: Candidate[], baseline: boolean): Outcome {
  if (!candidates.length) return { action: baseline ? "allow" : "missing", exceptions: [] };
  const depth = (boundary: string) => boundary.split("/").filter(Boolean).length;
  const closest = Math.max(...candidates.map((c) => depth(c.boundary)));
  const winning = candidates.filter((c) => depth(c.boundary) === closest);
  if (winning.some((c) => c.action === "deny")) return { action: "deny", exceptions: [] };
  const exceptions = winning.filter((c) => c.action === "ask").map((c) => ({ rule: c.rule!, access: c.receipt! }));
  return { action: exceptions.length ? "ask" : "allow", exceptions };
}

/** Read-only exceptions cannot revive baseline writes suppressed by broader read restrictions. */
export function decide(snapshot: FilesystemSnapshot, target: PathBinding, access: Access, proposed?: { scope: "file" | "tree"; access: Access; binding: PermissionBinding }): Decision {
  assertBinding(snapshot.root.binding);
  if (snapshot.profile.kind === "unrestricted") return { action: "allow", directory: false, exceptions: [] };
  assertNativeSemantics(target);
  const read: Candidate[] = []; const write: Candidate[] = [];
  for (const rule of snapshot.rules) {
    const negative = rule.read === "deny" || rule.read === "ask" || rule.write === "deny" || rule.write === "ask";
    if (!rule.binding) {
      if (negative) throw new Error(`Restriction has no validated target: ${rule.path}`);
      continue;
    }
    const positive = positiveTarget(rule.binding, rule.scope);
    const binding = negative ? resolvePermissionBinding(rule.binding, true) : positive.binding;
    if (!binding) continue;
    const restricts = negative && matchesRestriction(rule, binding, target);
    const allows = positive.state === "active" && contains(rule.binding, target, rule.scope);
    if (!restricts && !allows) continue;
    assertNativeSemantics(binding);
    const approved = (operation: Access) => snapshot.exceptions.some((e) => e.ruleId === rule.id && e.access === operation);
    const boundary = rule.binding.canonical;
    const add = (to: Candidate[], action: RuleAction, receipt?: Access) => to.push({ boundary, action, rule, receipt });
    if (restricts && rule.read === "deny") { add(read, "deny"); add(write, "deny"); }
    else if (restricts && rule.read === "ask" && !approved("read")) { add(read, "ask", "read"); add(write, "ask", "read"); }
    else if (allows && (rule.read === "allow" || (rule.read === "ask" && approved("read")))) add(read, "allow");
    if (restricts && rule.write === "deny") add(write, "deny");
    else if (restricts && rule.write === "ask" && !approved("write")) {
      add(write, "ask", "write");
      if (access === "write") add(read, "ask", "write");
    } else if (allows && (rule.write === "allow" || (rule.write === "ask" && approved("write")))) { add(write, "allow"); add(read, "allow"); }
  }
  for (const grant of snapshot.grants) {
    const scope = "parent" in grant.binding ? "file" : "tree";
    resolvePermissionBinding(grant.binding);
    if (!contains(grant.binding, target, scope)) continue;
    read.push({ boundary: grant.binding.canonical, action: "allow" });
    if (grant.access === "write") write.push({ boundary: grant.binding.canonical, action: "allow" });
  }
  if (proposed && contains(proposed.binding, target, proposed.scope)) {
    read.push({ boundary: proposed.binding.canonical, action: "allow" });
    if (proposed.access === "write") write.push({ boundary: proposed.binding.canonical, action: "allow" });
  }
  const baseline = (operation: Access) => snapshot.profile.grants.some((g) => {
    if (operation === "write" && g.access !== "write") return false;
    return contains(g.binding, target, g.scope) && positiveTarget(g.binding, g.scope).state === "active";
  });
  const outcomes = [winner(read, baseline("read")), ...(access === "write" ? [winner(write, baseline("write"))] : [])];
  if (outcomes.some((o) => o.action === "deny")) return { action: "deny", directory: false, exceptions: [] };
  const exceptions = outcomes.flatMap((o) => o.exceptions).filter((e, i, all) => all.findIndex((a) => a.rule.id === e.rule.id && a.access === e.access) === i);
  const directory = outcomes.some((o) => o.action === "missing");
  return { action: directory || exceptions.length ? "ask" : "allow", directory, exceptions };
}
