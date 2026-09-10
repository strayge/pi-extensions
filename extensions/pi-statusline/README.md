# pi-statusline

A configurable, text-only statusline for [pi](https://github.com/earendil-works/pi).

Replaces pi's built-in footer with a layout you own: lines of items, separators
between them, and a splitter that pins everything after it to the right edge.
No color schemes, no powerline glyphs — values are plain text, with optional
icons you choose per item.

**The shipped default reproduces pi's own footer exactly**, so installing this
extension changes nothing until you edit the layout.

```
~/apps/pi-extensions (main) • refactor-footer
↑12k ↓3.4k R80k W2.0k CH94.1% $0.184 72.3%/200k        (openai) gpt-5 • high
📊 42%  🔎 PR #12
```

## Installation

```bash
pi install npm:@strayge/pi-statusline
```

Requires Node.js >=22.19.0 and pi.

For development, load this checkout directly:

```bash
pi -e ./src/index.ts
```

## Commands

| Command | Effect |
| --- | --- |
| `/statusline` | Open the layout editor (live preview at the top) |
| `/statusline reload` | Re-read the config file from disk |
| `/statusline path` | Print the config file path |

### Editor keys

| Key | Action |
| --- | --- |
| `↑` `↓` | Move between lines |
| `←` `→` | Move between items |
| `ctrl+←` `ctrl+→` / `<` `>` | Move the selected item within its line |
| `ctrl+↑` `ctrl+↓` | Move the selected item to the line above / below |
| `enter` / `e` | Edit the selected item's options |
| `del` / `d` | Delete the selected item |
| `a` | Add an item — every entry shows what it renders, and the highlighted one appears in the preview |
| `,` / `s` | Insert a separator / a left-right splitter |
| `n` / `x` | Add a line / drop the current line |
| `r` | Reset to the default layout |
| `w` / `esc` | Save and close / discard |

`<` and `>` are there for terminals that swallow ctrl+arrows.

The add-item catalog previews every entry from this session — `cwd` shows your
actual directory, `model` your actual model. Items with nothing to show yet fall
back to a marked example (`ex.: 12k`), and structural items are described instead
(`sep — spacer between items`). Live extensions are listed last, after the
built-in types.

## Configuration

The editor writes `~/.pi/agent/statusline.json`; you can also edit it by hand
and run `/statusline reload`. It is a list of lines, each a list of items:

```jsonc
{
  "version": 1,
  "groupGap": 2,
  "lines": [
    [
      { "type": "cwd", "style": "home", "priority": 90 },
      { "type": "branch", "prefix": " (", "suffix": ")" },
      { "type": "sep", "text": " • " },
      { "type": "session" }
    ],
    [
      { "type": "tokens_in", "prefix": "↑" },
      { "type": "sep" },
      { "type": "cost", "prefix": "$", "priority": 80 },
      { "type": "sep" },
      { "type": "context", "priority": 85 },
      { "type": "split" },
      { "type": "model", "priority": 95 },
      { "type": "sep", "text": " • " },
      { "type": "thinking" }
    ],
    [{ "type": "extensions" }]
  ]
}
```

A bare string is shorthand for a type with no options: `"cwd"` means
`{ "type": "cwd" }`. Anything unrecognised is dropped with a warning at startup
rather than breaking the whole statusline.

### Items

| Type | Shows |
| --- | --- |
| `cwd` | Working directory. `style`: `home` (default), `basename`, `full` |
| `branch` | Git branch |
| `git_status` | Working tree summary, e.g. `↑2 ↓3 +2 ~1 ?4` |
| `session` | Session name, when one is set |
| `model` | Model id. `short: true` trims the vendor prefix and date |
| `provider` | Provider. `onlyWhenMultiple` (default `true`) matches stock pi |
| `thinking` | Thinking level. `onlyWhenSupported` (default `true`) |
| `context` | Context meter, assembled from parts — see [The context meter](#the-context-meter) |
| `tokens` | Combined `↑in ↓out` |
| `tokens_in`, `tokens_out` | Input / output token totals |
| `cache_read`, `cache_write`, `cache_hit` | Cache totals and latest hit rate |
| `cost` | Session cost |
| `turn` | Turn count |
| `time` | `format`: `clock` (default) or `elapsed` since session start |
| `tools` | Tools currently executing, e.g. `read×2 bash` |
| `brand` | The `π` mark |
| `extensions` | Catch-all for other extensions (see below) |
| `slot` | One named extension item; needs `id` |
| `text` | A literal string; needs `text` |
| `sep` | Separator between items; `text` defaults to `" "` |
| `split` | Everything after it is right-aligned |

### The context meter

`context` is built from five independent parts rather than a fixed list of
styles, so any combination is reachable:

| Option | Default | Renders |
| --- | --- | --- |
| `showBar` | `false` | `[████░░░░]`, `barWidth` columns wide (default `8`) |
| `showGauge` | `false` | `▅` — one column, eight fill levels |
| `showPercent` | `true` | `51.1%` |
| `showTokens` | `false` | `139k`, the tokens in context |
| `showWindow` | `true` | `272k`, the context window |

They render in a fixed order — bar, gauge, percent, tokens — separated by
spaces, with the window appended to whichever value comes last using
`windowSeparator` (default `"/"`; `" / "` keeps its padding). The window alone
renders as a plain figure, with no separator dangling off nothing.

Two options move the percentage around, both off by default:

| Option | Renders |
| --- | --- |
| `percentAfterWindow` | `139k/272k 51.1%` — past the window instead of before it |
| `percentParens` | `(51.1%) 139k/272k` — wrapped |
| both | `139k/272k (51.1%)` |

Only `showPercent` and `showWindow` are on by default, so an untouched
`{ "type": "context" }` still reads `51.1%/272k`, exactly as before. Because the
parts are independent, showing tokens *instead of* percent takes two keys:
`{ "showTokens": true, "showPercent": false }`.

```
{ }                                                  51.1%/272k
{ "showWindow": false }                              51.1%
{ "showPercent": false, "showTokens": true }         139k/272k
{ "showTokens": true, "showWindow": false }          51.1% 139k
{ "showBar": true, "showPercent": false }            [████░░░░] 272k
{ "showBar": true, "showWindow": false }             [████░░░░] 51.1%
{ "showGauge": true, "showWindow": false }           ▅ 51.1%
{ "showGauge": true, "showPercent": false, "showWindow": false }   ▅
{ "showBar": true, "showTokens": true }              [████░░░░] 51.1% 139k/272k
{ "windowSeparator": " / " }                         51.1% / 272k
{ "showTokens": true, "percentAfterWindow": true, "percentParens": true }
                                                     139k/272k (51.1%)
```

`▁▂▃▄▅▆▇█` are Block Elements, which are never double-width, so the gauge costs
exactly one column in every terminal.

Every one of these is editable from `/statusline` — select the `context` item,
press Enter, and the preview at the top updates as you toggle.

After a compaction the token count is unknown until the next response. A bar or
gauge cannot express that, so they drop out and the value group collapses to a
single `?` — `?/272k` rather than `? ?`. The window is a property of the model
rather than the count, so it survives. `percentAfterWindow` and `percentParens`
sit this out: they describe how two known values relate, and there is nothing
to relate.

`threshold` (default `true`) tints the whole item past 70% and 90%, whatever
shape it has.

`hideWhenZero` (default `false`) drops the item entirely while the context is
still empty — a fresh session shows nothing at all rather than `0.0%/272k`, and
the meter appears with the first response. The window goes with it: with nothing
in the context there is no count for it to qualify. An unknown count is not a
zero one, so the `?` after a compaction is unaffected.

#### Marking a cold prompt cache

Leave a session idle long enough and the provider drops its prompt cache, so the
next message pays to write the whole context again instead of reading it back.
`coldStyle` marks that on the meter *before* the cost is paid:

| Option | Default | Meaning |
| --- | --- | --- |
| `coldStyle` | `"off"` | `"off"`, `"symbol"`, `"color"`, or `"both"` |
| `coldAfterMinutes` | `60` | Idle minutes before the cache counts as cold (1–1440) |
| `coldMarker` | `"❄ "` | The leading glyph for `symbol` and `both` |
| `coldColor` | `"accent"` | The tint for `color` and `both` |

```
{ "coldStyle": "symbol" }                            ❄ 51.1%/272k
{ "coldStyle": "color" }                             51.1%/272k     (in accent)
{ "coldStyle": "both" }                              ❄ 51.1%/272k   (in accent)
{ "coldStyle": "symbol", "coldMarker": "~" }         ~51.1%/272k
```

`color` and `both` outrank both `threshold` and the item's own `color`: those
describe how the meter looks at rest, while a cache that just expired is news
about what the next request costs. (Ranking `coldColor` below `color` would mean
it did nothing at all on any item that set one — a trap rather than a precedence
rule, given the two keys sit next to each other in the editor.) `symbol` says it
without spending the color, so a full-and-cold context can read `❄ 95.0%/272k`
in threshold red.

Off by default, so an existing layout looks the same after an upgrade. All four
are editable from `/statusline`.

The clock starts at the last assistant message, and a resumed session reads that
from its own entries — reopening yesterday's session shows the marker on the
first frame, which is the case it exists for. Nothing is marked before a session's
first response, or while the context is still empty: there is no cache yet to
expire. Going cold is the one thing here that happens while nothing else is
going on, so a single timer is armed for the exact moment of the transition
rather than polling.

`coldAfterMinutes` is a guess about someone else's cache, not a fact. An hour
matches what Anthropic and Codex retain. Note that pi's own built-in
`showCacheMissNotices` setting measures the same gap against a hard-coded five
minutes, so with both switched on the two can disagree about what counts as a
miss.

The default `❄` (U+2744, no variation selector) measures one column under pi's
`visibleWidth`, so `"❄ "` costs two. Adding a variation selector (`❄️`) makes it
two columns on its own — if a terminal draws the bare glyph wide, set
`coldMarker` to something like `"~"` or `"° "` instead.

### Item options

Every item accepts `icon`, `prefix`, `suffix`, `color`, `bold`, `hidden` and
`priority`. Values render as `prefix` + `icon` + value + `suffix`.

`sep` is the exception: its text is emitted verbatim, so it takes only `color`,
`bold`, `hidden` and `priority`. Decoration on a separator is dropped with a
warning rather than silently doing nothing.

`color` takes a theme color name (`dim`, `muted`, `text`, `accent`, `success`,
`warning`, `error`, `mdLink`) or `auto`, the default — which means `dim`,
matching stock pi, except for `context`, which tints itself past 70% and 90%.
Any other name is dropped with a warning.

### Lines, separators, and the splitter

An item with nothing to say disappears, taking its `prefix`, `suffix`, and any
adjacent separator with it — that is how ` (main)` and ` • name` come and go
cleanly. A line where everything is empty is not rendered at all.

One `split` gives you left and right groups; a second gives left, center, and
right. Groups keep their alignment even when their neighbours are empty, so the
model stays pinned to the right edge on a narrow terminal.

### Narrow terminals

When a line does not fit, the lowest-`priority` items are dropped one at a time
(ties break toward the right) until it does; the remainder is truncated with `…`.
The last item standing is never dropped, only truncated. Default priority is
`50`; the default layout gives `model` 95, `cwd` 90, `context` 85, `cost` 80.

## Extension slots

Other extensions can put their own text in the statusline over pi's shared event
bus. A producer publishes an item and may suggest where it belongs; the
suggestion is only a default — if your config names the id, your placement wins.

```typescript
pi.events.emit("statusline:publish", {
  id: "usage",
  text: "42%",
  icon: "📊",
  color: "muted",
  priority: 40,
  defaultPlacement: { line: 1, side: "right", order: 10 },  // a hint
});

pi.events.emit("statusline:clear", { id: "usage" });
```

`src/publish.ts` wraps this in a small helper that also re-publishes when the
statusline asks (`statusline:request`, emitted at session start, which covers
extensions that loaded before it). The file depends on nothing else here, so
copy it into your own extension rather than taking a dependency:

```typescript
const publish = publishStatuslineItem(pi, {
  id: "usage",
  icon: "📊",
  defaultPlacement: { line: 1, side: "right" },
});
publish("42%");       // show
publish(undefined);   // hide
```

`pi-usage` in this repo publishes its `usage` slot exactly this way, so
`{ "type": "slot", "id": "usage" }` places it anywhere you like. You do not have
to type that by hand: any extension currently saying something appears at the end
of the `a` catalog in the editor as `slot:<id>`, with its current text alongside.

### Extension-owned options

A producer can go further and register an option schema plus the function that
draws with it. Its settings then appear in `/statusline` alongside the built-in
ones, and the preview at the top updates as you cycle them — because the
statusline calls back into the extension with the values you have not saved yet.

```typescript
const slot = registerStatuslineSlot(pi, {
  id: "usage",
  version: 1,
  fields: [
    { key: "quota", label: "quota", kind: "enum", options: ["bar+%", "% only", "off"] },
    { key: "barWidth", label: "bar width", kind: "number", min: 1, max: 40 },
  ],
  defaults: () => ({ quota: currentQuotaMode(), barWidth: config.barWidth }),
  render: (options, env) => [
    { text: bar(options), color: "warning" },
    { text: ` ${percent(options)}` },
  ],
  onOptions: (options) => save({ ...config, ...options }),
});
```

Values live in the item, so two placements of the same slot can differ:

```jsonc
{ "type": "slot", "id": "usage", "options": { "quota": "% only", "barWidth": 20 } }
```

| Piece | What it does |
| --- | --- |
| `fields` | The rows the editor shows. `string`, `number`, `boolean`, `enum` |
| `defaults` | Your current values. An untouched field reads `(8)` and follows them |
| `render` | Called on every paint, and per keypress while editing. Must be pure |
| `onOptions` | The saved values, so your own config can mirror them |
| `version` | Bump when a key changes meaning |

`render` returns a string, a list of `{ text, color }` segments, or
`{ segments, icon }` — `undefined` hides the item. It runs inside pi's paint
path, so it is held to that: escapes are stripped, control characters removed,
colors checked against the palette, and a throw costs the slot rather than the
session (reported the next time you open `/statusline`). Set `color` on the item
itself and it overrides every segment; leave it `auto` and the producer's
tinting shows through.

`env.preview` is true while the editor is drawing, which lets an extension stand
in for data it has not fetched yet — `pi-usage` shows a sample quota so its
options are legible before the first query returns.

An option you have not set is simply absent, and the extension applies its own
default, so a bare `{ "type": "slot", "id": "usage" }` tracks whatever `/usage`
is set to. Set one and it wins for that item, and is pushed back to the
extension on save so its other surfaces agree. Options are only pushed when they
actually change: a reload that read the same file back rewrites nothing.

A slot in the `extensions` catch-all has nowhere to carry options, so it renders
with the extension's own defaults.

The layout editor offers every slot published at least once this session, so one
that only appears under some condition — a warning, a lifted restriction — can
still be placed while it is quiet. It shows as `(no value yet)` until it speaks
again.

Placement rules, in order:

1. A `{ "type": "slot", "id": "usage" }` item in your config wins outright.
2. Otherwise `defaultPlacement` puts it on that line and side.
3. Otherwise it joins the `extensions` catch-all.

Extensions that know nothing about this protocol still work: anything set with
`ctx.ui.setStatus(key, text)` shows up in the `extensions` item, and a `slot`
item whose `id` matches a status key places that extension exactly where you
want it.

The `extensions` item takes `include`, `exclude`, `icons` (per-key), and
`separator`. Keys placed by name elsewhere are never repeated in it, and an
extension that both publishes a slot and calls `setStatus` under the same name —
the recommended way to stay readable on a stock pi footer — renders once, using
the slot.

## Differences from pi's built-in footer

Two markers are deliberately left out: the `(sub)` suffix on cost for
subscription-backed providers and the `(auto)` suffix on context when
auto-compaction is on. Neither value is reachable from the extension API.

## Development

```sh
npm install
npm run check    # biome + tsc --noEmit + tests
npm test
```
