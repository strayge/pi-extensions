# pi-builtin-tool-limits

A [Pi](https://pi.dev) extension that replaces five built-in tools with wrappers
using fixed, context-safe output limits:

| Tool | Hard count limit | Hard text limit | Retention |
| --- | ---: | ---: | --- |
| `read` | 1,000 lines | 10 KiB | Head |
| `bash` | 1,000 lines | 10 KiB | Tail |
| `grep` | 100 matches | 10 KiB | Head |
| `find` | 200 results | 10 KiB | Head |
| `ls` | 500 entries | 10 KiB | Head |

`grep` also retains Pi's 500-character per-output-line cap. `read` keeps
continuation notices and accurate `offset` values after either hard limit.
When `bash` output is truncated, the complete raw stdout/stderr stream is saved
to a unique `pi-bash-*.log` temporary file. The file is created only after a
hard limit is crossed and is closed on every completion path.

Explicit `limit` arguments above a hard cap are reduced to that cap. Lower
explicit limits remain unchanged. `edit` and `write` are not overridden.

The wrappers use Pi's public built-in tool definition factories, preserving
schemas, path handling, image support, shell/search behavior, `.gitignore`
handling, renderers, and result metadata. There is no configuration file and
no compatibility package.

## Install

```sh
pi install npm:@strayge/pi-builtin-tool-limits
```

Requires Node.js >=22.19.0.

For development, load this checkout directly:

```sh
pi -e "$PWD/extensions/pi-builtin-tool-limits/src/index.ts"
```

## Development

```sh
npm install
npm test
npm run check
```
