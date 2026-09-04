# pi-usage

Provider usage for [pi](https://github.com/earendil-works/pi): how much of the
current account's quota is left, in the statusline and behind one `/usage`
command.

Supports OpenAI Codex ChatGPT subscription windows and OpenRouter API-key spend
limits, without pretending those limits mean the same thing.

## Commands

| Command | Effect |
| --- | --- |
| `/usage` | Show usage for the current account, with refresh, saved-reset, and display actions |

The command takes no arguments — refresh and display options are menu actions,
not flags.

## What it reports

### OpenAI Codex (`openai-codex`)

Consumer ChatGPT subscription limits, read from the Codex usage endpoint using
pi's resolved runtime authorization: duration-based windows, resets, credits,
earned usage-limit resets, and additional model buckets. When expiration detail
is available, `/usage` groups reset credits by expiration:

```text
Usage limit resets:          2 available · 1 expires 17 Jul (in 12d), 1 never
```

Expiration detail comes from the read-only `/wham/rate-limit-reset-credits`
endpoint and appears only in `/usage`; it does not widen or otherwise change the
statusline. That secondary request is best effort, so if it fails or times out,
the summary count remains visible as `N available` without an expiration
suffix.

When at least one reset is available and the active Codex token identifies its
account, `/usage` offers **Use one reset…**. The action always asks for
confirmation, then lets Codex choose and consume the next available reset
through `/wham/rate-limit-reset-credits/consume`. Every attempt uses an
idempotency key. An uncertain request is recorded in
`usage-redemptions.json` before it is sent and retried with the same key—even
after token refresh or extension reload—so retries continue the same logical
redemption instead of starting another. Invalid, unreadable, or locked state
disables the action rather than silently losing that protection.

The report is fetched again after a definitive response instead of guessing
which limits changed. The backend remains authoritative and may report that
there is no eligible window to reset without consuming a credit.

Statusline: `codex [███┃░░░░] 41% 3h 12m`, or `codex spark [█░░░░░░░] 10%`. The
bucket matching the current Codex model is preferred when one is available. See
[Display options](#display-options) for the other shapes.

There is no Codex CLI fallback: the CLI may be logged into a different account
than pi's active runtime account.

### OpenRouter (`openrouter`)

API-key spend and per-key credit limits — *not* consumer subscription quota —
from [`GET /api/v1/key`](https://openrouter.ai/docs/api/api-reference/api-keys/get-current-api-key):
key label when safely returned, optional limit and remaining amount, reset
period, and daily/weekly/monthly/all-time spend.

Statusline: `openrouter [██░░░░░░] $25.50 used`, or `openrouter $12.75 used`
when the key has no cap to draw a bar against.

OpenRouter bills per token and has no usage windows, so the time-based display
options below have nothing to show there and are skipped.

The account-level `/credits` endpoint is not called; it needs a separate
management key.

## Statusline

The `usage` status covers the selected model's provider only. It refreshes when
the session starts, when the model changes, on each turn, and every five minutes
while the answer stays cached. It clears when the model moves to a provider with
no usage source.

The same text is published as a **statusline slot** named `usage` on pi's shared
event bus, so a statusline extension can place it anywhere rather than leaving
it in the catch-all row. With `pi-statusline` from this repo, name it in your
layout:

```jsonc
{ "type": "slot", "id": "usage", "icon": "📊" }
```

No placement hint is sent, so by default the entry appears exactly where plain
statuses appear. Both channels carry identical text; a statusline that reads the
slot renders one entry, not two, and footers that know nothing about slots keep
working off `ctx.ui.setStatus` unchanged.

The display options below are also **offered to the statusline**, so every one
of them can be set from `/statusline` with a live preview, per placement:

```jsonc
{ "type": "slot", "id": "usage", "options": { "quota": "% only", "bar-width": 20 } }
```

An option you do not set follows `usage.json`, so an untouched slot shows
whatever `/usage` is set to. One you do set wins for that item and is written
back into `usage.json` when you save, keeping the `/usage` report and a stock pi
footer in step with the bar — a change reaches exactly as far as making the same
change in `/usage` does, because it runs the same code.

The quota itself is tinted past 70% and 90% spent, which a statusline that
understands per-segment colors will show; the countdown beside it is left alone.

## Display options

A percentage alone is ambiguous: 95% used with four hours to go is trouble, 95%
with five minutes to go is fine. Both Codex windows have a fixed length, so the
share of the window already elapsed is exact, and the display can show quota and
clock together.

Pick a preset from `/usage` → **Display options…**, or edit `usage.json` in your
agent directory. The panel cycles each row's value in place with Enter or Space,
with a live preview above:

```
 Statusline:  codex [███┃░░░░] 41% 3h 12m
 Report:      [███████┃░░░░░░░░░░░░] 41% used · resets 14:30 (in 3h 12m)

→ Preset                 compact
  Show                   used
  Reset time             on
  Time spacing           3h 12m
  Pace marker            on
  Quota                  bar+%
  Buckets                auto
  Bar width              8
  Statusline projection  off
```

Changing any row moves `Preset` to `custom`; cycling `Preset` back to a named
one resets every other row to it. Everything below is per-preset; the panel is
the discoverable path, not the only one.

| Preset | Statusline |
| --- | --- |
| `legacy` | `codex 59% 5h 61% wk` |
| `minimal` | `codex 41% 3h 12m` |
| `compact` *(default)* | `codex [███┃░░░░] 41% 3h 12m` |
| `full` | `codex 5h [███┃░░░░] 41% 3h 12m · wk [███┃░░░░] 39% 4d` |

`legacy` reproduces the statusline this extension shipped before the display
options existed. The report keeps its relative countdown under every preset — it
has the room.

### The pace marker

`┃` marks where the clock stands inside the bar. Compare it against where the
fill ends:

```
used=41%  elapsed=36%   [████┃░░░░░░░]   fill at the tick — on pace
used=95%  elapsed=20%   [██┃████████░]   fill far past the tick — burning fast
used=95%  elapsed=98%   [███████████┃]   tick past the fill — quota outlasts the window
```

Under `"value": "remaining"` the bar drains instead of filling, so the tick
mirrors and fill *above* it is the healthy side.

### Configuration

```jsonc
{
  "version": 1,
  "preset": "compact",              // legacy | minimal | compact | full | custom
  "value": "used",                  // or "remaining"
  "spacedDuration": true,           // "3h 12m" vs "3h12m"
  "statusline": {
    "fields": ["bar", "percent", "reset"],   // window | bar | percent | reset | projection
    "buckets": "auto",                       // auto | primary | all
    "barWidth": 8,
    "paceMarker": true,
    "separator": " · "
  },
  "report": {
    "fields": ["bar", "percent", "reset", "projection"],
    "barWidth": 20,
    "paceMarker": true
  }
}
```

`preset` picks the baseline and every other key overrides it, so a file naming
only a preset tracks that preset rather than freezing a copy of today's fields.
Unrecognised keys cost you that key and a warning at session start, not the whole
display.

- **`buckets: "auto"`** shows the primary window plus any other one projected to
  run out before it resets. On a normal day that is one window; the line widens
  only when a second one needs watching.
- **`projection`** extrapolates the rate established so far in the window:
  `empty 3m` on the statusline, `empty in ~3m` in the report. It is silent when
  the quota outlasts the window, and off by default on the statusline.
- **Durations** drop the smaller unit once the larger makes it noise: minutes
  vanish at six hours (`7h`), hours vanish at two days (`4d`).
- **A lapsed 5h window** shows no countdown at all. The next window does not
  start until your next message, so there is nothing to count down to; the
  report says `no active window` where it has room to explain.

Switching every field off hides the statusline entry rather than reporting a
failure — an empty display is a choice, not missing data.

## Accounts and caching

Everything is scoped to the account pi is actually using. Auth is resolved
before every query, and a salted fingerprint of that credential keys the cache,
so a report can never be served across accounts: a credential change is a cache
miss, not a stale reading.

Reports are cached for five minutes per provider and credential. The enriched
reset-credit count and expiration detail are part of that same snapshot, not a
separate cache. Returning to an account within that window reuses its own recent
reading rather than re-querying. A failed query backs off for 30 seconds so a
broken endpoint is not retried on every turn.

Queries that outlive their model — because you switched models while one was in
flight — are discarded rather than published.

Credentials resolved for a custom or proxy `baseUrl` are never sent to a
provider's official usage endpoint. This requires pi 0.81.0 or newer, which is
where the resolved-auth origin became inspectable.

## Limitations

- Only providers with a stable usage source and pi-resolvable runtime auth are supported.
- Reports are snapshots and may themselves lag on the provider's side.
- OpenRouter does not expose proactive request-rate counters on successful inference responses.
- A provider may not return a safe human-readable account identity; the provider and credential state stay visible without exposing secrets.
- pi has no account-change event, so a credential swap is picked up on the next turn or scheduled refresh.
- `usage.json` is read at session start, so an edit made by hand outside `/usage` applies to the next session.
- The projection is a straight-line extrapolation of the rate so far in the window; early on it rests on very little history.

## Development

```sh
npm install
npm run check    # biome + tsc --noEmit + tests
npm test
```

## Credit

Derived from [`@narumitw/pi-usage`](https://github.com/narumiruna/pi-extensions)
by narumiruna (MIT), trimmed to the current-account case: the multi-provider
browsing actions, the `/codex-status` alias, and the post-query auth
revalidation were removed. See `LICENSE` for the original copyright.
