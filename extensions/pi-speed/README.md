# pi-speed

Output-stream speed reporting for [pi](https://github.com/earendil-works/pi).
The extension owns the historical `/speed` report and the current-session
`speed` statusline item. It makes no provider, quota, auth, or model requests.

## Requirements

- Node.js >=22.19.0
- pi >=1.0.2

## Installation

After a release has been published, install the standalone package with:

```bash
pi install npm:@strayge/pi-speed
```

This repository does not claim that the package is already published. For a
local checkout, load the entry point directly from the repository root:

```bash
pi -e "$PWD/extensions/pi-speed/src/index.ts"
```

### Migrating from pi-usage

Update or remove the older `pi-usage` version that still owns `/speed` before
enabling `pi-speed`; loading both owners would create command and status
collisions. Then add `pi-speed` separately and reload Pi. Updating `pi-usage`
alone does not activate speed reporting.

The command name and `speed` slot ID are unchanged. Existing statusline layouts
continue to work, but legacy sessions without stream measurements cannot supply
speed values.

## Historical model speed

Run `/speed` to open the `1d` report, or use `/speed 1d`, `/speed 2d`, `/speed
3d`, `/speed 5d`, `/speed 7d`, or `/speed 14d`. The range selector remains above
the results. Left/Right changes the range immediately from one captured history
load, so every range shares the same fixed end time.

Each exact provider/model has one row, with reasoning levels pooled. Models
without usable measurements in the selected period are hidden. The table shows:

- median streaming output tokens/second;
- measured text and tool-call output tokens, excluding reasoning;
- measured total output-stream time; and
- descriptive Trend values for sufficiently populated comparable cohorts.

Up/Down and PageUp/PageDown scroll rows. Shift+Left/Right pans columns on narrow
terminals, Left/Right changes range, and Escape closes the report. UI-capable
non-TUI clients receive the report and range choices in one selection loop.
Nothing is posted into model context.

### Persisted history sources

The report reads persisted Pi sessions from the default cross-project session
listing, plus active in-memory entries. If the active session file is absent
from that listing, its active custom session directory is also listed. Canonical
paths and verified parent-session lineages prevent copied entries from being
counted twice. Persisted subagent sessions remain eligible when Pi's session
listing discovers them; arbitrary custom roots are not globally discoverable.

Only persisted sessions are read. Temporary transcript/output artifacts are not
scanned because they do not provide the stream measurements required for a visible
speed measurement. Quota snapshots, provider adapters, credentials, and usage
configuration are not read.

The reader keeps a 30-day history horizon with a 30-minute file-age boundary
tolerance. `14d` is the largest offered range because its comparison needs 28
days. Missing, unreadable, malformed, or undiscoverable sessions can make the
report incomplete.

### Measurements and comparisons

For each eligible assistant response:

```text
rate = provider-accounted text + tool-call output tokens (excluding reasoning)
       / ((last payload arrival - first payload arrival) / 1000)
```

The extension timestamps actual text and tool-argument payloads through
`provider_stream_event`, then records compact timing and token counts after the
assistant entry is persisted. Response content is not copied. Measurements
survive reload and are excluded from model context.

Supported API families are Codex/OpenAI Responses, OpenAI Chat Completions,
Anthropic Messages, and Gemini, including OpenCode models using those APIs.
Missing reasoning counts are not assumed to be zero. Responses without reliable
non-reasoning accounting, with detected interleaved reasoning, or with ambiguous
completion-only output are excluded.

Only successful `stop` and `toolUse` responses with at least 250 non-reasoning
output tokens, two payload chunks, and 1,000 ms from first to last payload
arrival contribute. Missing, malformed, mismatched, or conflicting measurements
are excluded; request timestamps are never a fallback. Old history recorded
without this telemetry is unavailable for speed reporting. Standalone usage,
compaction, and branch-summary accounting records are never speed observations.

This is approximate observed streaming throughput, not time-to-first-token or
a pure generation benchmark. The interval omits the wait for the first chunk,
even though token totals include that chunk. Provider/network buffering and
parsed-event delivery can distort arrival times. Reasoning-only payloads and
subsequent tool execution do not count.

A row's speed is the median of individual request rates, not a ratio of summed
tokens and time. Its non-reasoning token and stream-time totals use those same
eligible requests. Concurrent stream durations can overlap, so the total is not
wall-clock active time.

Every selected range is compared with the immediately preceding equal-length
period. The shared boundary belongs to the selected period. Within an exact
provider/model row, comparison cohorts also match:

- requested thinking level and explicit versus inferred effort provenance;
- context size (`input + cacheRead + cacheWrite`): `<16k`, `16–64k`, `64–128k`,
  or `>=128k`;
- non-reasoning output size: `<500`, `500–2k`, `2–8k`, or `>=8k`; and
- stop reason: `stop` or `toolUse`.

Effort comes from explicit message metadata or the nearest ancestor
`thinking_level_change` on that request's branch. Unknown, inferred, and
explicit effort remain distinct for comparisons even though the overview row
pools them.

Here `k` means 1,000 tokens. A cohort needs at least 10 measured requests in each
period. Its change is:

```text
(current median rate / previous median rate - 1) x 100
```

Trend shows one percentage for one eligible cohort, or the minimum-to-maximum
percentages and cohort count for several. It never averages cohort changes.
Without an eligible cohort it says `insufficient`; row medians and totals still
include all eligible measurements.

These are descriptive observations, not benchmark verdicts, confidence claims,
or model recommendations. Coarse cohorts cannot control provider load, routing,
network latency, cache behavior, or workload differences.

## Current-session speed status

The `speed` status shows the median rate for the exact selected provider/model,
for example `123.4 tok/s`. It uses `sessionManager.getBranch()`: the selected
branch and its ancestors, excluding abandoned branches and separate subagent
sessions. Reasoning levels are pooled. The item stays hidden until a usable
measurement exists.

It refreshes on session start or resume, tree navigation, model selection, tool
execution start, and turn end. Reload restores values from recorded stream
annotations matched to assistant entries on the selected branch. A finalized
message alone is not a speed measurement.

The value is written through Pi's stock `ctx.ui.setStatus("speed", ...)` channel
and also published as a placeable statusline slot. Existing layouts continue to
work:

```jsonc
{ "type": "slot", "id": "speed" }
```

Without explicit placement, stock footers and statusline catch-all behavior
remain unchanged. The slot replays its latest value when a later-loaded
statusline requests it and clears on session shutdown. Status refresh uses
in-memory session entries; it performs no disk scan or provider request.

## Development

```bash
cd extensions/pi-speed
npm install
npm run check
```

The package is self-contained. It has no source import or runtime dependency on
`@strayge/pi-usage` or another sibling extension.
