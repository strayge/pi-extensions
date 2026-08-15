import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  canonicalizeSandboxPaths,
  FALLBACK_CONFIG,
  isUnsafeDomain,
  loadModeConfig,
  loadStockDefaults,
  persistModeDomains,
  persistModeRule,
  persistOutsideFileGrant,
  persistProjectOutsideFileGrant,
  persistProjectRule,
  profileToConfig,
  projectGrantCount,
  readOnlyOverride,
  stockDefaultsFile,
} from "./config-load.ts";
import { canonicalizeScope } from "./file-approval.ts";
import { decide } from "./resolve.ts";

/** Build a temp agentDir + cwd, optionally seeding the global/project JSON. */
function sandbox(opts: { global?: unknown; project?: unknown } = {}): {
  cwd: string;
  agentDir: string;
  errors: string[];
  cleanup: () => void;
} {
  const tmpdir = os.tmpdir();
  if (!existsSync(tmpdir)) mkdirSync(tmpdir, { recursive: true });
  const tmp = mkdtempSync(path.join(tmpdir, "permmode-"));
  const agentDir = path.join(tmp, "agent");
  const cwd = path.join(tmp, "project");
  mkdirSync(cwd, { recursive: true });
  if (opts.global !== undefined) {
    const dir = path.join(agentDir, "permission-mode");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      path.join(dir, "permission-mode.json"),
      typeof opts.global === "string" ? opts.global : JSON.stringify(opts.global),
    );
  }
  if (opts.project !== undefined) {
    const dir = path.join(cwd, ".pi");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      path.join(dir, "permission-mode.json"),
      typeof opts.project === "string" ? opts.project : JSON.stringify(opts.project),
    );
  }
  const errors: string[] = [];
  return { cwd, agentDir, errors, cleanup: () => rmSync(tmp, { recursive: true, force: true }) };
}

test("loadStockDefaults: reads the shipped JSON → four modes, correct defaults", () => {
  const errors: string[] = [];
  const c = loadStockDefaults((m) => errors.push(m));
  assert.equal(errors.length, 0, errors.join("; ")); // stock file present & valid
  assert.equal(c.defaultMode, "default");
  assert.deepEqual(c.cycleOrder, ["default", "plan", "build", "yolo"]);
  assert.deepEqual(Object.keys(c.modes).sort(), ["build", "default", "plan", "yolo"]);
  assert.ok(stockDefaultsFile().endsWith("permission-mode.defaults.json"));
});

test("FALLBACK_CONFIG is a valid, safe single-mode config", () => {
  assert.equal(FALLBACK_CONFIG.defaultMode, "default");
  assert.deepEqual(Object.keys(FALLBACK_CONFIG.modes), ["default"]);
  const d = FALLBACK_CONFIG.modes.default;
  assert.equal(d.sandbox.enabled, true); // sandboxed
  assert.equal(decide(d, "bash", "ls"), "ask"); // never silently allows
  assert.equal(decide(d, "write", "x.ts"), "ask");
});

test("loadModeConfig: no files → the four built-in modes", () => {
  const s = sandbox();
  const c = loadModeConfig(s.cwd, s.agentDir, (m) => s.errors.push(m));
  assert.equal(c.defaultMode, "default");
  assert.deepEqual(Object.keys(c.modes).sort(), ["build", "default", "plan", "yolo"]);
  assert.equal(s.errors.length, 0);
  s.cleanup();
});

test("global: full authority — add a mode, redefine a built-in, change defaults", () => {
  const s = sandbox({
    global: {
      defaultMode: "build",
      cycleOrder: ["build", "default", "review"],
      modes: {
        default: { permission: { bash: "deny" } }, // redefine: deny bash in Default
        review: {
          label: "Review",
          color: "mdLink",
          sandbox: { enabled: true, writable: false },
          permission: { bash: "allow", write: "deny" },
        },
      },
    },
  });
  const c = loadModeConfig(s.cwd, s.agentDir, (m) => s.errors.push(m));
  assert.equal(c.defaultMode, "build");
  assert.deepEqual(c.cycleOrder, ["build", "default", "review"]);
  assert.equal(decide(c.modes.default, "bash", "ls"), "deny"); // redefined
  assert.equal(decide(c.modes.default, "read", "x"), "allow"); // untouched surface preserved
  assert.ok(c.modes.review); // new mode added
  assert.equal(c.modes.review.label, "Review");
  s.cleanup();
});

test("warns on array-index-like pattern keys (JS front-loads their order)", () => {
  const s = sandbox({
    global: {
      modes: {
        // "777" would iterate FIRST regardless of file order, silently breaking
        // last-match-wins; the pattern still loads, but the user is told.
        default: { permission: { bash: { "*": "ask", "777": "deny" } } },
      },
    },
  });
  const c = loadModeConfig(s.cwd, s.agentDir, (m) => s.errors.push(m));
  assert.ok(s.errors.some((e) => /bare number/.test(e) && /777/.test(e)));
  assert.equal(decide(c.modes.default, "bash", "777"), "ask"); // "777" reordered before "*" — exactly the trap being warned about
  // Non-index-like numeric-ish keys don't warn.
  const s2 = sandbox({
    global: { modes: { default: { permission: { bash: { "7z*": "allow", "0x*": "allow" } } } } },
  });
  loadModeConfig(s2.cwd, s2.agentDir, (m) => s2.errors.push(m));
  assert.ok(!s2.errors.some((e) => /bare number/.test(e)));
  s.cleanup();
  s2.cleanup();
});

test("project: tighten-only — can tighten, never loosen", () => {
  const s = sandbox({
    project: {
      modes: {
        default: { permission: { bash: "deny", write: "allow" }, sandbox: { enabled: false, writable: false } },
        yolo: { sandbox: { enabled: true } },
      },
    },
  });
  const c = loadModeConfig(s.cwd, s.agentDir, (m) => s.errors.push(m));
  // bash ask → deny: tightened.
  assert.equal(decide(c.modes.default, "bash", "ls"), "deny");
  // write ask + project "allow": most-restrictive overlay can't loosen → stays ask.
  assert.equal(decide(c.modes.default, "write", "x.ts"), "ask");
  // A project cannot disable globally enabled containment.
  assert.equal(c.modes.default.sandbox.enabled, true);
  assert.ok(s.errors.some((e) => /cannot change sandbox\.enabled.*false/.test(e)));
  // Project config also cannot create a new runtime profile by enabling a
  // globally unsandboxed mode.
  assert.equal(c.modes.yolo.sandbox.enabled, false);
  assert.ok(s.errors.some((e) => /cannot change sandbox\.enabled.*true/.test(e)));
  // sandbox writable forced off.
  assert.equal(c.modes.default.sandbox.writable, false);
  s.cleanup();
});

test("trusted project permission entries append after global rules", () => {
  const s = sandbox({
    global: { modes: { default: { permission: { bash: { "*": "ask", "git *": "deny" } } } } },
    project: { modes: { default: { permission: { bash: { "git fetch": "allow", "git fetch *": "allow" } } } } },
  });
  const c = loadModeConfig(s.cwd, s.agentDir, (m) => s.errors.push(m), true);
  const bash = c.modes.default.permission.bash;
  assert.ok(bash && typeof bash !== "string");
  assert.deepEqual(Object.keys(bash), ["*", "git *", "git fetch", "git fetch *"]);
  assert.equal(decide(c.modes.default, "bash", "git fetch origin"), "allow");
  assert.equal(decide(c.modes.default, "bash", "git push origin"), "deny");
  s.cleanup();
});

test("trusted project ask can override a global allow", () => {
  const s = sandbox({
    global: { modes: { default: { permission: { bash: { "*": "ask", "git *": "allow" } } } } },
    project: { modes: { default: { permission: { bash: { "git push *": "ask" } } } } },
  });
  const c = loadModeConfig(s.cwd, s.agentDir, (m) => s.errors.push(m), true);
  assert.equal(decide(c.modes.default, "bash", "git fetch origin"), "allow");
  assert.equal(decide(c.modes.default, "bash", "git push origin"), "ask");
  s.cleanup();
});

test("project: repeating inherited sandbox.enabled is a silent no-op", () => {
  const s = sandbox({
    project: {
      modes: {
        default: { sandbox: { enabled: true } },
        yolo: { sandbox: { enabled: false } },
      },
    },
  });
  const c = loadModeConfig(s.cwd, s.agentDir, (m) => s.errors.push(m));
  assert.equal(c.modes.default.sandbox.enabled, true);
  assert.equal(c.modes.yolo.sandbox.enabled, false);
  assert.ok(!s.errors.some((e) => /sandbox\.enabled/.test(e)));
  s.cleanup();
});

test("project: sandbox intersect/union + unsafe domains rejected", () => {
  const s = sandbox({
    project: {
      modes: {
        build: {
          sandbox: {
            allowWrite: ["."], // intersect with ['.','/tmp'] → ['.']
            denyRead: ["~/.config"], // union
            network: { allowedDomains: ["github.com", "*.com"] }, // *.com rejected
          },
        },
      },
    },
  });
  const c = loadModeConfig(s.cwd, s.agentDir, (m) => s.errors.push(m));
  const sb = c.modes.build.sandbox;
  assert.deepEqual(sb.allowWrite, ["."]); // intersected
  assert.ok(sb.denyRead?.includes("~/.config") && sb.denyRead?.includes("~/.ssh")); // unioned
  assert.deepEqual(sb.network?.allowedDomains, ["github.com"]); // *.com dropped (intersect of safe)
  assert.ok(s.errors.some((e) => /overly-broad/.test(e)));
  s.cleanup();
});

test("project: cannot add a mode or change defaults", () => {
  const s = sandbox({
    project: { defaultMode: "yolo", modes: { hacker: { label: "H", color: "error", sandbox: { enabled: false, writable: true }, permission: {} } } },
  });
  const c = loadModeConfig(s.cwd, s.agentDir, (m) => s.errors.push(m));
  assert.equal(c.defaultMode, "default"); // unchanged
  assert.ok(!c.modes.hacker); // not added
  assert.ok(s.errors.some((e) => /cannot add new mode/.test(e)));
  assert.ok(s.errors.some((e) => /defaultMode\/cycleOrder/.test(e)));
  s.cleanup();
});

test("malformed JSON keeps prior layer and reports the error", () => {
  const s = sandbox({ global: "{ not valid json " });
  const c = loadModeConfig(s.cwd, s.agentDir, (m) => s.errors.push(m));
  assert.deepEqual(Object.keys(c.modes).sort(), ["build", "default", "plan", "yolo"]); // defaults intact
  assert.ok(s.errors.some((e) => /could not parse/.test(e)));
  s.cleanup();
});

test("unknown surface and $schema are handled", () => {
  const s = sandbox({
    global: { $schema: "./x.json", modes: { default: { permission: { bogus: "deny", bash: "deny" } } } },
  });
  const c = loadModeConfig(s.cwd, s.agentDir, (m) => s.errors.push(m));
  assert.equal(decide(c.modes.default, "bash", "ls"), "deny"); // valid surface applied
  assert.ok(s.errors.some((e) => /unknown surface "bogus"/.test(e)));
  s.cleanup();
});

test("readOnlyOverride drops allowWrite; profileToConfig maps fields; isUnsafeDomain", () => {
  assert.deepEqual(readOnlyOverride({ filesystem: { allowWrite: ["."], denyRead: ["~/.ssh"] } }).filesystem, {
    allowWrite: [],
    denyRead: ["~/.ssh"],
  });
  const c = profileToConfig({ enabled: true, writable: true, allowWrite: ["."], denyRead: ["~/.ssh"], denyWrite: [] });
  assert.equal(c.filesystem?.allowWrite?.[0], ".");
  assert.ok(isUnsafeDomain("*") && isUnsafeDomain("*.com") && isUnsafeDomain("http://x"));
  assert.ok(!isUnsafeDomain("*.github.com") && !isUnsafeDomain("github.com"));
});

test("canonicalizeSandboxPaths: resolves symlinked mount points, drops widening ones", () => {
  const tmp = realpathSync(mkdtempSync(path.join(os.tmpdir(), "permmode-fs-")));
  try {
    const store = path.join(tmp, "store");
    mkdirSync(store, { recursive: true });
    const link = path.join(tmp, "link");
    symlinkSync(store, link);
    const wide = path.join(tmp, "sub", "wide");
    mkdirSync(path.dirname(wide), { recursive: true });
    symlinkSync(tmp, wide);

    const errors: string[] = [];
    const out = canonicalizeSandboxPaths(
      { filesystem: { denyRead: [link, wide], allowWrite: [store], denyWrite: [] } },
      (m) => errors.push(m),
    );
    assert.deepEqual(out.filesystem?.denyRead, [store]); // symlink resolved, widening entry dropped
    assert.deepEqual(out.filesystem?.allowWrite, [store]);
    assert.deepEqual(out.filesystem?.denyWrite, []);
    assert.ok(errors.some((e) => e.includes(wide) && /denyRead/.test(e)));

    // Nothing to canonicalize when a config carries no filesystem section.
    assert.deepEqual(canonicalizeSandboxPaths({ network: { allowedDomains: ["x.dev"] } }), {
      network: { allowedDomains: ["x.dev"] },
    });
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("persistModeRule: creates the global file with the learned rule, round-trips", () => {
  const s = sandbox();
  const file = persistModeRule(s.agentDir, "default", "tool", "fooTool", "allow");
  assert.ok(file.endsWith(path.join("permission-mode", "permission-mode.json")));
  const written = JSON.parse(readFileSync(file, "utf-8"));
  // Seeds "*": "ask" so other tools keep prompting, plus the learned allow.
  assert.deepEqual(written.modes.default.permission.tool, { "*": "ask", fooTool: "allow" });
  // The persisted allow takes effect through the normal loader.
  const c = loadModeConfig(s.cwd, s.agentDir, () => {});
  assert.equal(decide(c.modes.default, "tool", "fooTool"), "allow");
  assert.equal(decide(c.modes.default, "tool", "otherTool"), "ask"); // others still prompt
  s.cleanup();
});

test("persistProjectRule omits a fallback, moves duplicates last, and preserves malformed files", () => {
  const s = sandbox();
  const file = persistProjectRule(s.cwd, "default", "bash", "git fetch", "allow");
  let written = JSON.parse(readFileSync(file, "utf-8"));
  assert.deepEqual(written.modes.default.permission.bash, { "git fetch": "allow" });

  writeFileSync(file, JSON.stringify({ modes: { default: { permission: { bash: { "git fetch": "deny", "*": "ask" } } } } }));
  persistProjectRule(s.cwd, "default", "bash", "git fetch", "allow");
  written = JSON.parse(readFileSync(file, "utf-8"));
  assert.deepEqual(Object.keys(written.modes.default.permission.bash), ["*", "git fetch"]);

  writeFileSync(file, "{ malformed");
  assert.throws(() => persistProjectRule(s.cwd, "default", "bash", "git push", "allow"), /malformed config/);
  assert.equal(readFileSync(file, "utf-8"), "{ malformed");
  s.cleanup();
});

test("persistModeDomains: appends to the FULL stock+global allowlist, round-trips", () => {
  const s = sandbox();
  const stockDomains = loadStockDefaults().modes.default.sandbox.network?.allowedDomains ?? [];
  const file = persistModeDomains(s.agentDir, "default", ["api.internal.io"]);
  const written = JSON.parse(readFileSync(file, "utf-8"));
  // mergeGlobal replaces `network` wholesale, so the stock domains must be
  // baked into the persisted list or they'd be lost on the next load.
  const list = written.modes.default.sandbox.network.allowedDomains as string[];
  for (const d of stockDomains) assert.ok(list.includes(d), `stock domain ${d} preserved`);
  assert.ok(list.includes("api.internal.io"));
  const c = loadModeConfig(s.cwd, s.agentDir, () => {});
  assert.ok(c.modes.default.sandbox.network?.allowedDomains?.includes("api.internal.io"));
  assert.ok(c.modes.default.sandbox.network?.allowedDomains?.includes(stockDomains[0]));
  // Idempotent: persisting again doesn't duplicate.
  persistModeDomains(s.agentDir, "default", ["api.internal.io"]);
  const again = JSON.parse(readFileSync(file, "utf-8")).modes.default.sandbox.network.allowedDomains as string[];
  assert.equal(again.filter((d) => d === "api.internal.io").length, 1);
  s.cleanup();
});

test("persistModeDomains: never bakes a project's tightened list into the global config", () => {
  // Project intersects the allowlist down to one domain; a forever-grant made
  // while that project is open must still persist against the UNTIGHTENED base.
  const s = sandbox({ project: { modes: { default: { sandbox: { network: { allowedDomains: ["github.com"] } } } } } });
  const stockDomains = loadStockDefaults().modes.default.sandbox.network?.allowedDomains ?? [];
  const file = persistModeDomains(s.agentDir, "default", ["api.internal.io"]);
  const list = JSON.parse(readFileSync(file, "utf-8")).modes.default.sandbox.network.allowedDomains as string[];
  for (const d of stockDomains) assert.ok(list.includes(d), `stock domain ${d} not lost to project tightening`);
  s.cleanup();
});

test("project: askOnBlockedHost can be forced off (silent deny), never back on", () => {
  const s = sandbox({
    global: { modes: { default: { sandbox: { askOnBlockedHost: false } } } },
    project: { modes: { default: { sandbox: { askOnBlockedHost: true } }, build: { sandbox: { askOnBlockedHost: false } } } },
  });
  const c = loadModeConfig(s.cwd, s.agentDir, (m) => s.errors.push(m));
  assert.equal(c.modes.default.sandbox.askOnBlockedHost, false); // project cannot re-enable asking
  assert.equal(c.modes.build.sandbox.askOnBlockedHost, false); // project may force silent-deny
  s.cleanup();
});

test("projectGrantCount counts only valid grants for known modes and surfaces", () => {
  const s = sandbox({
    project: {
      modes: {
        default: { permission: { bash: { "git": "allow", "git fetch": "invalid" }, write: "allow", bogus: "allow" } },
        unknown: { permission: { bash: "allow" } },
      },
    },
  });
  assert.equal(projectGrantCount(s.cwd), 2);
  s.cleanup();
});

test("trusted project sandbox additions warn once and preserve tighten-only fields", () => {
  const s = sandbox({
    project: {
      modes: {
        default: {
          sandbox: {
            allowWrite: ["/tmp/project-extra"],
            denyRead: ["~/.secret"],
            denyWrite: ["~/.locked"],
            writable: false,
            askOnBlockedHost: false,
            network: { allowedDomains: ["api.example.com", "*.com"], deniedDomains: ["bad.example.com"] },
          },
        },
      },
    },
  });
  const c = loadModeConfig(s.cwd, s.agentDir, (m) => s.errors.push(m), true);
  const sb = c.modes.default.sandbox;
  assert.ok(sb.allowWrite?.includes("/tmp/project-extra"));
  assert.ok(sb.denyRead?.includes("~/.secret"));
  assert.ok(sb.denyWrite?.includes("~/.locked"));
  assert.equal(sb.writable, false);
  assert.equal(sb.askOnBlockedHost, false);
  assert.ok(sb.network?.allowedDomains?.includes("api.example.com"));
  assert.ok(sb.network?.deniedDomains?.includes("bad.example.com"));
  assert.equal(s.errors.filter((e) => e.includes('"*.com"')).length, 1);
  assert.equal(sb.enabled, true);
  s.cleanup();
});

test("typed outside-file grants round-trip globally and for trusted projects", () => {
  const s = sandbox();
  const globalFile = persistOutsideFileGrant(s.agentDir, "default", "read", { kind: "glob", value: "/tmp/*" });
  const projectFile = persistProjectOutsideFileGrant(s.cwd, "default", "write", { kind: "exact", value: "/tmp/out" });
  assert.ok(existsSync(globalFile) && existsSync(projectFile));
  const trusted = loadModeConfig(s.cwd, s.agentDir, (m) => s.errors.push(m), true);
  assert.deepEqual(trusted.modes.default.outsideFileGrants?.read, [{ kind: "glob", value: "/tmp/*" }]);
  assert.deepEqual(trusted.modes.default.trustedProjectOutsideFileGrants?.write, [{ kind: "exact", value: "/tmp/out" }]);
  assert.equal(projectGrantCount(s.cwd, s.agentDir), 1);
  const untrusted = loadModeConfig(s.cwd, s.agentDir, (m) => s.errors.push(m), false);
  assert.equal(untrusted.modes.default.trustedProjectOutsideFileGrants, undefined);
  assert.ok(s.errors.some((error) => /untrusted project mode/.test(error)));
  s.cleanup();
});

test("stored outside-file grants stay bound when a target is later replaced by a symlink", () => {
  const s = sandbox();
  const fixedTarget = path.join(s.cwd, "fixed.txt");
  const replacementTarget = path.join(s.cwd, "replacement.txt");
  const laterTarget = path.join(s.cwd, "later.txt");
  writeFileSync(fixedTarget, "fixed");
  writeFileSync(replacementTarget, "replacement");
  writeFileSync(laterTarget, "later");
  const bound = canonicalizeScope({ kind: "exact", value: fixedTarget }, s.cwd);
  assert.deepEqual(bound, { kind: "exact", value: fixedTarget });
  persistOutsideFileGrant(s.agentDir, "default", "read", bound!);

  rmSync(fixedTarget);
  symlinkSync(replacementTarget, fixedTarget);

  const reloaded = loadModeConfig(s.cwd, s.agentDir, (m) => s.errors.push(m));
  assert.deepEqual(reloaded.modes.default.outsideFileGrants?.read, [{ kind: "exact", value: fixedTarget }]);
  assert.notEqual(reloaded.modes.default.outsideFileGrants?.read?.[0]?.value, replacementTarget);

  // The approval bound `fixedTarget` before the replacement. Persistence must
  // not resolve that value again and turn it into the replacement target.
  persistOutsideFileGrant(s.agentDir, "default", "read", bound!);
  persistOutsideFileGrant(s.agentDir, "default", "read", { kind: "exact", value: laterTarget });
  const saved = JSON.parse(readFileSync(path.join(s.agentDir, "permission-mode", "permission-mode.json"), "utf-8"));
  assert.deepEqual(saved.modes.default.outsideFileGrants.read, [
    { kind: "exact", value: fixedTarget },
    { kind: "exact", value: laterTarget },
  ]);
  s.cleanup();
});

test("outside-file loader drops malformed, universal, and duplicate grants safely", () => {
  const s = sandbox({
    global: {
      modes: {
        default: {
          outsideFileGrants: {
            read: [
              { kind: "glob", value: "/tmp/*" },
              { kind: "glob", value: "/tmp/*" },
              { kind: "glob", value: "/*" },
              { kind: "glob", value: "/?*" },
              { kind: "glob", value: "/*?" },
              { kind: "glob", value: "?*" },
              { kind: "glob", value: "/tmp/../?*" },
              { kind: "glob", value: "*" },
              { kind: "bad", value: "/tmp/x" },
              { kind: "exact", value: "/tmp/literal*" },
              { kind: "tree", value: "/tmp/literal*" },
              { kind: "glob", value: "relative/*" },
              { kind: "exact", value: "\u0000" },
            ],
          },
        },
      },
    },
  });
  const c = loadModeConfig(s.cwd, s.agentDir, (m) => s.errors.push(m));
  assert.deepEqual(c.modes.default.outsideFileGrants?.read, [
    { kind: "glob", value: "/tmp/*" },
    { kind: "exact", value: "/tmp/literal*" },
    { kind: "tree", value: "/tmp/literal*" },
  ]);
  assert.ok(s.errors.some((error) => /malformed|root-wide/.test(error)));
  s.cleanup();
});

test("typed grant persistence preserves schema and unrelated mode policy, and refuses malformed JSON", () => {
  const s = sandbox({
    global: {
      $schema: "./custom-schema.json",
      modes: { default: { permission: { bash: { "git *": "deny" } } } },
    },
  });
  const file = path.join(s.agentDir, "permission-mode", "permission-mode.json");
  assert.equal(persistOutsideFileGrant(s.agentDir, "default", "read", { kind: "exact", value: "/tmp/file" }), file);
  const saved = JSON.parse(readFileSync(file, "utf-8"));
  assert.equal(saved.$schema, "./custom-schema.json");
  assert.deepEqual(saved.modes.default.permission.bash, { "git *": "deny" });
  assert.deepEqual(saved.modes.default.outsideFileGrants.read, [{ kind: "exact", value: "/tmp/file" }]);
  for (const value of ["/?*", "/*?", "?*", "/tmp/../?*"]) {
    assert.throws(
      () => persistOutsideFileGrant(s.agentDir, "default", "read", { kind: "glob", value }),
      /invalid|root-wide/,
    );
  }
  writeFileSync(file, "{ malformed");
  assert.throws(
    () => persistOutsideFileGrant(s.agentDir, "default", "read", { kind: "glob", value: "/tmp/*" }),
    /malformed config/,
  );
  assert.equal(readFileSync(file, "utf-8"), "{ malformed");
  s.cleanup();
});

test("persistModeRule: converts a string surface to a map and preserves other content", () => {
  const s = sandbox({
    global: { $schema: "./x.json", modes: { default: { permission: { tool: "allow", bash: "deny" } } } },
  });
  // Write the user's existing global file first (sandbox() only seeds it in memory if given).
  const dir = path.join(s.agentDir, "permission-mode");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, "permission-mode.json"),
    JSON.stringify({ $schema: "./x.json", modes: { default: { permission: { tool: "allow", bash: "deny" } } } }),
  );
  const file = persistModeRule(s.agentDir, "default", "tool", "fooTool", "allow");
  const written = JSON.parse(readFileSync(file, "utf-8"));
  assert.equal(written.$schema, "./x.json"); // preserved
  assert.equal(written.modes.default.permission.bash, "deny"); // preserved
  assert.deepEqual(written.modes.default.permission.tool, { "*": "allow", fooTool: "allow" }); // string→map
  s.cleanup();
});
