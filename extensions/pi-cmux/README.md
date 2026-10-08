# pi-cmux

A repository-managed replacement for cmux's generated Pi extension. Keeps the
existing lifecycle, tool Feed, workspace metadata, notifications, and session
resume behavior, with two additions:

- **Background agents stay busy:** finishing the main turn does not publish Idle
  while the `pi-subagents` manager has running or queued agents. Child sessions
  cannot overwrite the parent workspace's status or resume binding.
- **Input dialogs request attention:** questions, agent permission approvals,
  and agent worktree confirmations send cmux's semantic “needs input” notification.
  Answering or cancelling resolves the wait; overlapping dialogs keep it active
  until the last tracked dialog closes.

Completion notifications use “Task completed” rather than the answer text, so
mentions of permissions or errors cannot be mistaken for requests for input.
Assistant questions and approval notifications remain unchanged. New completion
notification/Stop dispatch is deferred while a tracked dialog is open, not for
an entire deferred worktree operation or gaps between screens. Already-dispatched
requests cannot be recalled.

Requires Pi >=1.0.2 and Node.js >=22.19.0. Outside a cmux surface, it does nothing.

## Installation

From this repository:

```sh
pi install ./extensions/pi-cmux
```

For a development invocation:

```sh
pi -e ./extensions/pi-cmux
```

Restart Pi after installing so the replacement is active from the first session
start. No shell configuration, manual environment export, or edits to cmux's
installed files are needed.

## Automatic takeover

The entry-point factory sets `CMUX_PI_HOOKS_DISABLED=1` **inside the Pi process**,
before session events run. The stock bridge checks that flag dynamically, so it
stays inactive regardless of extension load order. The cmux launcher may still
load the stock file; loading it does not make its hooks active.

This bridge uses its own opt-out, `PI_CMUX_DISABLED=1`, and removes the stock
suppression flag from its hook subprocess environments. It does not mutate your
shell environment or cmux's bundled files. cmux may continue refreshing its
managed `cmux-session.ts`, but it cannot replace this package's source.

Suppression deliberately lasts until the Pi process exits, including `/reload`
and child sessions. Restoring it partway through shutdown could let the stock
bridge emit duplicate notifications or clear a live resume binding. **After
removing/disabling this package, restart Pi to re-enable stock hooks.**

To use the stock integration for one fresh invocation:

```sh
PI_CMUX_DISABLED=1 pi
```

Existing cmux controls such as `CMUX_PI_CMUX_BIN` and `CMUX_PI_HOOK_TIMEOUT_MS`
remain supported.

## Integration boundaries

`pi-subagents` and `pi-ask` are optional. Without them, normal Pi lifecycle and
native dialog notifications still work. Background tracking uses
`Symbol.for("pi-subagents:manager")` (`hasRunning` / `waitForAll`). The manager
reports running/queued agent records, not workflow-only phases with no active child.

Input tracking uses the repository convention
`Symbol.for("pi-extensions:input-dialog")`, not a built-in Pi API:

| Dialog API | Marker location | Literal `true` | Literal `false` | Absent/other value |
| --- | --- | --- | --- | --- |
| `custom` | Factory function | Track | Ignore | Ignore |
| `confirm`, `select`, `input` | Native dialog options | Track | Ignore | Track (legacy compatibility) |

Use an enumerable symbol property (for example, `Object.assign`) so metadata
survives option spreading, including child signal merging. Preserve all existing
options and abort signals. The marker controls attention only, never permission
policy or answer values.

Repository coverage includes agent filesystem approvals and their scope/path
editors, agent worktree create/finish/switch confirmations, and every `pi-ask`
question form: `ask_user`, recovery, `/answer`, `/answer:again`, and `/ask:replay`.
Manual answer/replay forms deliberately remain tracked. Runtime-mediated network
approvals also remain tracked for **both agent shells and manual `user_bash`**.

Manual filesystem approvals, global permission edits/reset, worktree safety
confirmations, and native menus/settings opt out. Ordinary custom menus, settings,
loaders, reports, and viewers stay unmarked; settings inside an open question do
not end its wait. An agent joining an already-open manual filesystem approval
inherits its untracked status; approval deduplication is unchanged.

Unmodified third-party native menus can still cause false waits; unknown custom
UI is ignored unless its factory opts in. Child custom dialogs remain unsupported
by the child UI proxy. Native child approvals forwarded through the parent UI
are tracked once.

Deploy matching repository `pi-ask` and `pi-cmux` changes together. Older/upstream
unmarked `pi-ask` forms lose custom wait tracking: cmux no longer subscribes to
pi-ask's public lifecycle events and provides no event fallback. Other consumers
of pi-ask's public remote events remain compatible.

Automatic question recovery launches at normal Pi's `resources_discover` boundary,
after all `session_start` handlers finish, with no extension load-order requirement.
Custom SDK hosts must also perform post-start resource discovery for recovery.

## Development

```sh
npm install
npm run check   # biome, tsc --noEmit, and regression tests
```

Tests cover takeover, child isolation, background settlement, form submission and
cancellation, stale waits, dialog lifecycle, and a real subprocess transport with
a fake cmux executable. They do not mutate live cmux workspace state.

## Upstream and license

`src/upstream/cmux-session.ts` is a modified snapshot of cmux's generated Pi bridge
(template v4), captured on 2026-10-07. Its formatting is kept separate from the
package's handwritten entry point and tests to make upstream comparisons small.
Pi versions supported by this package always emit `agent_settled`; legacy
executable-version probing has been removed.

This package is **GPL-3.0-or-later**, retaining cmux's copyright and license.
See [NOTICE](NOTICE) for provenance and local modifications, and [LICENSE](LICENSE)
for the complete license. Upstream hook changes must be reviewed and merged into
this snapshot explicitly; updating cmux does not update this package.
