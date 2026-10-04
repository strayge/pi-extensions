# pi-models

`/models` opens a model picker containing the complete available model catalogue.
Favorites, model usage history, and each model's latest thinking level are stored globally in
`model-history.json`. When switching models, the picker remembers the thinking level of the model
being left and restores the level previously used with the selected model.
For partial command input such as `/m` or `/mo`, `/models` is suggested before the built-in `/model`.

Rows display `[provider] Model Name`, falling back to the model ID when no name is available.
Use Up/Down and Enter to select, Ctrl+F to toggle a favorite, and Escape to close.
Typing filters by provider, model ID, provider/model ID, or model name.

## Installation

```bash
pi install npm:@strayge/pi-models
```

Requires Node.js >=22.19.0 and pi >=1.0.2.

For development, load this checkout directly:

```bash
pi -e ./src/index.ts
```
