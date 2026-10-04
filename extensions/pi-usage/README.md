# pi-usage

Provider usage for [pi](https://github.com/earendil-works/pi): how much of the
current account's quota is left, in the statusline and behind one `/usage`
command.

Supports OpenAI ChatGPT subscription windows for `/login openai` (`openai`)
and legacy `openai-codex` sessions, OpenRouter API-key spend limits, and OpenCode
Go usage windows, without pretending those limits mean the same thing.

## Installation

```bash
pi install npm:@strayge/pi-usage
```

Requires Node.js >=22.19.0 and pi >=1.0.2.

For development, load this checkout directly:

```bash
pi -e ./src/index.ts
```

## Commands

| Command | Effect |
| --- | --- |
| `/usage` | Show current usage, historical usage, refresh, saved-reset, and display actions |

The command takes no arguments — history, refresh, and display options are menu
actions, not flags.

## What it reports

### OpenAI ChatGPT subscription (`openai`, legacy `openai-codex`)

Consumer ChatGPT subscription limits, read from the Codex usage endpoint using
pi's resolved runtime authorization for both provider IDs: duration-based
windows, resets, credits, earned usage-limit resets, and additional model
buckets. When expiration detail is available, `/usage` groups reset credits by
expiration:

```text
Usage limit resets:          2 available · 1 expires 17 Jul (in 12d), 1 never
```

Expiration detail comes from the read-only `/wham/rate-limit-reset-credits`
endpoint and appears only in `/usage`; it does not widen or otherwise change the
statusline. That secondary request is best effort, so if it fails or times out,
the summary count remains visible as `N available` without an expiration
suffix.

When at least one reset is available and the active ChatGPT subscription token
identifies its account, `/usage` offers **Use one reset…**. The action always
asks for confirmation, then lets the OpenAI backend choose and consume the next
available reset through `/wham/rate-limit-reset-credits/consume`. Every attempt
uses an idempotency key. An uncertain request is recorded in
`usage-redemptions.json` before it is sent and retried with the same key—even
after token refresh or extension reload—so retries continue the same logical
redemption instead of starting another. Invalid, unreadable, or locked state
disables the action rather than silently losing that protection.

The report is fetched again after a definitive response instead of guessing
which limits changed. The backend remains authoritative and may report that
there is no eligible window to reset without consuming a credit.

Ordinary OpenAI API keys are unsupported here and are never sent to ChatGPT
usage endpoints.

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

### OpenCode Go (`opencode-go`)

Usage windows are fetched from OpenCode Go's JSON usage endpoint using the same
bearer token Pi resolves for the active OpenCode Go model:
`https://opencode.ai/zen/go/v1/usage`. The response contains rolling, weekly,
and monthly windows, each with a percentage used and reset time. The extension
requires all three windows to be valid before publishing a snapshot.

Statusline: `opencode-go [███░░░░░] 41% 4h`, with window names and additional
windows shown when selected by the display configuration. No separate OpenCode
configuration file or dashboard cookie is read; credentials remain scoped to
Pi's runtime auth.

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
provider's official usage endpoint. The extension requires pi 1.0.2 or newer; this behavior uses pi's
resolved-auth origin inspection.

## Historical usage

Choose **Statistics** from `/usage` to inspect a compact inline, read-only
historical panel. It opens on **Models** for the rolling **1d** range. Up/Down
selects the Tabs and Range rows; Left/Right changes that row's choice.
Ctrl+Up/Down scrolls the report, and Escape returns to `/usage`. Tab and
Shift+Tab remain shortcuts for changing tabs, while 1–7 remain hidden range
shortcuts. The range ends at one fixed time captured when history is
loaded. The three tabs answer different questions:

- **Models** groups token and recorded-cost totals by exact `provider/model`
  route.
- **Cache** shows the cache headlines and the complete per-model message-gap
  table.
- **Quotas** shows every visible provider in one report, with compact stacked
  quota observations, observed consumption and resets, and eligible empirical
  capacity estimates. Empty limits are omitted, and Codex history shows only the
  main Codex quota group rather than model-specific groups. Every non-empty
  identity is included; multiple identities use anonymous `Account 1`,
  `Account 2`, and so on. Identity IDs and provider account labels are never
  displayed.

Models and Cache include activity from every provider. Quota
movement and capacity are provider-specific: calls from one provider never
contribute to another provider's estimate, and quota percentages are never
summed across providers or identities. Invoking `/usage` still performs its
normal live query/cache, status update, and fresh-success snapshot workflow.
After that workflow, loading history and navigating its tabs or ranges makes no
additional provider request, status write, or snapshot; the
live `/usage` report is display-only current context.

The cache headlines use these formulas:

```text
cached input share = cacheRead / (input + cacheRead + cacheWrite)
calls reading cache = calls with cacheRead > 0 / all model calls
```

A zero denominator is shown as `—`. The message-gap table estimates meaningful
reuse within each source conversation and exact provider/model route: compare
adjacent calls, add the earlier call's input, cache-read, cache-write, and output
tokens as its preceding context, and count a hit when the later call's
cache-read is at least half that context. Results are split into `<1m`, `1–5m`,
`5–10m`, `10–30m`, `30–60m`, and `1h+`, with both percentage and sample count.
Missing or negative gaps and zero preceding contexts do not become samples.

Persisted Pi session JSONL is the primary activity source, including active
in-memory entries. Temporary `pi-subagents` `.output` transcripts are a
best-available fallback for calls without a matching persisted call. Verified
fork/clone copies are deduplicated within their session lineage, snapshots are
deduplicated globally by `observationId`, and an unambiguous persisted subagent
call suppresses its matching transcript copy. Ambiguous associations are kept
rather than silently undercounted and can produce a concise warning.

Quota observations stay separated by provider, identity kind/id, and bucket.
When historical calls cannot be correlated conservatively to one identity,
capacity is omitted instead of assigning them to whichever credential is
current now. For an eligible bucket, the uniform extrapolation is:

```text
empirical 100% tokens = matching-provider tokens × 100 / observed consumed percent
empirical 100% cost = matching-provider recorded cost × 100 / observed consumed percent
```

The cost estimate is omitted unless matching calls contain positive recorded
cost. Both estimates are omitted when consumption is non-positive, call timing
is unusable, identity correlation is ambiguous, the bucket has no meaningful
100% limit, or snapshots do not adequately bracket provider activity. A nearby
inner boundary may be used within 30 minutes with a warning; stale or missing
boundaries can omit only the affected bucket. A sampling gap longer than a full
quota window keeps an otherwise valid estimate but labels it a lower bound.
These are empirical 100%-equivalents, not provider billing rules or guaranteed
future capacity.

Main Codex weekly buckets also show per-model historical averages for the
**selected range**, in API-equivalent dollars, without replacing the aggregate
estimate. Each row includes the model's full recorded cost in that range and
supporting sample cost, quota percentage points, and qualifying interval count:

```text
model weekly 100% cost = sample recorded cost × 100 / sample quota consumption (pp)
```

Samples use only active measurement windows of up to 15 minutes where that exact
provider/model accounts for at least 95% of recorded dollar cost. Active windows
with zero quota movement still contribute sample cost; quota movement in windows
without Pi activity is ignored. This assumes Pi's prices are approximately right
and small helper-model activity can be ignored. Unsupported estimates show
`insufficient data`, not a permanent model value or a subscription billing price.
Reset-crossing gaps, missing prices, imprecise timing, and ambiguous account
correlation are excluded. Adjacent samples dominated by the same model are
combined for calibration, with dollar costs counted once and the 95% threshold
checked again for the combined period. Dominant-model requests must fit entirely
within that period, so whole-request costs are never paired with partial quota
movement. Supporting cost and quota cover qualifying samples, not necessarily
all activity in the selected range.

Historical coverage is deliberately not claimed to be complete. Snapshot
sampling is irregular and active-session-driven, so peaks, resets, and
consumption can be missed. Account quota can include usage by clients outside
Pi, while local calls do not retain their historical credential identity.
Recorded cost may be zero because historical pricing is partial; the extension
does not invent prices. Temporary subagent output can be disabled, removed, or
not yet flushed, arbitrary custom session directories are not globally
discoverable, and ephemeral compaction work is absent from `.output`.

## Usage snapshots

Each fresh successful usage fetch appends a `custom` entry named
`pi-usage:snapshot` to the current session through Pi's session API. Cache hits,
failed queries, cancelled queries, and results that outlive their selected model
do not produce snapshots. Recording does not add provider requests or change the
five-minute refresh interval.

Snapshot data contains:

- `version: 1` and a unique `observationId` for recognizing copies inherited by
  forks or clones;
- `identity: { kind, id }`, where `id` is a 24-character hexadecimal hash prefix
  (96 bits). `kind: "account"` uses the existing hashed Codex account ID when
  available; otherwise `kind: "credential"` uses a stable, provider-scoped hash
  of the resolved auth headers. Credential rotation changes fallback identity;
- `modelId`, identifying the model selected for the observation, **not** a claim
  that this model alone consumed the quota;
- `report`, the complete normalized `UsageReport`: provider, capture timestamp,
  source, semantics, all quota buckets, metrics, and any returned label or notes.
  `capturedAt` is Unix milliseconds; bucket `resetsAt` and reset-credit
  `expiresAt` values are Unix seconds.

Raw credentials, auth headers, and token records are not copied into snapshots.
The short hashes are pseudonymous identifiers, not anonymization. Custom entries
are not sent to the model and do not consume context tokens. They follow normal
session persistence: in-memory sessions are not saved, and Pi may defer a new
session's first disk write until its first assistant message. Deleting the
session also deletes its snapshots. A write failure warns once per session but
leaves the fetched usage available.

Each session records only its selected provider. A parent using Codex and a
child using OpenRouter record their respective providers in their own files,
provided `pi-usage` is loaded in both and both sessions are persisted. Isolated
or extension-excluding children do not collect snapshots; nested subagents may
use in-memory sessions. There is no forwarding to the parent or shared polling
coordinator.

For later analysis, combine session files by provider and identity, order by
`report.capturedAt`, and deduplicate copied observations by `observationId`.
Snapshots measure provider-account or API-key usage, **not per-session spend**:
concurrent sessions observe overlapping quota, and percentages must not be
summed. Persisted assistant, compaction, and branch-summary usage records remain
the primary token data source; copied history needs separate deduplication.
Temporary transcripts can recover some nested-agent calls, but not missing or
unflushed artifacts, and the displayed conversion is empirical rather than
fixed.

## Limitations

- Only providers with a stable usage source and pi-resolvable runtime auth are supported.
- OpenCode Go's usage endpoint does not provide window-start timestamps, so pace markers and exhaustion projections are unavailable for those windows.
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
