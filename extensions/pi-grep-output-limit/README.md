# pi-grep-output-limit

A [pi](https://pi.dev) extension that limits each built-in `grep` result sent to
the model to **10KB**.

It truncates result content in the `tool_result` event, before Pi stores the
final tool-result message in model context. It does not change `grep`'s match
`limit`, surrounding `context`, pattern, path, or execution behavior.

The extension also adds compact grep guidance to each agent's system prompt:
use narrow paths/globs, start with 20 matches and no surrounding context, switch
to focused reads after locating a match, narrow truncated searches, and avoid
parallel broad greps. The guidance is deduplicated when a child inherits its
parent's prompt.

When truncation occurs, the result ends with:

```text
[Output truncated by pi-grep-output-limit: 10KB maximum.]
```

## Install

Add this package's entry point to Pi's `extensions` setting, or test it directly:

```sh
pi -e "$PWD/extensions/pi-grep-output-limit/src/index.ts"
```

Default `pi-subagents` agents inherit discovered extensions, so the cap also
applies inside those child sessions. Agents configured with `isolated: true`,
`extensions: false`, or an extension denylist do not inherit it.

## Development

```sh
npm test
npm run check
```
