# pi-undo

Correct your last sent prompt without opening a message picker.

## Install

From this repository:

```sh
pi install ./extensions/pi-undo
```

Run `/reload` in an existing session after installing.

## Use

Press **Alt+U** or run **`/undo`**. Pi stops the current response, rewinds
before your last user message, and restores its text for editing. Any queued text
and current draft follow the restored prompt on new lines. Nothing is sent until
you submit the edited prompt.

The old conversation branch remains available in `/tree`; no separate session
is created and no branch summary is added.

This changes conversation history only: it does **not** undo file edits, commands,
or other side effects. Like `/fork`, it restores text only, not image attachments.
Reattach images before resending when needed.
