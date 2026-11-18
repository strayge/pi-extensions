# @strayge/pi-intercom

Direct messaging and scoped broadcasts between pi sessions, imported from pi-intercom 0.18.1.

## Install

```sh
pi install ./extensions/pi-intercom
```

Restart pi after installing. Do not load this package alongside another copy of pi-intercom.

## Usage

- Press **Alt+M** or run `/intercom` to choose a connected session and compose a message.
- Use `/alias <name>` to give your session a recognizable name.
- Use `/intercom-id` to insert your session's stable target into the editor.
- The `intercom` tool supports `list`, `list-cwd`, `send`, `status`, `cancel`, and `handover`. Use `send` with `wait: true` to wait for a direct response, or `send` with an explicit `to` and `replyTo` to answer any earlier message.
- Children contact their immediate spawning session with `send` to `parent`, optionally with `wait: true`. This requires current-launch parent metadata (supplied by pi-subagents), not a name or saved transcript ancestor.
- The bundled `pi-intercom` skill documents coordination workflows.

Only sessions with the extension loaded and enabled appear in the roster. A local broker starts automatically when needed. Configuration lives in `~/.pi/agent/intercom/config.json` (or under `PI_CODING_AGENT_DIR`).

```ts
intercom({ action: "send", to: "<full-session-id>", message: "Please review", wait: true });
intercom({ action: "send", to: "<full-sender-id>", replyTo: "<message-id>", message: "Reviewed" });
intercom({ action: "send", to: "workspace", message: "Status update" });
intercom({ action: "send", to: "global", message: "Attention needed", quiet: false });
```

Direct sends are active by default: they wake idle peers or steer busy peers without aborting work. Broadcasts default to quiet; set `quiet: false` to make them active. Quiet uses Pi's volatile native next-turn queue without waking or steering. Exception: the first exact-peer correlated response satisfies an active waiter once, even when quiet, and is not also queued. Only one outgoing wait is allowed; timeout or cancellation stops waiting, not recipient work. A later threaded response still arrives normally. The tool's existing wait timeout and `PI_INTERCOM_ASK_TIMEOUT_MS` remain unchanged (10 minutes by default).

Acceptance does not mean read, processed, or answered. Native queues and broker mailboxes are volatile, not durable or exactly-once delivery. Receipt timeout or connection loss after dispatch means **unknown**, not definitely undelivered; do not automatically retry uncertain sends. Broadcasts use one live recipient snapshot and report per-recipient outcomes, including partial failure and zero recipients.

Extension outbox results keep operation `status: "failed"` for unconfirmed sends, with `code: "delivery_unknown"`, `delivery: "unknown"`, `outcomeKnown: false`, and the original `messageId`/full `targetId`. This also applies when a runtime ends during dispatch; it is not proof of non-delivery and must not trigger automatic retry.

### Pools

New sessions choose a pool automatically:

- **Inside wmux:** the launching surface's workspace ID (for example, `ws-80334311-2d5d-4f5e-b70d-dc546868f114`), even when peers use different directories.
- **Inside cmux:** the launching workspace's `CMUX_WORKSPACE_ID`, also shared across directories. No CLI lookup is needed.
- **Outside wmux and cmux:** the canonical current working directory.
- **Children:** inherit their parent's pool, including when launched in a different worktree.

`/intercom-pool` shows the current pool. `/intercom-pool <name>` joins a named pool. `/intercom-pool default` explicitly joins the shared default discovery pool. Pool choices survive `/reload`.

Set `PI_INTERCOM_SCOPE_ID` before launch to override automatic selection; an empty value selects the default pool. A failed wmux workspace lookup or missing/empty cmux workspace identity leaves intercom offline rather than silently widening its pool. Retry or select an explicit pool with `/intercom-pool`.

Pools are discovery groups, not direct-delivery isolation boundaries. Names, prefixes, and rosters stay inside the current pool; full session IDs route directly across pools on this broker. Known disconnected exact identities can receive volatile queued messages; waiting requires a live peer. Mail never transfers to a replacement session with the same name or directory.

- `parent`: the immediate spawning session resolved from current-launch metadata; fails clearly without a resolvable parent.
- `workspace`: other connected top-level Pi sessions in the current pool, including named or default pools.
- `global`: other connected top-level Pi sessions across all pools on **this broker**, not other Windows/WSL brokers or SSH hosts.

Broadcasts exclude the sender, all sessions with current parent metadata, and transport-only CLI clients. Children remain directly addressable. The default pool is one shared discovery group, not a global broadcast. These three destination words are reserved: reach a colliding display name by full session ID; literal reserved routing IDs are rejected. Built-in destinations cannot combine with cwd/project-pane targeting.

### CLI

The package also provides `pi-intercom list` and `pi-intercom send --to <session|parent|workspace|global> --text <message>`. Add `--wait` (2 minutes by default, overridable with `--timeout-ms`) for a direct response, `--reply-to <message-id>` to thread an answer, `--quiet` for next-turn delivery, `--active` to wake/steer, and `--json` for machine-readable output. Direct sends default to active; broadcasts default to quiet. The standalone CLI client has no parent, so `--to parent` fails clearly.

Existing SSH text sends remain supported; waiting, quiet delivery, threading, attachments, and group routing over SSH are unsupported, not silently downgraded.

### Coordinated upgrade

Unified messaging requires a compatible broker and receiving sessions. Upgrade all participants, explicitly stop/restart the old broker when it is safe, then reload sessions. Reload/disconnection can interrupt an active wait; it is not recreated or resent. Intercom reports incompatible participants; it never automatically stops a live broker.

Public `ask`, `reply`, `pending`, and `contact_supervisor` are removed, with no aliases. Use `send` with optional `wait`, explicit `to`/`replyTo`, or `to: "parent"` instead. Explicit obsolete receiver settings `inboundTrigger` and `busyDelivery` now fail configuration loading with migration guidance: remove them and choose `quiet` per message. Other settings such as `enabled`, `confirmSend`, and timeout configuration are retained.

## License

MIT. Based on pi-intercom 0.18.1, copyright (c) 2026 Nico Bailon; see [LICENSE](LICENSE).
