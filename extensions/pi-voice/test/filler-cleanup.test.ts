import assert from "node:assert/strict";
import test from "node:test";
import {
  cleanDictationFillers,
  DEFAULT_FILLER_WORDS,
  normalizeFillerWords,
} from "../src/filler-cleanup.ts";

test("an empty list disables cleanup without changing whitespace", () => {
  const text = "  Uh, keep um everything.  \n";
  assert.equal(cleanDictationFillers(text, []), text);
});

test("custom lists replace defaults and retain literal matching", () => {
  assert.equal(
    cleanDictationFillers("Hmm, um check ah the tests.", ["hmm", "ah"]),
    "um check the tests.",
  );
  assert.equal(cleanDictationFillers("Remove a+b, not aaab.", ["a+b"]), "Remove not aaab.");
  assert.equal(cleanDictationFillers("You know, check this.", ["you", "you know"]), "check this.");
  assert.equal(cleanDictationFillers("Эм, проверь тесты.", ["эм"]), "проверь тесты.");
  assert.equal(cleanDictationFillers("HMM is an acronym.", ["hmm"]), "HMM is an acronym.");
});

test("list normalization is stable and does not mutate caller data or defaults", () => {
  const words = [" Um ", "", "uh", "UM", "  "];
  assert.deepEqual(normalizeFillerWords(words), ["um", "uh"]);
  cleanDictationFillers("Um, uh test.", words);
  assert.deepEqual(words, [" Um ", "", "uh", "UM", "  "]);
  assert.deepEqual(DEFAULT_FILLER_WORDS, ["uh", "um", "erm"]);
});

test("hesitation sounds disappear without rephrasing the request", () => {
  assert.equal(
    cleanDictationFillers("Um, can you uh check the erm, tests?"),
    "can you check the tests?",
  );
  assert.equal(cleanDictationFillers("uh um erm"), "");
  assert.equal(cleanDictationFillers("Uh, um. Erm!"), "");
});

test("sentence boundaries survive, except for filler-only sentences", () => {
  assert.equal(
    cleanDictationFillers("Uh. Please fix it um. Next, run tests."),
    "Please fix it. Next, run tests.",
  );
  assert.equal(cleanDictationFillers("Fix it. Um, then test."), "Fix it. then test.");
});

test("matching respects Unicode words, identifiers, quotes, compounds, and acronyms", () => {
  const text =
    "thumb album serum um_count _uh uh2 um-based um’s üum umы UM ERM UH `um` \"uh\" 'erm'";
  assert.equal(cleanDictationFillers(text), text);
  assert.equal(
    cleanDictationFillers("Check obj.um now. Keep $um and um.name."),
    "Check obj.um now. Keep $um and um.name.",
  );
  assert.equal(cleanDictationFillers("Say “um”, ‘uh’, and «erm»."), "Say “um”, ‘uh’, and «erm».");
});

test("ambiguous words and unmodified whitespace remain verbatim", () => {
  const text = "  Well, I like this, you know.\nKeep  the layout.  ";
  assert.equal(cleanDictationFillers(text), text);
});

test("cleanup preserves line breaks instead of flattening dictation", () => {
  assert.equal(cleanDictationFillers("Um, first line\nuh second line"), "first line\nsecond line");
  assert.equal(cleanDictationFillers("Run tests um ?"), "Run tests?");
  assert.equal(cleanDictationFillers("First line\nUm."), "First line");
});
