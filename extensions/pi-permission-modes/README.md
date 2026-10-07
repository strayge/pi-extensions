# pi-permission-modes

Scoped filesystem profiles, canonical file/tree rules, session/project/global grants, and independent subprocess networking for Pi.

## Profiles

- **project** (default): R/W in the canonical starting directory and `/tmp`, plus `/var/folders` on macOS.
- **subproject**: R/W in its parent and `/tmp`, plus `/var/folders` on macOS.
- **yolo**: unrestricted filesystem access.

**Networking is independently open by default in every profile.** Enable restrictions with `/net restricted` or set `network.default` to `"restricted"`. Existing explicit configuration and saved session overrides are not changed by the shipped default.

On macOS, `/var/folders` resolves to `/private/var/folders` and includes OS-managed temporary files and caches beyond the current project. Default R/W access remains subject to macOS account permissions and explicit path rules. Existing policies with explicit filesystem definitions retain their configured scope; the additional default does not widen them automatically.

Names have no special authority. The built-ins and custom profiles use the same editable version-3 schema. Scoped profiles also receive automatic R/W access to validated Git metadata when the frozen starting directory is inside a linked worktree. Profiles provide baseline access; custom rules and grants can override it at more-specific canonical boundaries. R/W includes reads, creation, edits, deletion, and supported renames. Ordinary `.git`, `.env`, `node_modules`, and IDE files have no extra protections.

## Process lifecycle

Top-level `processMode` is independent of filesystem profiles and networking:

- **`compatible`** (default, including policies that omit this setting): permits normal session/process-group creation and native `posix_spawn` on macOS. Command completion, cancellation, and timeout still kill the original process group, but detached descendants may survive. If they retain output pipes, capture ends after a 250 ms drain window rather than hanging the tool. Late background output is not captured.
- **`strict`**: retains the confined-command cleanup guarantee. On macOS this denies `setsid`/`setpgid` and makes `posix_spawn` return `ENOSYS`; runtimes with fork/exec fallback continue to work, but tools that require daemonization or native spawning may fail.

Both modes retain filesystem and network restrictions. Detached macOS descendants inherit their sandbox and original filesystem snapshot; later grant revocation, profile switches, or reloads do not retroactively rewrite that snapshot. Persistent background services are not guaranteed: networking proxies can disappear during runtime reset. Linux already supports normal session/group creation within its PID namespaces; both modes retain bwrap namespaces, parent-death handling, and the IPC/network seccomp filter, so namespace teardown may retire detached processes even in compatible mode.

To opt into strict mode, add `"processMode": "strict"` to the user-owned version-3 policy. Repository permission policies are never read. Fully unrestricted, open-network direct execution has no sandbox preventing process-group escape, so it always uses compatible cleanup even when the policy selects strict mode.

## Setup and state compatibility

Install this package normally with pi >=1.0.2. On Linux, install bubblewrap (with FD bind-mount support), socat, and ripgrep using your system package manager. On macOS, scoped access requires APFS and Apple's `/usr/bin/sandbox-exec`; search uses Homebrew ripgrep (`brew install ripgrep`). No bubblewrap or socat is needed on macOS. The runtime dependency is pinned and patched by `patch-package` during installation.

The only policy source is `<agent-dir>/permission-mode/permission-mode.json`, normally `~/.pi/agent/permission-mode/permission-mode.json`. Repository `.pi/permission-mode.json` files are never read, imported, changed, backed up, or deleted.

**Version 3 is a breaking reset, not a migration.** Only v3 configuration and v3 private catalogs are supported. `state-v4.json` keeps the existing sessions/projects/grants/receipts shape; old catalogs and `state-v3.json` are rejected and left untouched until an explicit reset. No old approvals, repository restrictions, or transcript entries acquire v3 authority automatically.

Rollout:

1. Inspect and independently back up customized user policy.
2. Run `/perm init` or `/perm reset` and explicitly acknowledge the root-UI dialog. All affected user policy/state files are backed up before replacement; approvals across projects are discarded. Repository policies remain untouched.
3. **Restart Pi**, rather than relying on `/reload`, to discard retained owner/runtime prototypes.
4. Reapprove required paths and manually restore reviewed custom rules using v3 syntax.

Headless tools cannot reset policy. Cancellation before replacement changes no authority; backups finish before source files change, and failed replacements restore changed sources. Reset stays anchored to the frozen starting project even after failed initialization, extension reload, or a different command cwd. Unsupported old policy/state and malformed v3 policy retain the warned **unrestricted initialization fallback** described below until repaired/reset; do not mistake that warning for confinement.

Example custom profile:

```json
{
  "version": 3,
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

Profile names merge by name; a supplied `filesystem` field replaces that profile's entire filesystem definition. Profile roots must be directories. Explicit arrays replace defaults, including `pathRules`. Missing policy uses shipped defaults; a partial v3 document overrides them. Paths support `~`, `$HOME`, `$AGENT_DIR`, and project-relative paths anchored to the frozen root. UI-saved global grants use absolute canonical targets so their meaning does not change across projects.

## Commands and requests

- `/perm`, `/perm status`, `/perm grants`, `/perm inspect`: inspect resolved roots, resources, rules, ordinary approvals, session blocks, and active/dormant/blocked global declarations.
- `/perm <profile>` or **Shift+Tab**: select/cycle filesystem profiles.
- `/perm grant read|write <path>`: request an exact-file grant for an existing regular file, or directory access with editable scope.
- `/perm revoke <approval-id>`: revoke an ordinary grant or ask receipt.
- `/perm revoke <block-id>`: remove one ephemeral denial, using its `block:<UUID>` ID from inspection; even a stale pinned target can be removed.
- `/perm revoke global:<rule-id>`: confirm removal of all current allow-valued fields of that declaration; preserve ask/deny fields and remove an empty row.
- `/perm clear`: clear ordinary grants, ask receipts, and all session blocks for the active owner/project, never global policy.
- `/perm clear global`: confirm removal of all configured allow fields, including dormant/blocked positives; preserve restrictions, ordinary approvals, session blocks, profiles/resources, networking, and process mode. Unknown arguments fail safely.
- `/net`, `/net open`, `/net restricted`, **Alt+N**: inspect/change networking.
- `/net allow <domain>`, `/net deny <domain>`: update independent network policy.
- Model tools: `request_directory_access`, `request_path_exception`, `request_network_access`.

The footer and statusline show **Network restricted** only while an initialized policy restricts networking; open networking has no indicator. Failed policy initialization falls back to open networking and clears that indicator. `/net` still reports the current network policy when initialized.

All directory grant menus, including agent-triggered requests, offer **Allow for this session** (default), **Remember for this project**, **Save globally**, **Edit directory scope**, **Deny and block for this session**, and **Deny**. Scope editing offers the requested directory and its parents, plus manual path entry. `/` is available only through manual entry. Selecting a scope returns to explicit approval of the revised path; cancelling preserves the previous scope. Exact-file menus offer the same choices without scope editing. Separate ask-receipt menus offer session/project saving and both denial choices, displaying the rule's exact file/tree scope.

**Deny** or dismissing the menu rejects only the current request. **Deny and block for this session** rejects it and adds an in-memory denial shared by the root and all children. R/O denial also denies writes; R/W denial blocks only writes, and reads still require ordinary permission. Directory blocks cover the displayed tree; edited scopes must still contain the requested target. Missing directories can be blocked without creating them, using the same pinned future-target semantics as configured denies. Exact-file blocks pin the parent and follow atomic regular-file replacement, without covering siblings. Ask-receipt blocks use the rule's declared scope (including missing targets) and create no receipt.

Session blocks survive profile switches, successful `/reload`, and global-policy edits, but disappear on session close, restart, or reopen. They never enter policy, catalogs, or saved state. They use the existing most-specific rule precedence: deny wins equal-specificity ties with grants/receipts, while narrower allows or approved asks can override it. Yolo bypasses them just like configured rules. Inspection lists them separately with `block:<UUID>` IDs. Adding/removing a block affects new operations and invalidates stale approvals; already-launched processes retain their original filesystem snapshot.

R/O to R/W upgrades require approval. R/O grants do not create missing directories. R/W creation requires explicit root approval of the displayed directory, not an implicit parent grant. Winning asks are approved before requesting unrelated positive authority; equally specific asks still need their own receipts. A successful approved creation continues the triggering write for session, project, and global saving without a hidden extra grant. Pre-commit failure removes only an empty, identity-matching newly created directory; populated/replaced directories are retained with a warning.

For example, `/perm grant read ~/.gitconfig` grants only that existing regular file, not its parent or siblings; `write` supplies read/write authority at the same specificity. File permissions follow the approved name through ordinary atomic regular-file replacement while pinning its parent and canonical/symlink destination. Missing paths retain explicit directory-creation semantics; nonexistent files are never inferred.

Global grants are allow declarations in the user policy, not a third private approval bucket. A read save followed by a write upgrade consolidates into one current declaration; its `global:<rule-id>` identifies that declaration, not historical approval actions or an array position. Revoke removes every current allow field, not just the most recent upgrade. Global saves never overwrite restrictions or borrow private grants/ask receipts: if the requested boundary remains denied or requires ask, save is refused and the policy is unchanged. Tree grants may retain more-specific protected descendants.

Confirmed global edits use a private same-directory temporary file, exclusive `.authority.lock`, content/identity/revision checks, and atomic rename. Rename is the commit point. Publication is immediate for the root and attached children, invalidates stale approval answers, does not reset networking, and does not rewrite running filesystem snapshots. Other processes need reload/restart. A later private-cache failure means **committed and active with a warning**, not rollback; restart Pi before further authority changes.

## Path rules

```json
{
  "version": 3,
  "pathRules": [
    { "path": "$AGENT_DIR/auth.json", "scope": "file", "read": "ask", "write": "ask" },
    { "path": "$AGENT_DIR/permission-mode", "scope": "tree", "write": "ask" },
    { "path": "./private", "scope": "tree", "read": "deny" },
    { "path": "./private/notes.txt", "scope": "file", "read": "allow" }
  ]
}
```

The shipped rules protect Pi credentials and permission policy/state writes. If the active agent directory differs, defaults also protect conventional `~/.pi/agent/auth.json`. Replacing/removing `pathRules` intentionally removes those defaults. Broad Pi-directory grants can then expose credentials or let tools alter future policy; do not remove rules casually.

Each rule declares `scope: "file" | "tree"` and `read`/`write` actions of `allow | ask | deny`. The most-specific canonical component boundary wins independently for each operation; JSON order, path character count, and alias spelling do not add priority. At equal specificity, deny wins, then unresolved ask, then allow. Every equally winning ask needs its own source/operation receipt. Session, project, and global allows have identical scope and precedence; only persistence differs. Approved asks stay conditional permissions at their declared boundary, including outside the profile or beneath broader denial.

Writing requires effective read and write authority. Write allow or approved write ask supplies read authority at the same specificity, subject to equal/more-specific read restrictions. A narrower read-only exception does not revive writes suppressed by a broader read denial. With baseline R/W `work` and a read denial on `work/private`, a child `read: "allow"` or approved read ask permits only reads; a child write allow or approved write ask permits R/W. Pending write asks do not newly restrict ordinary reads. Yolo bypasses custom filesystem rules, not networking.

Missing positive targets are dormant; they never create placeholders or authorize a parent. Wrong types, canonical redirection, and live directory/parent identity changes block the affected positive source and warn without disabling otherwise valid policy. Ask/deny constraints remain independently validated. Adding/upgrading/rebinding authority needs a valid target; removing positive fields does not require a usable positive target, but surviving restrictions keep their original validated pins.

Rules inspect native filesystem paths. Distinct case-sensitive filenames, Unicode-space siblings, hard-link names, and copies are not merged into one identity. Existing APFS case/Unicode aliases resolve to their native canonical spelling, and Seatbelt applies native matching to shell rules. Dangling symlinks are rejected, while normal missing-path creation and resolvable explicit symlinks work.

Persistent permissions follow lexical/canonical pathnames, not historical inode identities. Fresh root initialization binds the current objects at those names; recreating a directory at the same canonical path therefore preserves its permissions. This deliberately accepts same-path directory substitution while Pi is stopped, but saved symlink destinations and object types remain validated. Ordinary directory-tree permissions and exact-file parent anchors stay pinned within a live owner, including across mode changes and `/reload`. Exact-file authority follows the canonical filename inside that parent (or the nearest existing ancestor for future parents), so atomic regular-file replacement remains valid. During live execution, replacing an ordinary pinned directory/parent, redirecting a path, or substituting a directory/special file fails closed. Each execution still obtains current object identities for direct-tool checks and Linux descriptor mounts.

On macOS, a nonexistent rule target has no canonical spelling to compare. Direct-tool creation under that rule's nearest existing parent conservatively requires the same exception (or is denied for a hard rule), even for a different new filename, until the rule target exists. Existing unrelated files are unaffected. Shell sandbox rules remain exact; static preflight uses the conservative direct-tool check. Configuration/state paths reject user-controlled symlink redirection; Apple's protected `/tmp`, `/var`, and `/etc` aliases are accepted.

## Automatic read resources

`resourceReads: ["pi", "system"]` expands to inspectable directory-root and exact-file permissions:

- Pi: `~/.pi`, the active agent directory, the actual running Pi package, the exact Node executable, and exact active npm/corepack package roots and npm/npx/corepack launchers. On macOS, exact linked Node dylibs are discovered using system `otool`; Homebrew Node also receives its OpenSSL configuration and CA bundle. No NVM/Homebrew prefix, parent `lib/node_modules`, sibling packages, caches, or other toolchains are granted.
- Linux: canonical `/usr`, `/bin`, `/sbin`, `/lib`, `/lib64`; `/etc/alternatives`, certificate directories; loader configuration/cache, NSS configuration, hosts/resolver, gai, passwd/group, localtime, and os-release files.
- macOS: `/System`, system executable/library/share directories, `/Library/Apple`, `/Library/Developer/CommandLineTools` when installed, selected hosts/resolver/services/certificate files, and dyld data. Command Line Tools are R/O and omitted when `system` resources are disabled; full Xcode installations at other paths still require explicit grants.

Host-runtime resources are rediscovered at fresh initialization and `/reload`, so Pi/Node/package updates do not invalidate remembered authority. Their exact bindings live only in execution snapshots; their enclosing installation prefixes are never granted. Automatically readable `~/.pi` and agent directories remain ordinary durable boundaries, and explicit path rules keep their own anchors even inside a runtime package. Reload drains existing operations before publishing refreshed resources.

Only existing baseline entries are included. Project `vendor` links and separately loaded extension package trees are not automatically granted. User shell configuration, virtual environments, package caches, and other repositories need ordinary grants.

Sandbox infrastructure additionally uses private process/device facilities, network proxy sockets, and the exact bundled Linux seccomp launcher. macOS also permits directory metadata, symlink inspection, and opening the root directory for dyld (not recursive root reads). Those are execution facilities, not grants to arbitrary host file contents.

## Linked Git worktrees

Starting inside a linked worktree automatically adds R/W access to its validated common Git metadata directory, without a command or approval prompt. This tree includes the current worktree's administrative directory. The main checkout's working files and its enclosing directory are not granted.

Discovery walks upward from the frozen starting directory to the nearest `.git` marker. It requires a regular Gitfile pointing into a `worktrees/<name>` layout, a matching `commondir`, a reciprocal `gitdir` backlink to that Gitfile, valid HEAD files, and regular repository configuration plus object/reference directories. Symlinked metadata entries, incomplete layouts, submodule Gitfiles, malformed pointers, and metadata paths the sandbox cannot represent do not create automatic access; ordinary permission enforcement remains active. Discovery does not execute Git or load repository configuration.

**This intentionally trusts validated worktree metadata by default.** Layout checks are not proof that a repository is trustworthy. R/W access includes shared objects, refs, hooks, configuration, and other worktrees' administrative data. Existing explicit ask/deny rules still apply; configure a tree rule for the common Git directory to require approval or deny access. No hidden metadata restrictions are added.

The automatically discovered directory is pinned for the live owner, including profile changes and `/reload`; editing a Gitfile cannot retarget it or add new automatic authority. Fresh root initialization rediscovers it rather than restoring it as a saved approval. Children inherit the root's access, but launching them with another cwd does not discover or grant that cwd's metadata. Other repository layouts still use ordinary explicit grants.

## Enforcement and lifecycle

| Filesystem | Network | Shell execution |
| --- | --- | --- |
| scoped | restricted | filesystem sandbox + filtered proxy |
| scoped | open | filesystem sandbox |
| unrestricted | restricted | filtered proxy, filesystem enforcement disabled |
| unrestricted | open | direct execution |

**If root policy initialization or reload fails, the extension warns and falls back to Pi's ordinary tools with unrestricted filesystem access and open networking.** The footer shows **Unrestricted (policy failed)**. Repair the configuration or filesystem boundary and `/reload` to restore enforcement; fallback does not reset saved policy or approvals. Inherited child policies do not independently fall back while their parent remains governed.

After successful initialization, required-layer failure blocks execution. There is no approved-unsandboxed fallback for an active policy, and `--no-sandbox` does not bypass required layers. **Scoped authority supports macOS APFS and verified Linux ext4 (without casefold) and tmpfs paths.** Other filesystem semantics fail closed. Ext4 checks require the protected system `lsattr` executable. PowerShell uses `/usr/bin/pwsh` on Linux, or `/usr/local/bin/pwsh` / `/opt/homebrew/bin/pwsh` on macOS, through the same contained launcher. Its installation and dependencies must be readable under the selected profile; otherwise it is unavailable, not an exemption. Native Windows containment is unsupported.

Bash parsing discovers reliable static paths and redirections before execution. Recognized options separate values from file operands; descriptor duplication and literal heredoc bodies are not file paths. Conditional `cd` tracks successful and failed branches separately, while subshell cwd changes stay local. Ambiguous options, dynamic scripts, physical/unknown cwd changes, and unknown syntax remain subject to the OS boundary, not command-identity prompts. Commands are never automatically retried after execution failures.

One root owner publishes immutable filesystem snapshots; new operations use its current revision. Children—including isolated, extension-filtered, and nested children—attach to the same owner over the shared event bus. Resumed and reopened children reacquire an owner lease and see current grants; a retired owner cannot be resumed. Alternate child cwd/worktrees do not become implicit grants; only the frozen root's validated starting-worktree metadata is discovered automatically. Approval dialogs route to the root UI. Reload/shutdown abort active direct/search/shell operations and descendants, then drain their leases before replacing runtime state. Late network answers cannot grant access after retirement or a failed reload; ordinary filesystem switches do not invalidate independent network approvals.

A shell operation owns its original process group until foreground exit, cancellation, or timeout, and attempts to retire that group before releasing its lease, even on successful exit. Strict confined execution additionally prevents detached descendants from surviving cleanup; compatible execution uses bounded output handling and best-effort cleanup as described under **Process lifecycle**. The operation lease tracks the command, not surviving compatible-mode daemons.

A running process keeps its filesystem snapshot. Proxied processes consult live network policy for each new connection; established connections are not terminated. Already-launched processes with open direct networking remain open until exit. Selecting a filesystem profile does not reset networking. Requested hosts, configured patterns, and grants use the same WHATWG host normalization as the proxy: alternate IPv4 forms such as `127.1`, `2130706433`, and `0x7f000001` cannot bypass a deny for `127.0.0.1`.

Private approvals/cache are kept in user-owned `<agent-dir>/permission-mode/state-v4.json`, with atomic replacement and a whole-document exclusive writer lock shared with global policy transactions. Trusted current user policy establishes global authority before cache reconciliation. Obsolete cached declarations/receipts cannot restore removed allows or reject newer policy merely because obsolete positive targets changed. Independent ordinary grants, surviving receipts, saved shape, frozen-root/session identity, canonical destinations and object types remain validated. Runtime resources are rebuilt from current host metadata rather than restored from saved catalogs. Exact-file permissions resolve the current regular file under freshly bound parent anchors. Session restoration binds session ID, canonical session-file path, and canonical starting directory together. No-session roots keep only process-lifetime session authority. Project grants are separately keyed by canonical starting directory. Transcript navigation cannot resurrect a revoked record. Concurrent stale writers must reload. Lock-cleanup failure after a committed write does not falsely roll back in-memory authority; a remaining lock blocks subsequent writers. After a crash or cleanup failure, verify that all writers have stopped before manually recovering an orphan `.authority.lock`; no PID/age heuristic removes it automatically.

## Search and important limits

Direct `read`, `write`, and `edit` retain Pi presentation, image handling, cancellation, and edit behavior, while executing the exact authorized native path. `find`/`grep` share the effective evaluator, traverse authorized entries only, do not follow discovered symlinks, and report omissions separately from truncation. They never enumerate a denied parent to discover narrower exceptions; an explicitly supplied authorized file is a safe entry point. Explicit tree roots still require authorized ignore context. `ls` is nonrecursive and classifies link targets only through authorized hops; dangling or unauthorized targets retain their entry name without a directory suffix. Discovered broken links do not abort recursive search.

Search reads applicable parent/nested/global ignore metadata only when authorized. A discovered metadata symlink or inaccessible required context omits its dependent subtree; if the entire search depends on it, search is unavailable. It is never silently treated as an empty ignore file. Grep streams authorized files into protected `/usr/bin/rg` on Linux. On macOS it selects a fixed Homebrew location, not PATH, and runs rg in a separate stdin-only sandbox with a minimal environment, no networking or host-file writes, and reads limited to its executable, linked dylibs, and OS runtime facilities. Changes to those dependencies may require `/reload`.

A rename requires source unlink and destination creation authority. Exact-file R/W does not authorize sibling temporary/lock files or shell atomic-save helpers. Linux exact-leaf bind mounts have native rename/unlink/replace `EBUSY` limitations; directory grants are never widened to work around them. Host-side direct replacement stays bounded to its exact authorized file.

Restrictions may pin an ancestor directory against rename/removal without making ordinary contents read-only. Existing or future restricted mountpoints are enforced before shell launch; unsupported literal paths/guard layouts are unavailable. Temporary future mountpoints are removed only while their recorded identity remains unchanged.

Host-side direct-tool checks retain a check/use race against hostile local processes. macOS checks final effective-program equivalence immediately before launch, rejecting a stale profile if its positive sources became invalid. Seatbelt is path-based and does not provide Linux's descriptor-pinned mount snapshots against external replacement after that check. No approved source descriptors are passed to macOS commands. Trusted custom tools/extensions and the processes/network clients they launch are outside this policy. This is not secret redaction, shell environment isolation, or object-wide hard-link tracking.

Native macOS tests exercise APFS case/Unicode aliases, future rules, ancestor protection, read-only/outside boundaries, Homebrew Node and grep, cancellation, concurrent immutable snapshots, unrelated runtime families, filesystem-plus-network and live network-only policy changes. Search fixtures cover Gitfiles, common directories, global/nested ignores, and cancellation against native rg/fd. Central-runner tests use real Pi sessions and shell processes with a scripted local model to exercise isolated, filtered, nested, resumed, reopened, and cancelled children. Linux-specific FD-mount tests remain separate. The v3 compact precedence matrix, symlink containment, and post-generation pin substitution are exercised through the production macOS profile. Linux generated mount ordering and patch application are checked on this host, but **native Linux v3 enforcement is unvalidated here and remains required for cross-platform acceptance**. Live PowerShell execution and an authenticated external-model roundtrip are not verified.

## Development

```sh
npm run check
```

Tests cover configuration, strict paths, owner transitions, protected persistence, direct/search tools, and native macOS/Linux containment where dependencies exist. The macOS syscall regression compiles a small temporary probe with the system clang toolchain. Use an isolated temporary agent/config directory for Pi smoke tests; never reset personal permission state during validation.
