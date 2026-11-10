# @strayge/pi-intercom

Direct messaging between pi sessions, imported from pi-intercom 0.18.1.

## Install

```sh
pi install ./extensions/pi-intercom
```

Restart pi after installing. Do not load this package alongside another copy of pi-intercom.

## Usage

- Press **Alt+M** or run `/intercom` to choose a connected session and compose a message.
- Use `/alias <name>` to give your session a recognizable name.
- Use `/intercom-id` to insert your session's stable target into the editor.
- The `intercom` tool supports `list`, `list-cwd`, `send`, `ask`, `reply`, `pending`, `status`, `cancel`, and `handover`.
- Delegated child sessions can expose `contact_supervisor` when pi-subagents supplies bridge metadata.
- The bundled `pi-intercom` skill documents coordination workflows.

Only sessions with the extension loaded and enabled appear in the roster. A local broker starts automatically when needed. Configuration lives in `~/.pi/agent/intercom/config.json` (or under `PI_CODING_AGENT_DIR`).

### Pools

New sessions choose a pool automatically:

- **Inside wmux:** the launching surface's workspace ID (for example, `ws-80334311-2d5d-4f5e-b70d-dc546868f114`), even when peers use different directories.
- **Inside cmux:** the launching workspace's `CMUX_WORKSPACE_ID`, also shared across directories. No CLI lookup is needed.
- **Outside wmux and cmux:** the canonical current working directory.
- **Children:** inherit their parent's pool, including when launched in a different worktree.

`/intercom-pool` shows the current pool. `/intercom-pool <name>` joins a named pool. `/intercom-pool default` explicitly joins the shared **global pool**; both peers must join it to communicate across workspaces or directories. It does not bypass other pools. Pool choices survive `/reload`.

Set `PI_INTERCOM_SCOPE_ID` before launch to override automatic selection; an empty value selects the global pool. A failed wmux workspace lookup or missing/empty cmux workspace identity leaves intercom offline rather than silently widening its pool. Retry or select an explicit pool with `/intercom-pool`.

Sessions in separate pools cannot discover or message each other through the local broker. Existing sessions using the original package remain in their old pools until migrated and restarted.

### CLI

The package also provides `pi-intercom list`, `pi-intercom send --to <session> --text <message>`, and `pi-intercom ask --to <session> --text <message>`. Add `--json` for machine-readable output.

## License

MIT. Based on pi-intercom 0.18.1, copyright (c) 2026 Nico Bailon; see [LICENSE](LICENSE).
