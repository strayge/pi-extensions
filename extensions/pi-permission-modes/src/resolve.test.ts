import assert from "node:assert/strict";
import os from "node:os";
import test from "node:test";
import { decide, decideBashCommand, decideBashText, expandHome, matchPattern, mostRestrictive, resolveSurface } from "./resolve.ts";
import type { ModeDef } from "./schema.ts";

test("matchPattern: * spans path separators, ? is one char", () => {
  assert.ok(matchPattern("*.md", "foo.md"));
  assert.ok(matchPattern("*.md", "src/deep/foo.md")); // * crosses /
  assert.ok(!matchPattern("*.md", "foo.ts"));
  assert.ok(matchPattern("*", "anything/at/all"));
  assert.ok(matchPattern("file?.txt", "file1.txt"));
  assert.ok(!matchPattern("file?.txt", "file12.txt"));
});

test("matchPattern: wildcards span newlines in multiline bash commands", () => {
  assert.ok(matchPattern("*", "printf one\nprintf two"));
  assert.ok(matchPattern("printf ?", "printf \n"));
});

test("matchPattern: regex metacharacters in the pattern are literal", () => {
  assert.ok(matchPattern("a.b+c", "a.b+c"));
  assert.ok(!matchPattern("a.b+c", "aXbbbc")); // '.' and '+' must be literal
});

test("matchPattern expands configured home aliases and can preserve literal targets", () => {
  const home = os.homedir();
  assert.ok(matchPattern("~/.ssh/*", `${home}/.ssh/id_rsa`));
  assert.ok(matchPattern("$HOME/.aws", `${home}/.aws`));
  assert.equal(matchPattern("$HOME/file", "$HOME/file"), false);
  assert.equal(matchPattern("$HOME/file", "$HOME/file", { expandTarget: true }), true);
  assert.equal(expandHome("~"), home);
  assert.equal(expandHome("$HOME/x"), `${home}/x`);
  assert.equal(expandHome("/abs/path"), "/abs/path");
});

test("direct file policy does not expand a literal $HOME target", () => {
  const home = os.homedir();
  const m = mode({ read: { "*": "allow", "$HOME/*": "deny" } });
  assert.equal(decide(m, "read", "$HOME/file"), "allow");
  assert.equal(decide(m, "read", `${home}/file`), "deny");
});

test("resolveSurface: string shorthand, and last-match-wins in a pattern-map", () => {
  assert.equal(resolveSurface("deny", "anything"), "deny");
  assert.equal(resolveSurface(undefined, "anything"), undefined);
  // "*" first sets the default; the later specific pattern overrides it.
  const map = { "*": "allow", "*.env": "deny" } as const;
  assert.equal(resolveSurface(map, "foo.txt"), "allow");
  assert.equal(resolveSurface(map, "foo.env"), "deny");
  // Order matters: a trailing "*" would clobber the specific rule.
  const bad = { "*.env": "deny", "*": "allow" } as const;
  assert.equal(resolveSurface(bad, "foo.env"), "allow");
});

test("mostRestrictive: deny > ask > allow, undefined ignored", () => {
  assert.equal(mostRestrictive("allow", "ask", "deny"), "deny");
  assert.equal(mostRestrictive("allow", "ask"), "ask");
  assert.equal(mostRestrictive("allow", undefined), "allow");
  assert.equal(mostRestrictive(undefined, undefined), undefined);
});

const mode = (permission: ModeDef["permission"]): ModeDef => ({
  label: "T",
  color: "muted",
  sandbox: { enabled: true, writable: true },
  permission,
});

test("decide: path gate overrides a per-tool allow (most-restrictive)", () => {
  const m = mode({ path: { "*": "allow", "*.env": "deny" }, write: "allow" });
  assert.equal(decide(m, "write", "src/app.ts"), "allow");
  assert.equal(decide(m, "write", "config/.env"), "deny"); // path:deny wins over write:allow
});

test("decide: external_directory folds in only when target is outside", () => {
  const m = mode({ path: { "*": "allow" }, read: "allow", external_directory: "ask" });
  assert.equal(decide(m, "read", "src/app.ts", { isOutside: false }), "allow");
  assert.equal(decide(m, "read", "/etc/passwd", { isOutside: true }), "ask"); // external_directory:ask folds in
});

test("decide: non-file surfaces skip the path gate", () => {
  const m = mode({ path: { "*": "deny" }, web_search: "allow", tool: "allow", skill: "ask" });
  assert.equal(decide(m, "web_search", "query"), "allow"); // path gate does NOT apply
  assert.equal(decide(m, "tool", "some_tool"), "allow");
  assert.equal(decide(m, "skill", "deep-research"), "ask");
});

test("decide: fallback applies when nothing matches", () => {
  const m = mode({ read: "allow" });
  assert.equal(decide(m, "write", "x.ts"), "ask"); // default least-privilege fallback
  assert.equal(decide(m, "write", "x.ts", { fallback: "allow" }), "allow");
});

test("decideBashCommand: path gate binds bash args, not just the joined string", () => {
  const m = mode({ path: { "*": "allow", "*.env": "deny" }, bash: { "*": "allow" } });
  assert.equal(decideBashCommand(m, "cat", [".env"]).pathAction, "deny");
  // The heuristic fallback only matched the whole command line, so a trailing
  // arg used to hide the target; per-token matching closes that.
  assert.equal(decideBashCommand(m, "cat", [".env", "other.txt"]).pathAction, "deny");
  assert.equal(decideBashCommand(m, "cat", ["config/prod.env"]).pathAction, "deny");
  assert.equal(decideBashCommand(m, "ls", ["src"]).pathAction, "allow");
});

test("decideBashCommand: assignment values participate only in path policy", () => {
  const m = mode({
    bash: { "*": "allow", "git status": "deny" },
    path: { "*": "allow", "../secret*": "deny" },
  });
  const decision = decideBashCommand(m, "git", ["status"], ["../secret.txt"]);
  assert.equal(decision.bashAction, "deny", "the effective command still drives Bash policy");
  assert.equal(decision.pathAction, "deny", "the assignment value cannot evade path policy");
});

test("decideBashCommand: bash surface matches the joined name+args string", () => {
  const m = mode({ bash: { "*": "allow", "git push*": "ask", "sudo*": "deny" } });
  assert.equal(decideBashCommand(m, "git", ["push", "origin", "main"]).bashAction, "ask");
  assert.equal(decideBashCommand(m, "git", ["status"]).bashAction, "allow");
  assert.equal(decideBashCommand(m, "sudo", ["rm", "-rf", "/"]).bashAction, "deny");
});

test("decideBashCommand: Bash and path provenance remain independent", () => {
  const m = mode({ bash: { "*": "ask" }, path: { "*": "allow", "*.env": "ask" } });
  assert.deepEqual(decideBashCommand(m, "cat", [".env"]), { bashAction: "ask", pathAction: "ask" });
});

test("decideBashCommand: project overlay path rules tighten bash (most-restrictive)", () => {
  const m = mode({ path: { "*": "allow" }, bash: { "*": "allow" } });
  m.projectOverlay = { path: { "*secrets*": "deny" } };
  assert.equal(decideBashCommand(m, "cat", ["config/secrets/key.pem"]).pathAction, "deny");
  assert.equal(decideBashCommand(m, "cat", ["README.md"]).pathAction, "allow");
});

test("decideBashCommand: undefined when no layer matches (caller picks default)", () => {
  const m = mode({});
  assert.deepEqual(decideBashCommand(m, "ls", []), { bashAction: undefined, pathAction: undefined });
});

test("decideBashText: unmatched fallback asks without changing parsed sparse commands", () => {
  const m = mode({});
  assert.deepEqual(decideBashText(m, "unmatched command"), { bashAction: "ask", pathAction: undefined });

  const pathAllowed = mode({ path: { "*": "allow" } });
  assert.deepEqual(decideBashText(pathAllowed, "unmatched command"), { bashAction: undefined, pathAction: "allow" });
});
