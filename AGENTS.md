# pi-extensions

Extensions for the [pi](https://github.com/earendil-works/pi) coding agent.
Each extension lives in `extensions/pi-<name>/` as its own npm package
(TypeScript, `src/index.ts` as the pi entry point, biome + `tsc --noEmit`).

## Commit messages

Use a Conventional Commit prefix and extension scope: `<type>(<scope>): <summary>`,
for example `fix(permissions): hide project grants notice in subagents`.

## vendor/ — local reference material

`vendor/` is git-ignored: it holds read-only reference material, never
project source. Consult it before guessing at pi's extension API.

- `vendor/docs` — symlink to the installed `@earendil-works/pi-coding-agent`
  docs. `extensions.md` is the extension API reference; also useful are
  `packages.md`, `settings.md`, `themes.md`, `tui.md`, and `sdk.md`.
- `vendor/examples` — symlink to that same package's examples.
  `examples/extensions/` has small single-file extensions covering hooks,
  custom tools, footers/headers, renderers, and custom providers.
- `vendor/narumiruna-pi-extensions` — local clone of the `narumiruna/pi-extensions`
  repo, a real-world example of a multi-extension repo. Reference only; the
  extensions here are ours.

Both symlinks point at the current nvm-installed pi and must be recreated
after installing or upgrading pi — see the README for the command.

## Creating an extension

`extensions/pi-<name>/`, self-contained — directory name, package name, and
`pi-` prefix all match. No root workspace or shared tooling: copy `biome.json`
and `tsconfig.json` from an existing extension, alongside `package.json`
(`pi.extensions` pointing at `./src/index.ts`), `src/`, and `test/`.

- Import relative modules with `.ts` specifiers (`./config.ts`). Both pi's
  loader and `node --test --experimental-strip-types` need them; `./config.js`
  will not resolve to a `.ts` file.
- `erasableSyntaxOnly` bans TS parameter properties — `constructor(private x)`
  fails with TS1294. Declare the field and assign in the body.
- Tests: `node --test --experimental-strip-types test/*.test.ts`. Keep any build
  output out of `node_modules/`; the test runner skips everything under it.
- Vendored or upstream code needs its own `biome.json` — upstream repos keep
  theirs at their root, so without one biome silently reformats to its defaults
  and reports errors in files nobody touched.

Smoke-test a real load before calling an extension done. This runs it under
pi's own loader and exits, catching import errors and registration failures:

```sh
pi -e "$PWD/extensions/pi-<name>/src/index.ts" --no-session --model openai-codex/gpt-5.6-luna:low -p 'reply with just: ok'
```

## Rendering: an over-wide line kills the session

```
Error: Rendered line 22 exceeds terminal width (200 > 163).
```

pi treats this as a fatal `uncaughtException`, so every line a custom component
returns — footer, header, widget, `ui.custom` — must fit the width it was given.

- Measure with `visibleWidth`, cut with `truncateToWidth`, both from
  `@earendil-works/pi-tui`. `truncateToWidth` appends an ANSI reset *after* the
  ellipsis, so assert on `visibleWidth`, never on `.endsWith("…")`.
- Style per item, not per line: an inner reset — from another extension's
  colored status, say — cancels an outer `theme.fg("dim", …)` for the remainder
  of the line.
- Match keys with `matchesKey(data, "ctrl+left")` rather than raw escape
  sequences; xterm, legacy, and Kitty encodings differ, and hardcoded arrows
  break under the Kitty protocol.
- Rendering with the real theme outside a session (scratch scripts, tests)
  needs `initTheme("dark")` first, or `theme.fg` throws "Theme not initialized".

## When the docs are silent, read pi's dist/

```sh
PI_PKG=$(dirname "$(dirname "$(readlink -f "$(command -v pi)")")")
```

`$PI_PKG/dist/` is the compiled source and answers what the docs do not:
`modes/interactive/components/footer.js` for the stock footer's exact layout,
`interactive-mode.js` for `setFooter` semantics (the previous component is
disposed *before* the new factory runs, so re-installing per session is safe).

Known gaps in `ExtensionContext`: no `modelRuntime` (so no subscription/OAuth
detection) and no auto-compact state. `footerData` is handed only to the
`setFooter` factory — capture it if anything else needs it. `pi-usage` reaches
provider auth through duck-typed casts onto `modelRegistry`
(`getApiKeyAndHeaders`, `getProviderAuth`) that are not in the public surface
and can break on a pi upgrade.

## Cross-extension statusline slots

Extensions publish placeable statusline items over `pi.events`
(`statusline:publish` / `statusline:clear`, re-published on `statusline:request`
so load order between extensions does not matter). The protocol and a copyable
helper live in `extensions/pi-statusline/README.md` and `src/publish.ts`;
`extensions/pi-usage/src/statusline-slot.ts` is a working producer.
Every slot message must carry the publishing session's id as `owner` (from
`ctx.sessionManager.getSessionId()`), otherwise the statusline drops it silently.

`ctx.ui.setStatus` keeps working unchanged — publishing a slot only adds the
ability to place the entry at an exact spot in the bar.
