# pi-permission-modes

Switchable, **user-definable** permission modes for the [pi](https://pi.dev)
coding agent. Each mode is a JSON bundle of an **OS-level sandbox profile**
(bubblewrap / `sandbox-exec`) plus an **allow / ask / deny policy** across every
surface (bash, file tools, the project boundary, web search, extension tools,
skills). Bash gating uses a real **tree-sitter** AST, not a regex.

Four modes ship by default — **Default → Plan Mode → Build → YOLO** — and you can
retune them or add your own in `permission-mode.json`.

---

## Installation

```bash
pi install npm:@strayge/pi-permission-modes
```

Requires Node.js >=22.19.0 and pi.

`pi install` fetches the package and runs `npm install` for you, so
`@anthropic-ai/sandbox-runtime` comes along automatically; the pi SDK is
provided by the host. Useful variants:

- `pi install npm:@strayge/pi-permission-modes@0.0.1` — pin a version (`pi update` won't advance it)
- `pi install -l npm:@strayge/pi-permission-modes` — project-local install (`.pi/npm/`, shareable with your team)
- `pi update --extensions` — pull the latest release later

For development, load this checkout directly:

```bash
pi -e ./src/index.ts
```

On **Linux** (including **WSL2**) the sandbox also needs three system packages on
`PATH`:

```bash
# Debian / Ubuntu / WSL2
sudo apt install -y bubblewrap socat ripgrep
```

- `bubblewrap` — provides the `bwrap` binary that confines bash (the package is
  `bubblewrap`, the executable is `bwrap`).
- `socat` — network filtering; without it the sandbox fails to init and the
  sandboxed modes fall back to prompting.
- `ripgrep` — provides `rg`.

On **macOS** the sandbox uses the built-in `sandbox-exec` — no extra packages.
Native **Windows** is unsupported (modes degrade to prompting); run pi under WSL
for OS-level enforcement.

### Verify

1. Start pi in any project — the footer shows a mode indicator, e.g. `Default`.
2. Switch to Build (`shift+tab` until `Build`, or `/perm build`):
   - sandbox active → `Build (sandboxed in project dir)`;
   - otherwise → `Build (!) sandbox-runtime missing ...` plus a fix-it notification.
3. `/sandbox` prints the active sandbox configuration (or why it's unavailable).

---

## Modes

Cycle with **`shift+tab`** or set directly with **`/perm <mode>`**. The current mode
is persisted per session (survives `/reload`, resume, and branch navigation) and
shown in the footer.

Default, Plan Mode, and Build all run in-project `bash` inside the OS sandbox.
The footer shows the mode, and a network chip only when the network is *not* in
the state the mode asked for — so a bare `Build` means the allowlist is
filtering, and `Build  Network: open` (green) means it was lifted for the
session (see [Network](#network)). A mode whose sandbox is unavailable reports
`Network: open` too — the missing filtering is unintended there — plus a `(!)`
warning when the reason is known (`--no-sandbox` is not one);
`/sandbox` prints the full state. Only YOLO is unsandboxed. Labels are plain text
(no icons); `shift+tab` cycles in the order below. The table describes the **shipped defaults** — every mode is data and can
be retuned, and you can add your own, in `permission-mode.json` (see
[Configuration](#configuration)).

#### Statusline slots

Both chips are also published as statusline slots, so an extension implementing
the slot protocol can place each one exactly where you want instead of taking
the pair as one blob:

| Slot id | Shows |
|---------|-------|
| `perm` | the mode label, in the mode's own color, with `(!) <reason>` folded in when the sandbox is unavailable |
| `perm-network` | the network chip, published only when there is one — cleared otherwise |

`perm` deliberately matches the `ctx.ui.setStatus` key, so a statusline renders
the slot instead of repeating the same text in its catch-all row, and a stock pi
footer still sees the combined chip. Placing `perm-network` while leaving `perm`
unplaced is the one layout that shows the network twice — place both, or
neither.

Both ask for the last line by default, so they land where the catch-all sits in
a stock layout, colored per mode, with no config from you. Name either slot
explicitly to put it elsewhere.

| Mode | Behavior |
|------|----------|
| **Default** | Confirm every `bash`/`edit`/`write`; reads are free. Approved **in-project** `bash` runs **sandboxed** (writes confined to the project). |
| **Plan Mode** | Planning mode. Reads are free; in-project `bash` runs **sandboxed read-only** (writes/deletes fail), so only read commands effectively work. The one mutation allowed without confirmation is **creating/editing Markdown** (`*.md`/`*.markdown`) inside the project — other `edit`/`write` are blocked. A system-prompt addition steers the model: for a planning task, write the plan to `docs/plans/<YYYY-MM-DD>_<description>.md`, render it for review with the **`show_plan`** tool, then ask you to switch to Build to apply it. |
| **Build** | Reads, writes, and `bash` **inside the project** run with no confirmation; in-project `bash` runs **sandboxed**. |
| **YOLO** | Never prompts, never sandboxes, no protected-path backstop. Can do anything the current user can. |

In every mode except YOLO: **out-of-project** access prompts. File-tool prompts show
both the original request and an editable scope. The scope editor offers the exact
path, progressively broader recursive directory trees, and a validated custom
pattern. `*` includes descendants at any depth. The prompt offers **Remember for
this project** only in trusted projects and **Remember globally** only when project
policy does not tighten the target. Root-wide scopes such as `/*` and `*` are
neither suggested nor accepted by this prompt. `bash` that reaches outside
the project or **escalates privileges**
(`su`/`sudo`/`doas`/`pkexec`/`runuser`/`setpriv`/`chroot` — detected even
through wrappers like `env`/`nice`/`xargs` and `bash -c '…'` scripts) prompts,
and runs **unsandboxed** once you approve it; and `edit`/`write` to
**protected paths** (`.git/`, `.env`, dotfiles, … — see
[below](#how-protection-works)) are hard-blocked.

> **When the sandbox is unavailable** (missing dependency, init failure,
> `--no-sandbox`, or malformed/unsafe Git metadata): Default/Plan/Build show
> `(!) <reason>` in the footer, and in-project `bash` that would have been
> sandboxed instead **prompts** for confirmation — you are never silently
> unprotected.

> **Sandbox placeholder cleanup:** the sandbox runtime write-protects a fixed set
> of dotfiles/dirs at the project root (`.git`, `.gitconfig`, `.gitmodules`,
> `.bashrc`/`.zshrc`/… shell rc files, `.npmrc`, `.ripgreprc`, `.mcp.json`,
> `.vscode`, `.idea`). When one of these is **absent**, it blocks the path by
> mounting `/dev/null` over the first missing component, and
> — because the project is writable in Default/Build — bubblewrap materializes that
> mountpoint as a **0-byte, read-only file** that survives teardown (and, for
> `.git`, would break the next command). The extension keeps such projects **fully
> sandboxed** and deletes these 0-byte placeholders before and after every
> sandboxed run, so nothing accumulates. Only 0-byte *files* are removed — real
> directories (`.vscode/`, `.git/`, …) and non-empty files (`.gitmodules`, …) are
> never touched.
>
> The upstream runtime also protects `.claude/{commands,agents}` for Claude Code.
> This Pi package applies a pinned `patch-package` patch at install time to omit
> those paths: Pi does not consume them, and mounting absent nested paths can race
> with the runtime's temporary placeholder files. The extension's file-tool
> backstop likewise leaves `.claude/` writable.
>
> **Git worktrees and submodules:** when `.git` is a non-empty Git file, the
> extension resolves its per-worktree gitdir and optional shared `commondir`.
> Writable modes expose the resolved Git metadata directory to the sandbox so
> normal operations such as `git add`, `git commit`, and `git fetch` can update
> indexes, objects, and refs. Plan remains read-only. Malformed, missing, symlinked,
> dangerously broad, or nonstandard gitfile layouts without a verifiable
> worktree/submodule backlink fail closed and degrade to prompting.
>
> This is intentionally a coarse write grant. For a linked worktree the shared
> common `.git` directory is writable from sandboxed Bash, including hooks,
> repository config, refs, objects, logs, and administrative data for sibling
> worktrees. The local `.git` pointer file stays read-only, and normal clones keep
> the runtime's existing `.git/hooks` and `.git/config` write protection. Direct
> `edit`/`write` tools keep their protected-path backstop in every non-YOLO mode.

> **Symlinked sandbox paths:** a mount point that *is* a symlink aborts the whole
> sandbox — and with it every command — because bubblewrap resolves destinations
> inside its own pivoted root, where an absolute link target doesn't exist:
> `bwrap: Can't mount tmpfs on /newroot/home/you/.aws: No such file or directory`.
> This hits the stock `denyRead` set whenever a home dotfile points at another
> filesystem (`~/.aws -> /mnt/c/Users/you/.aws` under WSL), and `allowWrite` when
> the project is reached through a symlink. The extension canonicalizes every
> `denyRead`/`allowWrite`/`denyWrite` entry first, so the mount lands on the link's
> target — which covers access through the link too. An entry whose target would
> *broaden* the mount (a link to an ancestor or a top-level directory) is dropped
> with a notification instead.

### Network

In the sandboxed modes, bash network traffic is filtered by the mode's **domain
allowlist** (package registries + GitHub by default). This is no longer a silent
wall — a request to a host outside the allowlist **pauses while you're asked**
(*Allow for session / Allow forever / Deny*), then proceeds or fails:

- **`alt+n`** toggles filtering for the session; the footer marks it (see
  [Modes](#modes)).
- **`/net`** — `status` (allowlist, session grants/denies), `allow <domain…>`
  (grant for the session), `open` / `restrict` (same as `alt+n`), `reset`
  (forget session grants/denies).
- The model has a **`request_network_access`** tool: it names the domains and a
  reason, you approve or deny — one prompt can cover several domains (e.g. all
  hosts an install needs). Denied hosts stay denied for the session (no
  prompt-storms from retrying installers), and any blocked host is reported in
  the command output so the model knows exactly what happened instead of
  guessing at proxies.
- "Allow forever" persists the domain to the active mode's allowlist in your
  global config. Set a mode's `sandbox.askOnBlockedHost` to `false` to restore
  silent denying.

Grants, denies, and the open toggle are **session-scoped** (except "Allow
forever") and apply instantly — no sandbox restart.

### CLI flags

- `--perm <mode>` — start in a given mode (any defined mode name).
- `--no-sandbox` — disable the OS sandbox for the sandboxed modes (falls back to
  AST/heuristic gating + prompts).

### Session approvals

For ordinary prompts, the choices remain **Allow once / Allow for session / Deny**.
Bash safeguards for outside/privileged execution, unavailable containment,
unparsed or dynamically interpreted commands, and parser fallback are independent
one-shot confirmations (**Allow once / Deny**). A remembered Bash grant can satisfy
only the separate Bash-policy ask; it never suppresses a safeguard. Dynamic command
heads, `eval`, sourced or file-backed shell scripts, and shell command strings produced
by expansion have no inspectable command identity and cannot be remembered.
Outside-project file prompts show **Allow this request once**, **Allow
scope for session**, optional project/global memory choices, and **Deny**. `[edit]`
(or `e`/Tab) opens the scope editor. Escape from custom input returns to the
selector; Escape from the selector returns to the outer prompt without changing
the committed scope; Escape from the outer prompt denies the request.

Remembered approvals use one typed `permissionGrants` list. A path grant names
`path`, `external_directory`, `read`, `write`, `edit`, `grep`, `find`, or `ls`
plus an exact, tree, or glob scope. A Bash grant names a command pattern. Grants
are ask-only: they satisfy a matching `ask`, never override `deny`, and never
cross permission identities. Direct file calls prompt independently for boundary
and operation requirements. Dismissing a prompt, or failing to write a selected
persistent grant, denies the current requirement. Clear session grants with
`/perm clear-approvals`.

File-tool paths follow Pi's execution semantics: `~` is expanded, but `$HOME/...`
is passed literally because Pi does not invoke a shell for file paths. Permission
patterns may still use `$HOME` as a configured alias; that alias is expanded on
the pattern side only, so a literal `$HOME` directory cannot be mistaken for the
home directory. Pi read's filename fallbacks (including decomposed Unicode and
curly-quote variants) are authorized against the candidate it will actually open.
After approval, the tool input is rewritten to that selected canonical candidate,
so a fallback or symlink spelling is not resolved again for execution.

Bash path-policy asks are one-shot confirmations. Bash-surface asks offer the
narrow and broad command patterns and save paired Bash grants together. These
remembered grants are separate from explicit policy rules; `/perm allow` continues
to write full-authority ordered `permission` maps.

Use `/perm init -p` to scaffold a project file, or
`/perm allow [-p|-g] [surface] <pattern>` to write an allow rule. Flags follow
`allow`; only leading flags are parsed, so the remaining pattern text preserves
spaces and may contain `-p` or `-g`. `-p` requires a trusted project.

---

## How protection works

Two independent layers compose:

1. **Policy engine** (`allow` / `ask` / `deny`): every tool call resolves against
   the active mode's policy for its surface (`bash`, `read`/`write`/`edit`/…, the
   cross-cutting `path` gate, `external_directory`, `web_search`, `tool`,
   `skill`). `deny` blocks, `ask` prompts, `allow` passes.
   For **bash**, the command line is parsed with **tree-sitter** (a real AST)
   and every command it contains — including ones nested in `$(...)`, backticks,
   subshells, and `sh|bash|zsh|fish|… -c '…'` scripts (re-parsed recursively) —
   is judged separately: matched against the `bash` patterns **and** the `path`
   gate (against the joined command and each individual token, so
   `"path": { "*.env": "deny" }` blocks `cat .env` wherever the target appears),
   with out-of-project paths and privilege escalation (even through wrappers
   like `env`/`nice`/`xargs`) detected structurally. If the tree-sitter grammar
   can't load, a whole-string token-scan heuristic stands in, which is more
   easily fooled.

   **fish.** No fish grammar exists on npm, so `fish -c` scripts are read with
   the bash grammar. That covers the common case — `fish -i -c 'cd sub && pytest
   -k t'` is judged as `cd` and `pytest`, not as one opaque `fish` argument —
   and fish's `and`/`or`/`not` modifiers are unwrapped so they cannot hide a
   command head. Block constructs (`for … end`, `switch … end`, `function …
   end`) have no bash reading and parse incompletely. Those are detected rather
   than trusted: in sandboxed modes the command is marked **unparsed** and
   prompts rather than letting a hidden `sudo` ride through an `allow` rule.
   Explicitly unsandboxed modes keep their policy authoritative, so YOLO still
   never prompts.
2. **OS sandbox** (`@anthropic-ai/sandbox-runtime`): the real enforcement for
   bash. When a mode's `sandbox.enabled` is true, in-project bash runs wrapped by
   `sandbox-exec` (macOS) / `bubblewrap` (Linux), confining **writes** to the
   profile's `allowWrite` (project + `/tmp` by default) and denying reads of the
   profile's `denyRead` secrets — regardless of what the command does. A mode with
   `sandbox.writable:false` (Plan) runs bash **read-only**; `sandbox.enabled:false`
   (YOLO) runs it unsandboxed.

So a `bash` command that policy says `allow` still runs **sandboxed**; `ask`
prompts, then runs sandboxed — or **unsandboxed** for an out-of-project escape
or privilege escalation you approve, since you authorized it; `deny` never runs.

> Note: only the model's `bash` tool is OS-sandboxed. File tools (`read`/`edit`/
> `write`/…) are governed by the policy engine and the path checks, not bubblewrap
> — which is why the Plan-mode Markdown-only rule and the protected-path backstop
> are enforced at the tool layer. Reads inside the sandbox stay broad (only
> `denyRead` secrets are blocked at the kernel), and a non-sandboxing mode (YOLO)
> confines nothing.

**Sandbox awareness.** While a sandboxed mode is active, a factual
`## Sandbox & permissions` section is injected into the system prompt each turn:
the writable paths, denied reads, and network allowlist of the **merged** profile
(project overlays included), plus how the prompt flow works. The model then picks
paths and domains that actually work — project-local installs instead of `~/.npm`,
allowlisted hosts instead of dead fetches — and knows a boundary-crossing command
is fine to issue because you'll simply be asked. When the sandbox is degraded, the
section says so and points at the confirmation prompts instead. Opt a mode out
with `"injectSandboxInfo": false`; unsandboxed modes (YOLO) never inject.

**Tool hiding.** A mode's `hideTools` list removes those tools from the model
*before* it reasons (via the active-tools allowlist), so it never attempts them.
`show_plan` is never hidden.

**Skills & extension tools.** Skills are gated by name at `/skill:<name>` (the
`skill` surface); any non-builtin/extension tool (including MCP-as-tool in a host
that adds them) is gated by tool name (the `tool` surface). In **Default** and
**Plan**, a tool/skill the host adds that has no rule yet **prompts on first use**
— *Allow once · Allow this session · Allow forever · Deny*. "Allow forever"
persists `<mode>.permission.<tool|skill>.<name>: "allow"` to your global config so
it never asks again. **Build** and **YOLO** allow all tools/skills without
prompting. (Set a mode's `tool`/`skill` to `"allow"` to opt that mode out of the
first-use prompt, or to `"deny"` to block.)

**Protected paths.** Unless a mode sets `bypassProtectedPaths` (only YOLO does),
`edit`/`write` to protected paths are hard-blocked — matched by path segment, not
loose substring, on both the literal target **and** its symlink-resolved
canonical path (so a link pointing at `.git/` or a dotfile can't smuggle a write
past the backstop). The set mirrors the Pi-specific sandbox-runtime mandatory-deny
list: `.git/`, `node_modules/`, `.vscode/`, `.idea/`, `.env`/`.env.*`, and common
dotfiles (`.bashrc`, `.zshrc`, `.profile`, `.gitconfig`, `.npmrc`, …).
This matters most in Build, where file tools aren't OS-sandboxed.

For direct `edit`/`write`, the extension re-resolves the frozen authorized target
immediately before returning the canonical path to Pi and blocks if an absent
component or ancestor changed into a symlink. A small TOCTOU window remains
after that hook check because Pi subsequently performs its own path-based tool
execution. This extension is not a complete security boundary against a hostile
local process that can mutate the same filesystem; use OS-level isolation for
that threat model.

---

## Configuration

Modes are data, layered in this order:

1. **Stock defaults** — `permission-mode.defaults.json`, shipped with the extension
   (the four built-in modes). This is the same format you edit; copy it to make
   your own, or run **`/perm init`** to drop a copy at the global path below.
2. `~/.pi/agent/permission-mode/permission-mode.json` (**global, full authority**):
   redefine built-in modes, add your own, and set `defaultMode` / `cycleOrder`.
   (Stable location, independent of where `pi install` placed the extension.)
3. `<project>/.pi/permission-mode.json`: trusted projects append permission maps
   after global maps, load `permissionGrants`, and union `allowWrite` and
   `allowedDomains`. Duplicate permission keys move to the end. Untrusted projects use a
   most-restrictive permission overlay and tighten every sandbox field; their
   remembered grants are ignored. In either case, `denyRead`, `denyWrite`, denied domains, `writable`, and
   `askOnBlockedHost` remain tighten-only; projects cannot change defaults, cycle
   order, `sandbox.enabled`, or add modes. Unsafe domain patterns are ignored.
   Project writers do not add an implicit `"*"`, because it could override global
   rules.

The `.pi/permission-mode.json` file alone is not a pi trust-triggering resource.
In a cloned repository with no other `.pi` resource, its grants may therefore
apply without a trust prompt. Session start reports the accepted project grant
count so this limitation is visible.

`outsideFileGrants` is obsolete. It is warned about and ignored on load, is not
migrated, and is removed only from a mode when a new `permissionGrants` write
successfully rewrites that mode. This is a breaking configuration change.

### Shape

```jsonc
{
  "$schema": "https://raw.githubusercontent.com/strayge/pi-extensions/main/extensions/pi-permission-modes/schemas/permission-mode.schema.json",
  "defaultMode": "default",
  "cycleOrder": ["default", "plan", "build", "yolo"],
  "modes": {
    "default": {                        // values here are illustrative — run /perm init for the real defaults
      "label": "Default",
      "color": "muted",                 // muted | mdLink | accent | error
      "systemPrompt": "@plan",          // optional; "@plan" = the dated Plan-mode prompt
      "injectSandboxInfo": true,        // inject the mode's sandbox boundaries into the system prompt (default true)
      "sandbox": {
        "enabled": true,                // false = run bash unsandboxed (YOLO-style)
        "writable": true,               // false = bash runs read-only (Plan-style)
        "allowWrite": [".", "/tmp"],
        "denyRead": ["~/.ssh", "~/.aws", "~/.gnupg"],
        "denyWrite": [],
        "network": { "allowedDomains": ["github.com", "*.github.com"], "deniedDomains": [] },
        "askOnBlockedHost": true          // live prompt for hosts outside the allowlist (false = silent deny)
      },
      "permission": {
        "path": { "*": "allow", "*.env": "deny" },  // cross-cutting gate (deny overrides per-tool allow)
        "external_directory": "ask",                // the out-of-project boundary
        "read": "allow", "grep": "allow", "find": "allow", "ls": "allow",
        "write": "ask", "edit": "ask",
        "bash": { "*": "ask", "sudo*": "deny" },     // matched per command (name + args)
        "web_search": "ask",
        "tool": "allow",                            // any non-builtin/extension tool, by name
        "skill": "allow"                            // skills, by name
      },
      "permissionGrants": [                          // satisfy matching asks only
        { "permission": "external_directory", "scope": { "kind": "tree", "value": "/tmp" } },
        { "permission": "bash", "pattern": "git fetch *" },
        { "permission": "bash", "pattern": "git fetch" }
      ],
      "hideTools": []                               // tools removed from the model in this mode
    }
  }
}
```

**Actions:** `allow` (pass through), `ask` (prompt), `deny` (block). A surface is
either a single action or a `{ "<glob>": <action> }` map where **`*` matches any
characters incl. `/`**, `?` matches one, `~`/`$HOME` expand, **the last matching
pattern wins** (put `"*"` first as the default), and across the `path` /
`external_directory` / per-surface layers the **most restrictive wins**.

`permissionGrants` path entries use `{ "permission": "…", "scope": { "kind": "exact" | "tree" | "glob", "value": "…" } }`.
Exact scopes keep wildcard characters literal. Tree scopes contain a canonical
literal directory and use canonical containment; glob scopes use the recursive
matcher and are bound to the canonical static prefix when created. Bash entries
use `{ "permission": "bash", "pattern": "…" }`; paired narrow and broad patterns
are stored together. Grants are consulted only after policy resolves to `ask` and
never loosen a deny. Malformed, unsafe, control-character, overlong, or root-wide
grants are rejected. Project grants require a trusted project, and each grant is
scoped to the active mode. All direct-file path, boundary, and operation asks are
independent.

### Defining your own mode

Add a mode under `modes` in the global config and (optionally) list it in
`cycleOrder`. Example — a "review" mode: read-only sandbox, web search off, the
`edit`/`write` tools hidden entirely:

```jsonc
{
  "cycleOrder": ["default", "review", "build", "yolo"],
  "modes": {
    "review": {
      "label": "Review", "color": "mdLink",
      "sandbox": { "enabled": true, "writable": false, "allowWrite": [".", "/tmp"], "denyRead": ["~/.ssh"] },
      "permission": { "read": "allow", "bash": "allow", "web_search": "deny", "write": "deny", "edit": "deny" },
      "hideTools": ["edit", "write"]
    }
  }
}
```

> **Linux glob limitation (sandbox filesystem only).** The sandbox-runtime drops
> glob patterns from its `allowWrite`/`denyRead`/`denyWrite` lists on Linux — use
> literal paths there (macOS supports globs). This applies to the **sandbox**
> lists, not the `permission` policy globs, which are matched by this extension.

---

## Disabling

- Temporarily: launch pi with `--no-extensions` (disables all), or `--no-sandbox`
  to keep the modes but drop OS sandboxing.
- Permanently: `pi remove npm:@strayge/pi-permission-modes` — or remove the
  entry from your pi settings.

---

## Credit

Based on [`pi-permission-modes`](https://github.com/wynainfo/pi-permission-modes)
by Nico Merz.
