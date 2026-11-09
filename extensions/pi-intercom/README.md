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

`/intercom-pool` shows the current session pool. `/intercom-pool <name>` joins a named pool, and `/intercom-pool default` returns to the default pool. Sessions in separate pools cannot see or message each other through the local broker. Children inherit their parent's pool through `PI_INTERCOM_SCOPE_ID`.

### CLI

The package also provides `pi-intercom list`, `pi-intercom send --to <session> --text <message>`, and `pi-intercom ask --to <session> --text <message>`. Add `--json` for machine-readable output.

## License

MIT. Based on pi-intercom 0.18.1, copyright (c) 2026 Nico Bailon; see [LICENSE](LICENSE).
