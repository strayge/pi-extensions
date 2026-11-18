---
name: pi-intercom
description: Coordinate pi sessions through direct messages, optional blocking responses, parent decisions, scoped broadcasts, attachments, and handovers. Use for cross-session help, delegation, and context sharing on the same broker.
---

# Pi Intercom

Use `send` for both new messages and answers. A response always names its recipient
and explicitly carries `replyTo`; intercom never infers either from pending work.

## Discover and address peers

```ts
intercom({ action: "list" });
intercom({ action: "status" });
```

`list` shows the current pool's live peers, status, and available terminal location.
Choose a peer from that roster and supply an explicit `to`; directories are metadata,
not recipients. Missing recipients never infer a peer or broadcast.
Use full session IDs from incoming messages/results for exact routing. Names and
abbreviated IDs/names resolve only inside your pool; full IDs can cross pools on
this broker. Never use terminal pane IDs as intercom addresses. `/alias <name>`
gives your session a recognizable display name; `/intercom-id` inserts its target.

Pools are discovery groups, not delivery isolation. At launch they follow the
wmux/cmux workspace, or canonical cwd outside both. Children inherit their parent's
pool even in another worktree. `/intercom-pool` shows the pool; `/intercom-pool <name>`
changes it; `/intercom-pool default` joins the shared default discovery group.
Explicit `PI_INTERCOM_SCOPE_ID` overrides automatic selection (empty means default).
Choices survive reload; failed workspace detection leaves intercom offline rather
than widening discovery. The default pool is not an all-pools broadcast.

Reserved destinations:

- `parent`: your immediate spawning session, resolved from **current-launch parent
  metadata** supplied by the launcher (pi-subagents supplies it). No name guessing
  or saved transcript ancestry. Fails clearly without a resolvable parent.
- `workspace`: other connected top-level Pi sessions in your current pool,
  including explicitly selected named/default pools.
- `global`: other connected top-level Pi sessions across all pools on this broker.
  Not separate Windows/WSL brokers or SSH hosts.

Reserved words cannot address a peer by display name; use its full session ID.
Literal reserved routing IDs are rejected. Broadcasts exclude self, **all** sessions
with current parent metadata, and transport-only CLI clients. Children remain
reachable by direct ID.

## Send, wait, answer

```ts
intercom({ action: "send", to: "<full-peer-id>", message: "Review the API change" });
intercom({ action: "send", to: "parent", message: "Which API should I use?", wait: true });
intercom({
  action: "send",
  to: "<full-sender-id>",
  replyTo: "<incoming-message-id>",
  message: "Use the stable API",
});
```

Copy the full sender ID and message ID from the inbound message/reply hint.
`replyTo` can reference any earlier message, including ordinary sends or messages
whose wait has expired. It is correlation, not permission or a pending-request key.
A new unthreaded message does not automatically answer anyone.

- `wait` defaults to false; true requires a live direct peer or parent.
- Only one outgoing wait per session; self/mutual blocking waits are rejected.
- The first exact-peer correlated response satisfies the wait once, including a
  clarification. Unrelated messages do not satisfy it.
- Timeout/Escape ends **only waiting**, never recipient work. Explicit cancellation
  is separate. Later responses still arrive as ordinary threaded messages.
- Reload/disconnection can interrupt waiting; requests are not recreated or resent.
- Existing timeout settings and `PI_INTERCOM_ASK_TIMEOUT_MS` are unchanged
  (10 minutes by default). For long tasks, send updates instead of holding a wait.

Children use `send` to `parent` for owner decisions and meaningful updates. Add
`wait: true` only when blocked on an answer. Return routine completion through the
normal subagent result path; do not invent a second result/supervisor protocol.

## Delivery and broadcasts

Direct messages default to **active**: wake an idle peer or steer busy work at a
supported boundary without aborting it. `quiet: true` uses Pi's native next-turn
queue without waking, steering, or automatically acknowledging conversationally.
The next user- or active-message-started run can consume it; it need not appear in
the transcript before then. Exception: a quiet exact-peer correlated response to
an active waiter goes once to the wait result, not also into the native queue.
`wait: true` plus `quiet: true` is invalid.

```ts
intercom({ action: "send", to: "workspace", message: "Validation complete" });
intercom({ action: "send", to: "global", message: "Shared service unavailable", quiet: false });
```

Broadcasts default to **quiet**; explicit false makes them active. They are new
asynchronous messages: no `wait`, `replyTo`, `supersedes`, or `retryOf`. One live
recipient snapshot produces per-recipient message IDs/outcomes, including partial
failure and zero recipients. An answer threads to the actual delivered message
ID. Abort stops unsent deliveries, not ones already dispatched.

Acceptance means retained by the receiving extension/native delivery path, **not
read, processed, or answered**. Broker mailboxes, native queues, and temporary
compaction holds are volatile; there is no durable inbox or exactly-once promise.
Nonwaiting sends can queue for a known disconnected exact identity, never a new
session with the same name/cwd. Unknown identities fail. Receipt timeout means
**unknown**, not definitely undelivered: do not automatically retry uncertain sends.

With `confirmSend`, interactive sessions confirm new sends and broadcasts (one
confirmation for the snapshot); explicit threaded responses skip confirmation.

## Attachments, cancellation, and handover

```ts
intercom({
  action: "send", to: "<full-peer-id>", message: "Relevant context",
  attachments: [{ type: "snippet", name: "auth.ts", language: "typescript", content: "..." }],
});
intercom({ action: "cancel", messageId: "<sent-message-id>" });
intercom({ action: "handover", to: "<full-peer-id>", message: "Continue the adapter fix" });
```

Attachments support `file`, `snippet`, and `context` with inline content. Explicit
`cancel` is best-effort, not a rollback. Direct sends can carry `supersedes` or an
explicit user-authored `retryOf` for the same sender/receiver; retries use new IDs.
Handover summarizes the current branch with the current model and sends a new
active, nonwaiting message to a direct recipient. It cannot carry reply/retry
relationships or attachments. `/handover <target> [next task]` lets humans review
before sending; `/handover` opens the picker.

Existing `agent@machine` SSH text sends retain their existing capability level:
no waiting, quiet delivery, threading, attachments, or group routing over SSH.
Do not silently drop unsupported options or assume cross-broker discovery.

## Migration and troubleshooting

Directory targeting and automatic project launch are removed. `list-cwd`, `cwd`,
`openProjectPaneIfMissing`, and `focus` are unsupported, even alongside `to`.
Use `list`, then an explicit peer recipient; `/handover` rejects project paths.
Working-directory metadata and cwd-based pool fallback remain unchanged.

Public `ask`, `reply`, `pending`, and `contact_supervisor` are removed without
aliases. Use only `send`, optional `wait`, explicit `to`/`replyTo`, and `parent`.
Obsolete receiver config keys `inboundTrigger` and `busyDelivery` fail with
migration guidance: remove them and choose `quiet` per send. `enabled`,
`confirmSend`, and timeout settings remain supported.

If a name is missing, check `status`, extension loading, and pool membership; a
known full ID can route across pools without changing either pool. Never guess a
replacement identity. If participants are incompatible, coordinate upgrading all
clients and safely restarting the old broker, then reload sessions. Do not stop a
live broker automatically or retry unknown deliveries as fresh messages.
