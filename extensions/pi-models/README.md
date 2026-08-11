# pi-models

`/models` opens a model picker containing the complete available model catalogue.
Favorites and model usage history are stored globally in `model-history.json`.
For partial command input such as `/m` or `/mo`, `/models` is suggested before the built-in `/model`.

Rows display `[provider] Model Name`, falling back to the model ID when no name is available.
Use Up/Down and Enter to select, Ctrl+F to toggle a favorite, and Escape to close.
Typing filters by provider, model ID, provider/model ID, or model name.
