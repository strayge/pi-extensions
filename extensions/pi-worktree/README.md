# pi-worktree

Manage Git worktrees with the agent or `/worktree`, keeping the full active
conversation when switching checkouts. Never commits, merges, fetches, or pushes.

## Install

Requires pi **1.0.4+** and Node **22.19+**. If upstream is installed, first run
`pi uninstall npm:@narumitw/pi-worktree`. **Do not load both:** they register the
same `/worktree` command.

From this repository's root:

```sh
cd extensions/pi-worktree
npm install
pi install "$PWD"
```

Then run `/reload` in pi.

## Agent operations

Ask the agent to use the `worktree` tool:

| Operation | Arguments |
| --- | --- |
| List registered worktrees | `{"action":"status"}` |
| Create and switch | `{"action":"create","branch":"feat/example"}` |
| Switch to a registered worktree | `{"action":"switch","path":"/path/to/worktree"}` |
| Return to main and clean up | `{"action":"finish"}` |

`status` is read-only and needs no approval. The other operations require one
approval in the terminal or an RPC client.

### Create

- **New branch:** starts at the current branch's commit unless you pass `base`
  to select another branch, tag, or commit. Detached HEAD requires an explicit `base`.
- **Existing branch:** uses its own tip; omit `base`. A branch already checked out
  cannot be reused.
- Optional `path` overrides the default
  `~/.worktrees/<main-checkout-name>/<branch-with-slashes-replaced-by-hyphens>`.

The dialog labels the branch `(new)` or `(existing)`. Source checkout files,
including staged and uncommitted changes, are not copied or moved.

### Finish

Returns to the main checkout **before** removing the linked worktree. Optional
branch deletion happens only after successful worktree removal:

- Verified merged into the main checkout's HEAD: deletion selected by default.
- Merge unverified, including squash/rebase integrations: keep selected by default.

Deleting a branch removes its reflog (recovery history). Review any data-loss warning,
even for a merged branch. Ignored files to be deleted are listed in the dialog.

To retry cleanup of a retained worktree from main, pass its registered path:
`{"action":"finish","path":"/path/to/worktree"}`. Without `path`, the most recent
failed finish in the active conversation supplies it.

**Terminal controls:** Enter creates and switches, or finishes; Esc cancels;
↑/↓ scroll; Space toggles branch deletion in the finish dialog.

Do not run transitions alongside edits or subagents. Wait for completion before
continuing. Queued input blocks a transition; input sent while it is pending must
be resubmitted afterward.

## Manual commands

`/worktree` opens a menu for status, add, switch, remove, finish, prune, and root
configuration. Manual Remove keeps the branch; optional branch deletion belongs
to Finish. Root configuration changes `~/.worktrees` in the default path.

## Safety and recovery

- Main, locked, stale, and bare worktrees cannot be removed.
- Dirty tracked files, untracked files, initialized submodules, and protected Git
  index flags block removal. There is no force-remove option.
- Ignored files can include secrets or local data: review the deletion inventory.
  Worktree recovery-history warnings also apply when keeping the branch.
- Cleanup can partially succeed. A cleanup failure after returning leaves pi in
  the main checkout; inspect the reported outcome before retrying.
- Approval does not grant additional filesystem permissions or project trust.

Previously saved source sessions remain available. In-memory conversations are
saved in the destination, without creating a separate source-session backup.
Project resources are reloaded for the destination.

[Upstream provenance](UPSTREAM.md) · [License](LICENSE)
