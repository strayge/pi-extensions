# pi-permission-modes

Filesystem profiles, shared directory approvals, and independent subprocess networking for Pi.

## Profiles

- **project** (default): R/W in the canonical starting directory and `/tmp`.
- **subproject**: R/W in its parent and `/tmp`.
- **yolo**: unrestricted filesystem access. **Networking remains independently restricted by default.**

Names have no special authority. The built-ins and custom profiles use the same editable version-2 schema. R/W includes reads, creation, edits, deletion, and renames. Ordinary `.git`, `.env`, `node_modules`, and IDE files have no extra protections. Explicit path rules still apply inside an approved directory.

## Setup and the clean schema break

Install this package normally with Pi. On Linux, install bubblewrap, socat, and ripgrep using your system package manager. The runtime dependency is pinned and patched by `patch-package` during installation.

Run `/perm init` (or `/perm reset` for a previous installation), acknowledge the dialog, then `/reload`. Setup writes a complete editable `version: 2` document to `<agent-dir>/permission-mode/permission-mode.json`. Existing policy/state files, including a project policy being reset, are preserved as `.backup-*` files. Headless tools cannot perform this reset.

Legacy command patterns, per-tool grants, saved workflow modes, Plan Mode, and `show_plan` are **not migrated**. Legacy configuration blocks governed operations until explicitly reset; it never silently selects YOLO. Existing personal skills or prompts mentioning `show_plan` must be updated separately; this package does not edit them.

Example custom profile:

```json
{
  "version": 2,
  "modes": {
    "docs": {
      "label": "Docs",
      "color": "accent",
      "filesystem": {
        "kind": "scoped",
        "readOnly": ["."],
        "readWrite": ["./docs", "/tmp"],
        "resourceReads": ["pi", "system"]
      }
    }
  }
}
```

Profile names merge by name; a supplied `filesystem` field replaces that profile's entire filesystem definition. Explicit arrays replace defaults, including `pathRules`. A repository `.pi/permission-mode.json` can only narrow resolved global scope, add restrictions, or tighten networking. It cannot add profiles, select another default, widen file grants to directory trees, or remove global restrictions.

## Commands and requests

- `/perm`, `/perm status`, `/perm grants`: inspect resolved roots, resources, rules, and approvals.
- `/perm <profile>` or **Shift+Tab**: select/cycle filesystem profiles.
- `/perm grant read|write <directory>`: request directory access, with editable scope.
- `/perm revoke <approval-id>`, `/perm clear`: revoke one or all additional approvals.
- `/net`, `/net open`, `/net restricted`, **Alt+N**: inspect/change networking.
- `/net allow <domain>`, `/net deny <domain>`: update independent network policy.
- Model tools: `request_directory_access`, `request_path_exception`, `request_network_access`.

Approvals default to the session, with an explicit **Remember for this project** choice. R/O to R/W upgrades require approval. Directory grants never satisfy separate `ask` rules; hard denies cannot be approved away. R/O grants do not create missing directories. R/W creation must be explicitly approved and confined to the approved root.

## Path rules

```json
{
  "version": 2,
  "pathRules": [
    { "path": "$AGENT_DIR/auth.json", "scope": "file", "read": "ask", "write": "ask" },
    { "path": "$AGENT_DIR/permission-mode", "scope": "tree", "write": "ask" },
    { "path": "./private", "scope": "tree", "read": "deny", "write": "deny" }
  ]
}
```

The shipped rules protect Pi credentials and permission policy/state writes. If the active agent directory differs, defaults also protect conventional `~/.pi/agent/auth.json`. Replacing/removing `pathRules` intentionally removes those defaults. Broad Pi-directory grants can then expose credentials or let tools alter future policy; do not remove rules casually.

Rules inspect lexical and canonical paths using native filesystem semantics. Distinct case-sensitive filenames, Unicode-space siblings, hard-link names, and copies are not merged into one identity. Dangling symlinks are rejected, while normal missing-path creation and resolvable explicit symlinks work. Filesystem identities are retained across mode changes and reloads: replacing an authority root never silently retargets a grant.

## Automatic read resources

`resourceReads: ["pi", "system"]` expands to inspectable, frozen paths:

- Pi: `~/.pi`, the active agent directory, the actual running Pi package, the exact Node executable, and exact active npm/corepack package roots and npm/npx/corepack launchers. No NVM version prefix, parent `lib/node_modules`, sibling packages, caches, or other toolchains are granted.
- Linux: canonical `/usr`, `/bin`, `/sbin`, `/lib`, `/lib64`; `/etc/alternatives`, certificate directories; loader configuration/cache, NSS configuration, hosts/resolver, gai, passwd/group, localtime, and os-release files.
- macOS: `/System`, system executable/library/share directories, `/Library/Apple`, selected hosts/resolver/services/certificate files, and dyld data.

Only existing baseline entries are included. Project `vendor` links and separately loaded extension package trees are not automatically granted. User shell configuration, virtual environments, package caches, and other repositories need ordinary grants.

Sandbox infrastructure additionally uses private process/device facilities, network proxy sockets, and the exact bundled seccomp launcher. Those are execution facilities, not grants to arbitrary host data.

## Enforcement and lifecycle

| Filesystem | Network | Shell execution |
| --- | --- | --- |
| scoped | restricted | filesystem sandbox + filtered proxy |
| scoped | open | filesystem sandbox |
| unrestricted | restricted | filtered proxy, filesystem enforcement disabled |
| unrestricted | open | direct execution |

Required-layer failure blocks execution. There is no approved-unsandboxed fallback, and `--no-sandbox` does not bypass required layers. **Scoped authority is currently available only on verified Linux ext4 (without casefold) and tmpfs paths.** Other filesystem semantics, including macOS scoped enforcement, fail closed rather than guessing at aliases. Ext4 checks require the protected system `lsattr` executable. PowerShell uses `/usr/bin/pwsh` through the same contained launcher where its installation is readable; otherwise it is unavailable, not an exemption. Native Windows containment is unsupported.

Bash parsing discovers reliable static paths and redirections before execution. Dynamic scripts and unknown syntax remain subject to the OS boundary, not command-identity prompts. Commands are never automatically retried after execution failures.

One root owner publishes immutable filesystem snapshots; new operations use its current revision. Children—including isolated and extension-filtered children—attach to the same owner. Resumed children reacquire an owner lease and see current grants; a retired owner cannot be resumed. Alternate cwd/worktrees do not become implicit grants. Approval dialogs route to the root UI. Reload/shutdown cancel and drain governed descendants/operations before replacing runtime state.

A running process keeps its filesystem snapshot. Proxied processes consult live network policy for each new connection; established connections are not terminated. Already-launched processes with open direct networking remain open until exit. Selecting a filesystem profile does not reset networking.

Mutable authority is kept in private user-owned `<agent-dir>/permission-mode/state-v2.json`, with atomic replacement and a whole-document exclusive writer lock. Session restoration binds session ID, canonical session-file path, and canonical starting directory together. No-session roots keep only process-lifetime session authority. Project grants are separately keyed by canonical starting directory. Transcript navigation cannot resurrect a revoked record. Concurrent stale writers must reload. After a crash, verify that all writers have stopped before manually recovering an orphan `.authority.lock`; no PID/age heuristic removes it automatically.

## Search and important limits

Direct `read`, `write`, and `edit` retain Pi presentation, image handling, cancellation, and edit behavior, while executing the exact authorized native path. `find`/`grep` traverse authorized entries only, do not follow discovered symlinks, and report omissions separately from truncation. `ls` is nonrecursive and classifies link targets only through authorized hops.

Search reads applicable parent/nested/global ignore metadata only when authorized. A discovered metadata symlink or inaccessible required context omits its dependent subtree; if the entire search depends on it, search is unavailable. It is never silently treated as an empty ignore file. Grep streams authorized files into a fixed protected `/usr/bin/rg`, not a PATH-selected or agent-writable binary.

Restrictions may pin an ancestor directory against rename/removal without making ordinary contents read-only. Existing or future restricted mountpoints are enforced before shell launch; unsupported literal paths/guard layouts are unavailable. Temporary future mountpoints are removed only while their recorded identity remains unchanged.

Host-side direct-tool checks retain a check/use race against hostile local processes. Trusted custom tools/extensions and the processes/network clients they launch are outside this policy. This is not secret redaction, environment isolation, or object-wide hard-link tracking.

Linux containment is tested with real bubblewrap on the reported test filesystem. Generated macOS profiles are **not** evidence of live macOS or case-insensitive/normalizing-filesystem containment; do not claim those platforms without running their native tests.

## Development

```sh
npm run check
```

Tests cover configuration, strict paths, owner transitions, protected persistence, direct/search tools, and real Linux containment where dependencies exist. Use an isolated temporary agent/config directory for Pi smoke tests; never reset personal permission state during validation.
