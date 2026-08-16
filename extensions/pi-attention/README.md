# pi-attention

Chimes when a pi turn finishes **while your terminal is not focused**, so you can
switch away and get pulled back only when there is something to look at.

Focus is tracked through xterm focus reporting (`CSI ?1004h`), so the terminal
must support it: Kitty, Ghostty, iTerm2, WezTerm, Windows Terminal, foot,
Alacritty, and most other modern emulators do.

Only the session that owns the terminal chimes. Subagent runners (for example
`@tintinweb/pi-subagents`) load every discovered extension into each nested
session, and those sessions emit their own `agent_settled`. The runner marks its
proxied child UI context with the `Symbol.for("pi-subagents:child-extension-ui")`
protocol, so a finishing subagent stays silent even though it inherits TUI mode
to forward permission dialogs.

## Install

```bash
pi install ./extensions/pi-attention     # from a checkout
pi -e ./extensions/pi-attention          # try it for one run, without installing
```

## Commands

| Command | Effect |
| --- | --- |
| `/attention` | Show the current focus state (`focused`, `blurred`, `unknown`) |
| `/attention test` | Fire the chime and bell immediately, regardless of focus |

## Sound

A two-note "bip-bop" played through `play` (SoX): two 50 ms exponential sine
sweeps 190 ms apart, rising 625 → 1877 Hz and 556 → 1509 Hz. If SoX is not
installed the spawn fails silently and only the terminal bell (`\x07`) remains,
so the extension stays usable without it.

To make it quieter, lower the two `vol` values in `src/index.ts` — they are
currently 0.32 and 0.29.

Install SoX with `apt install sox`, `brew install sox`, or your package manager
of choice.

## Development

```bash
npm install
npm run check     # biome + tsc --noEmit
npm run format    # biome check --write
```

Pi loads extensions through [jiti](https://github.com/unjs/jiti), so the
TypeScript in `src/` runs as-is — there is no build step and nothing to compile
before installing.
