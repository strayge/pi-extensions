# pi-models

`/models` opens a model picker showing visible models by default. Tab switches between
Visible and All; All displays hidden models dimmed, with the selection cursor kept clear.
Favorites, visibility, model usage history, and each model's latest thinking level are stored globally
in `model-history.json`. When switching models, the picker remembers the thinking level of the model
being left and restores the level previously used with the selected model.
For partial command input such as `/m` or `/mo`, `/models` is suggested before the built-in `/model`.

Rows display `[provider] Model Name`, falling back to the model ID when no name is available.
Use Up/Down and Enter to select, Ctrl+S to select and save the global default, Ctrl+F to toggle a
favorite, Ctrl+D to hide/unhide, and Escape to close. The default shortcut follows pi's
`app.models.save` keybinding and leaves thinking-level settings unchanged.
Favorite and visibility changes are saved even when closing without selecting a model.
Typing filters the current view by provider, model ID, provider/model ID, or model name.

OpenCode Go rows show dim monthly allowances and recalculated request estimates, for example
`$15/mo · ~21,150 req/mo`. Values come from OpenCode's current published catalog, not a bundled
model table, and use the **Go** plan (not Go Plus). Monthly requests are estimated as five times
its rounded five-hour estimate, based on the current 20% window allowance; they are not fixed
request caps and can differ slightly from the documentation's estimates.

The picker opens without waiting for the network and updates when a refresh completes. The catalog
is cached globally in `opencode-go-models.json` and checked at most hourly while opening `/models`.
Offline or incompatible updates retain the last good values, marked `[stale]` after an hour;
models without a safe catalog match have no suffix.

Hiding affects only `/models`, not the active model, built-in `/model`, or model cycling. Hidden models
remain selectable in All without being unhidden. Other preferences are preserved, and new models
are visible by default. Non-terminal dialogs retain `[hidden]` badges and provide Show all/visible
models, Set as default, and Hide/Unhide actions.

llama.cpp models are omitted from both views when their cached catalogue is confirmed older than
24 hours. Opening `/models` does not refresh it; models return after a successful refresh in pi.
Other providers and missing or unreadable cache timestamps are unaffected.

## Installation

```bash
pi install npm:@strayge/pi-models
```

Requires Node.js >=22.19.0 and pi >=1.0.2.

For development, load this checkout directly:

```bash
pi -e ./src/index.ts
```
