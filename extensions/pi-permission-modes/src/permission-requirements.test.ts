import assert from "node:assert/strict";
import test from "node:test";
import { buildFileRequirements, evaluateRequirements, grantMatchesRequirement } from "./permission-requirements.ts";
import { normalizePiTarget } from "./paths.ts";
import type { ModeDef } from "./schema.ts";

const mode = (permission: ModeDef["permission"]): ModeDef => ({
  label: "Test",
  color: "muted",
  sandbox: { enabled: true, writable: true },
  permission,
});

const target = normalizePiTarget("/tmp/permission-file", "/");

test("file requirements preserve sparse fallback and independent surfaces", () => {
  const sparse = buildFileRequirements(mode({}), "write", target, true);
  assert.deepEqual(sparse.map((requirement) => [requirement.permission, requirement.action]), [["write", "ask"]]);

  const configured = buildFileRequirements(
    mode({ path: "ask", external_directory: "ask", write: "ask" }),
    "write",
    target,
    true,
  );
  assert.deepEqual(
    configured.map((requirement) => [requirement.permission, requirement.action]),
    [["path", "ask"], ["external_directory", "ask"], ["write", "ask"]],
  );
});

test("evaluation allows and denies independently, and grants satisfy asks only", () => {
  const requirements = buildFileRequirements(
    mode({ path: "ask", external_directory: "ask", write: "ask" }),
    "write",
    target,
    true,
  );
  const grants = requirements.map((requirement) =>
    requirement.kind === "path" ? { permission: requirement.permission, scope: { kind: "exact" as const, value: target.canonicalTarget } } : undefined,
  ).filter((grant): grant is { permission: "path" | "external_directory" | "write"; scope: { kind: "exact"; value: string } } => grant !== undefined);
  assert.deepEqual(evaluateRequirements(requirements, grants), { denied: [], pending: [] });

  const denied = buildFileRequirements(mode({ path: "deny", write: "ask" }), "write", target, false);
  const result = evaluateRequirements(denied, [{ permission: "path", scope: { kind: "exact", value: target.canonicalTarget } }]);
  assert.equal(result.denied.length, 1);
  assert.equal(result.pending.length, 1); // dispatcher blocks on any deny before using this pending ask

  assert.equal(
    grantMatchesRequirement(
      { permission: "external_directory", scope: { kind: "exact", value: target.canonicalTarget } },
      { kind: "path", permission: "write", displayTarget: target.displayTarget, canonicalTarget: target.canonicalTarget, action: "ask" },
    ),
    false,
  );
});

test("canonical target matching is used without changing raw policy identity", () => {
  const linkTarget = normalizePiTarget("/tmp/permission-file", "/");
  const requirement = {
    kind: "path" as const,
    permission: "read" as const,
    displayTarget: "/tmp/permission-file",
    canonicalTarget: linkTarget.canonicalTarget,
    action: "ask" as const,
  };
  assert.equal(
    grantMatchesRequirement(
      { permission: "read", scope: { kind: "exact", value: linkTarget.canonicalTarget } },
      requirement,
    ),
    true,
  );
});

test("project deny stays a deny even when a global grant matches", () => {
  const m = mode({ write: "allow" });
  m.projectOverlay = { write: "deny" };
  const requirements = buildFileRequirements(m, "write", target, false);
  const result = evaluateRequirements(requirements, [{ permission: "write", scope: { kind: "exact", value: target.canonicalTarget } }]);
  assert.equal(result.denied.length, 1);
  assert.equal(result.pending.length, 0);
});
