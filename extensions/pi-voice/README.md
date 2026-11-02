# pi-voice

Local speech-to-text for Pi, with editable filler removal and a correction dictionary for voice dictation.
Requires Pi >=1.4.0 and Node >=22.19.0.

## Why this fork exists

This is a temporary fork of [earendil-works/pi-voice](https://github.com/earendil-works/pi-voice),
based on commit [`53c39303509455561f35bc8b012ee4334a810afc`](https://github.com/earendil-works/pi-voice/commit/53c39303509455561f35bc8b012ee4334a810afc)
(version 0.2.0). Upstream currently has no supported way for a companion extension
to modify only voice transcripts before insertion into the editor.

[Upstream PR #30](https://github.com/earendil-works/pi-voice/pull/30) proposes a
`pi-voice:before-insert` event, but remains a draft while maintainers decide the
extensibility API. This fork does not implement or promise that proposed API.

**Retire this fork** when a released upstream version provides a supported
before-insert hook (or equivalent voice-only cleanup). Move the filler filter
and correction dictionary into a companion extension if needed, reinstall upstream,
and remove this copy.
Merging the PR alone is not sufficient: verify that the released API supports
the same behavior first.

## Install and use

From this repository root:

```sh
cd extensions/pi-voice
npm ci
cd ../..
pi remove npm:@earendil-works/pi-voice
pi install "$PWD/extensions/pi-voice"
```

Run `/reload` in existing Pi sessions. Do not load upstream and this fork together:
they register the same commands, shortcut, and transcription tool. Existing
`~/.pi/agent/pi-voice.json` settings and downloaded models are reused.

Use `/voice` or your configured shortcut to start/stop dictation. While recording,
Space stops and transcribes; Escape discards. Compatible native streaming models
automatically show the latest three wrapped transcript lines beneath the meter,
without changing the editor. Text can revise as you speak and may take time to
appear; other models still transcribe only after Stop. Stop clears the preview
and pastes the complete cleaned result at the current editor cursor; Escape
clears it without inserting anything. `/voice-settings` configures the
model, languages, microphone, and shortcut. The `transcribe_file` tool requires
FFmpeg on `PATH` (or `PI_VOICE_FFMPEG_PATH`). See the
[upstream usage guide](https://github.com/earendil-works/pi-voice#usage) for details.

## Filler cleanup

In `/voice-settings`, choose **Filler words** to edit a comma-separated list.
Clear the list and press Enter to disable cleanup; Escape cancels the edit.
Changes apply to the next dictation without reloading. Existing configurations
default to `uh, um, erm`; custom lists replace those defaults and are saved as
`fillerWords` in `~/.pi/agent/pi-voice.json`.

For live dictation previews and final editor insertion, the fork removes the
listed words or phrases (also with an initial capital) and their filler commas.
For example, `Um, can you uh check the tests?` becomes `can you check the tests?`.
Filler-only dictation inserts nothing.

Cleanup does not rewrite grammar or modify file transcription or separate setup/model
previews. Ambiguous words such as `like` or `well` are kept unless you add them
to the list. Entries are trimmed, lowercased, and deduplicated; they are literal
text, not regular expressions.
Quoted tokens, identifiers, compounds, and all-uppercase acronyms are preserved.
The default list is English-oriented; the filter does not detect language.
An unquoted literal use of one of the configured words can also be removed.

## Correction dictionary

In `/voice-settings`, choose **Correction dictionary** to edit one rule per line:

```text
see mux = cmux
double u mux = wmux
```

These are examples, not built-in rules: the dictionary starts empty. Use the
actual text your speech model produces on the left and the desired spelling on
the right. Clear the editor and save to disable corrections; cancelling keeps
the saved dictionary. Invalid or duplicate sources are rejected without saving.

Rules match literal whole words or phrases, ignoring case; replacements retain
the exact capitalization you enter. Longer phrases take priority. Each match is
replaced once, so replacement text cannot trigger another rule. Quoted terms are
also corrected, but substrings inside larger words or identifiers are not.

Corrections run after filler removal on each complete live dictation hypothesis
before the preview is clipped, and again on the final transcript before insertion.
They do not affect typed/pasted text, file transcription, or separate model previews.
Changes apply to the next dictation and are stored in the `corrections` object in
`~/.pi/agent/pi-voice.json`, alongside the existing global voice preferences.

## Development and updates

```sh
npm ci
npm run check
npm test
```

Upstream features, tests, model catalog, bundled VAD model, and licenses are
retained. Local adaptations use `src/index.ts` as the entry point, `.ts` relative
imports, and erasable TypeScript. Tests run directly without compiled output.
Typechecking covers all source and tests; Biome checks fork-owned files listed
in `biome.json`, leaving upstream formatting intact to limit merge churn.

When updating, compare against the pinned upstream commit, retain the narrow
dictation cleanup settings and tests, rerun all checks, and smoke-test a
real Pi load. Preserve upstream copyright and bundled model attribution in
`LICENSE` and `models/README.md`.
