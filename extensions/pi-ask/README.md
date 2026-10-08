# pi-ask

> Vendored fork of [`@eko24ive/pi-ask`](https://github.com/eko24ive/pi-ask) at v1.2.0.
> Upstream history (`.git`, release tooling, `CHANGELOG.md`) was stripped on import.
> Local changes mark question-form factories for input-dialog tracking and defer
> automatic recovery until post-start resource discovery, with regression tests.
> Report fork-specific issues in this repo, upstream issues upstream.

`pi-ask` is an ask tool that cares about your answers.

It lets an agent pause, ask structured questions in a terminal UI, and continue with normalized answers instead of guessing.

## Installation

```bash
pi install npm:@strayge/pi-ask
```

Requires Node.js >=22.19.0 and pi >=1.0.2.

For development, load this checkout directly:

```bash
pi -e ./src/index.ts
```

## Features

- 🧭 Familiar ask-style interface: tabbed questions, single/multi select, and preview mode
- ⭐ Optional warning-colored `(recommended)` markers that do not preselect answers
- ✍️ Inline free-form `Type your own` answers
- 📎 Native pi-style `@` file references inside answer and note editors
- 📝 Question-level and option-level notes
- 👀 Review tab with `Submit`, `Elaborate`, and `Cancel`
- 💬 Elaboration flow to capture note-based clarification before final submission
- ⌨️ Context-aware customizable keymaps with aliases for main flow, editors, and settings
- ⚙️ Ask settings with persisted behaviour, notifications, keymaps, and `/answer` extraction config
- 🔔 Optional external notifications when an ask flow is waiting for input
- 🔁 Slash commands for fallback/replay:
  - `/answer` extracts questions from the latest assistant message into an ask flow
  - `/answer:again` reopens the latest `/answer` form on the current branch
  - `/ask:replay` replays the latest real `ask_user` form on the current branch
- 🛟 Automatic recovery of an unanswered `ask_user` form after startup, resume, or fork
- 🗣️ You can talk to your agent to configure pi-ask; it will read the bundled configuration guide and tailor the config for you

## Use

The extension registers the `ask_user` tool plus `/ask-settings`, `/answer`, `/answer:again`, and `/ask:replay` commands.

Agents can auto-discover and call `ask_user` when they need clarification instead of guessing. They can mark any number of grounded preferences with `recommended: true` and use option descriptions for reasons. In interactive sessions, it opens a terminal UI flow for structured answers, supports native pi-style `@` file references while typing answers or notes, and returns normalized answers back to the agent.

### Answer and replay commands

`/answer` is useful when the agent asked questions in plain text instead of using `ask_user`. It extracts questions from the latest completed assistant message and opens the same ask UI. Kudos to [@k0valik](https://github.com/k0valik) for the `/answer` idea.

Replay commands are branch-aware. They read persisted entries from the current pi session branch, so they work naturally with `/resume`, `/tree`, and conversation branching:

- `/answer:again` reopens the latest form created by `/answer` on this branch
- `/ask:replay` reopens the latest real `ask_user` form on this branch

Cancellation is local to the UI: closing a replayed form does not start a new agent turn. Submitted answers are sent back as a normal user follow-up message.

### Interrupted ask forms

If Pi stops while an `ask_user` form is open, the tool call remains without a result. Starting, resuming, or forking that session reopens the newest unanswered form once. Cancelling dismisses the automatic recovery; `/ask:replay` remains available. New sessions and extension reloads do not trigger recovery.

This package also bundles the `ask-user` skill profile from `skills/ask-user/SKILL.md` (inspired by https://github.com/edlsh/pi-ask-user). It reinforces when to use the tool, is enabled by default when installed, and can be disabled via `pi config`.

## Configuration

Config lives at `~/.pi/agent/pi-ask.json` and is created with defaults on first use. Edit it directly, ask pi to edit it, or toggle behaviour/notification settings in `/ask-settings` (or `?` in-flow). pi-ask treats the config file as user-owned: load-time migrations and invalid files are handled in memory without rewriting it, and read-only configs fail gracefully with a manual-edit message.

Keymaps are context-aware (`global`, `main`, `editor`, `noteEditor`, `settingsModal`); each action accepts a key string or an array of aliases, following pi-tui key ids with common aliases normalized (`escape` → `esc`, `control+c` → `ctrl+c`, …). Fixed bindings that cannot be remapped:

| Key | Context | Effect |
|---|---|---|
| `1..9` | Options list | Select or toggle matching option |
| `1` `2` `3` | Review tab | Trigger `Submit` / `Elaborate` / `Cancel` |
| `@` | Editors | File-reference affordance |
| Arrow keys / `Tab` | Non-empty editor | Stay in editor for cursor movement |

Full settings and keymap reference: [`docs/configuration.md`](docs/configuration.md). Exact input/output and UX guarantees: [`docs/contract.md`](docs/contract.md).

## Local development

```bash
npm install
npm test
npm run typecheck
npm run check
```

Load once for the current run:

```bash
pi -e ./src/index.ts
```

Run isolated (extension + bundled skill only, from `[path]`):

```bash
npm run dev -- [path]
```

## Project layout

- `src/` — TypeScript extension implementation
- `tests/` — behavior-focused tests
- `skills/` — bundled `ask-user` skill profile
- `docs/` — `configuration.md` (settings reference), `contract.md` (behavior guarantees), plus architecture and remote-events notes
