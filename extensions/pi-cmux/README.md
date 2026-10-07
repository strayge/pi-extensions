# pi-cmux

A repository-managed replacement for cmux's generated Pi extension. Keeps the
existing lifecycle, tool Feed, workspace metadata, notifications, and session
resume behavior, with two additions:

- **Background agents stay busy:** finishing the main turn does not publish Idle
  while the `pi-subagents` manager has running or queued agents. Child sessions
  cannot overwrite the parent workspace's status or resume binding.
- **`pi-ask` forms request attention:** opening an `ask_user`, replay, or resumed
  form sends cmux's semantic “needs input” notification. Answering or cancelling
  resolves the waiting state. Standard confirm/select/input dialogs, including
  filesystem/network approvals and global-grant confirmations from
  `pi-permission-modes`, remain covered.

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
standard dialog notifications still work. Background tracking uses
`Symbol.for("pi-subagents:manager")` (`hasRunning` / `waitForAll`); question tracking
uses `@eko24ive/pi-ask:started` and `@eko24ive/pi-ask:completed` with matching
`flowId` values.

The manager reports running/queued agent records, not workflow task state.
Workflow-only phases with no running or queued child are not exposed by that
protocol. Forms opened in a child use its own event bus; child-only `pi-ask`
events are not relayed by this extension. Standard child permission dialogs
forwarded through the parent UI remain covered.

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
