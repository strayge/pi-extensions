# Project-scoped permission rules for pi-permission-modes

## Context

Today the only way to make a permission grant outlive a session is "Allow
forever", which exists on exactly two prompts (first use of a skill or an
extension tool) and always writes to the **global** config. Bash never offers
it at all. The project layer `.pi/permission-mode.json` is tighten-only by
construction — `resolve.ts` folds it in with `mostRestrictive` — so an `allow`
written there is provably ignored.

The result is that a per-project working rule like "in this repo, `git fetch`
and `npm test` are fine, everything else still asks" cannot be expressed. The
user's choice is between re-approving every session and granting a command
globally across every project.

This change makes the project file able to grant when the project is trusted,
keeps global and project rules composing rather than replacing, and puts a
"save to this project" option on the bash prompt with subcommand-level
precision (`git fetch *` allowed, `git push` still asks).

## Decisions taken

- **One file.** `.pi/permission-mode.json` keeps its current schema. Untrusted
  → today's tighten-only overlay. Trusted → full authority over the keys below.
- **Trust gate is `ctx.isProjectTrusted()`** (`dist/core/extensions/types.d.ts:234`),
  nothing else. Documented limitation below.
- **Project authority:** all of `permission`, plus `sandbox.network.allowedDomains`,
  `allowWrite`, `denyWrite`, `denyRead`. `sandbox.enabled`, `defaultMode`,
  `cycleOrder` and new modes stay global-only, ignored with a warning as today.
- **Session grants become patterns**, the same patterns that get saved, so
  "allow for session" can no longer be broader than a rule you would write down.

## Changes

### 1. `src/config-load.ts` — the trusted project layer

`loadModeConfig(cwd, agentDir, onError, projectTrusted = false)`. All four call
sites in `index.ts` (network persist, `learnForever`, `request_network_access`,
`session_start`) have a `ctx` and pass `ctx.isProjectTrusted()`.

`applyProject` branches on `projectTrusted`:

- **Untrusted** — unchanged: `base.projectOverlay = cleanPermission(…)` and
  `tightenSandbox`.
- **Trusted** — merge per surface into `base.permission` with a new
  `appendPatterns(base, over)`:
  - normalize a string shorthand to `{"*": value}` on both sides;
  - append the project's entries **after** the global's, deleting a duplicate
    key first so it moves to the end (`resolveSurface` is last-match-wins and
    JS keeps a re-assigned key in its original slot).
  - Sandbox lists are **unioned** (`allowedDomains`, `allowWrite`, `denyRead`,
    `denyWrite`) rather than intersected, so a trusted project can add.

  Surface-level replacement is specifically wrong here: dropping the global's
  `"*": "ask"` would leave commands matching nothing, and the bash chain path
  defaults an unmatched command to `allow` (`index.ts`, `decideBashCommand(…) ?? "allow"`).

New writer `persistProjectRule(cwd, modeName, surface, key, action)` targeting
`<cwd>/.pi/permission-mode.json`. Extract the JSON surgery currently inside
`persistModeRule` into a shared `writeRuleInto(file, …)` — with one difference
the plan depends on: **the project writer must not seed `"*": "ask"`.** The
global writer seeds it so unlisted names keep prompting; in a project file that
same key lands last in the merged map and would override a global `allow`.

### 2. `src/approvals.ts` — patterns, and a richer result

- `SessionApprovals.has` matches stored patterns with `matchPattern` from
  `resolve.ts` instead of `Set.has`. Storage shape is unchanged; a literal
  target (a file path) is still a valid pattern, so the file surfaces keep
  working untouched.
- Split the prompt: `askApproval(...)` returns the chosen scope
  (`once | session | forever-global | forever-project | deny`) and does no
  remembering. `askWithSession` stays as a thin wrapper preserving today's
  behavior — check targets, remember the same targets — for skill, tool,
  web_search and the file surfaces. Bash uses `askApproval` directly because
  what it remembers (a pattern) differs from what it checked (the command).

### 3. `src/index.ts` — the bash prompt

Pattern derivation from an extracted command (`name`, `args`):

- `narrow` — `` `${name} ${sub}*` `` when the first arg is a subcommand (does not
  start with `-`), else `name` + `` `${name} *` ``.
- `broad` — `name` + `` `${name} *` ``. Both keys, because `"git *"` does not
  match a bare `git`.

Flow, keeping the common path at one keypress:

1. First select: `Allow once` · `Allow for session` · `Always allow…` · `Deny`.
   `Allow for session` remembers `narrow` per pending command — no second
   prompt.
2. `Always allow…` opens a second select. One pending command → the four
   combinations, e.g. for `git fetch origin`:
   `git fetch * — this project` · `git fetch * — all projects` ·
   `git * — this project` · `git * — all projects`.
   Several pending commands → two entries at `broad` granularity covering all
   of them (`cd, git, head — this project` / `— all projects`).
3. Dismissing either select denies the call, matching how a dismissed prompt
   behaves today.

"this project" entries appear only when `ctx.isProjectTrusted()`; otherwise the
menu is global-only. Saving also remembers the pattern for the session and
hot-reloads `config` through `loadModeConfig`, as `learnForever` already does.

### 4. `/perm` additions

- `/perm allow [-p|-g] [<surface>] <pattern>` — write a rule without waiting for
  a prompt; defaults to the `bash` surface and `-g`.
- `/perm init -p` — scaffold `.pi/permission-mode.json` with `$schema` and an
  empty `modes` map (the existing `init` keeps writing the global file).
- Extend the `/perm` description string and the `clear-approvals` neighbours.

### 5. `schemas/permission-mode.schema.json`

Already describes the shared shape; add a note that `sandbox.enabled`,
`defaultMode`, `cycleOrder` and new modes are ignored in a project file.

### 6. README

Rewrite the "Session approvals" and project-layer sections: the trusted/untrusted
split, the merge-not-replace rule, the bash pattern examples (`git fetch*` allowed
while `git push` asks), why a project file must not carry `"*"`, and the
limitation below.

## Documented limitation

`.pi/permission-mode.json` is not in pi's list of trust-triggering resources
(`vendor/docs/security.md:11-14`) and `projectTrusted` defaults to `true`
(`dist/core/settings-manager.js:150`). In a repo with no other `.pi/` resource,
pi never asks about trust, so grants in a cloned repo's file apply unasked.
Mitigation kept cheap per the decision above: on `session_start`, when a trusted
project file contributes any `allow`, notify once —
`permission-mode: honoring N project grants from .pi/permission-mode.json` — so
it is visible rather than silent. README states this plainly.

## Verification

- `node --test --experimental-strip-types src/*.test.ts` from
  `extensions/pi-permission-modes` (baseline is 141 tests). New coverage:
  - `config-load.test.ts` — trusted merge appends and keeps the global `"*"`;
    untrusted keeps tighten-only; `sandbox.enabled` still refused when trusted;
    sandbox lists union when trusted, intersect when not; `persistProjectRule`
    does not seed `"*"`.
  - `approvals.test.ts` — pattern `has` (`git fetch*` covers `git fetch origin`,
    not `git push`); literal path keys still exact.
  - `resolve.test.ts` — a merged map resolves project-after-global correctly,
    including a project `ask` overriding a global `allow`.
  - `index.test.ts` — the two-step bash prompt writes `.pi/permission-mode.json`
    in a temp project, the rule survives a reload, a second run of the same
    command is silent, and a sibling subcommand still prompts. `makeCtx` gains
    `isProjectTrusted`, defaulting true with an opt-out for the untrusted cases.
- `npx tsc --noEmit` and `npx biome check src/` (one pre-existing warning in
  `bash-parse.test.ts`).
- Real load: `pi -e "$PWD/extensions/pi-permission-modes/src/index.ts" --no-session
  --model openai-codex/gpt-5.6-luna:low -p 'reply with just: ok'`.
- Manual: in this repo, run `git status`, pick `Always allow… → git * — this
  project`, confirm `.pi/permission-mode.json` appears, then `git log` runs
  silently while `curl example.com` still prompts.
