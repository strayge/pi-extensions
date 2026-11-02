import assert from "node:assert/strict";
import test from "node:test";
import {
  applyCorrections,
  normalizeCorrections,
  parseCorrectionDictionary,
} from "../src/corrections.ts";
import { cleanDictationFillers } from "../src/filler-cleanup.ts";

test("corrections ignore source case and keep exact replacement capitalization", () => {
  assert.equal(
    applyCorrections("See mux and DOUBLE U MUX.", { "see mux": "cmux", "double u mux": "wmux" }),
    "cmux and wmux.",
  );
  assert.equal(applyCorrections("pie", { pie: "Pi" }), "Pi");
  assert.equal(applyCorrections("ſee mux", { "see mux": "cmux" }), "cmux");
});

test("only whole Unicode terms match, including quoted terms but not identifier fragments", () => {
  const text = 'sea seal sea_count $sea sea2 морsea seaы e\u0301sea "sea"';
  assert.equal(
    applyCorrections(text, { sea: "cmux" }),
    'cmux seal sea_count $sea sea2 морsea seaы e\u0301sea "cmux"',
  );
});

test("longer phrases win and replacements never cascade", () => {
  assert.equal(
    applyCorrections("see mux then see", { see: "look", "see mux": "cmux", cmux: "wmux" }),
    "cmux then look",
  );
});

test("sources are literal and replacement dollar syntax is not expanded", () => {
  assert.equal(applyCorrections("a+b aaab", { "a+b": "$&" }), "$& aaab");
  assert.equal(applyCorrections("__proto__", Object.fromEntries([["__proto__", "safe"]])), "safe");
});

test("empty dictionaries preserve transcripts verbatim and cleanup runs before corrections", () => {
  const text = "  Um, see mux.\n";
  assert.equal(applyCorrections(text, {}), text);
  assert.equal(applyCorrections(cleanDictationFillers("Um, see mux."), { "see mux": "um" }), "um.");
});

test("editor format normalizes sources while preserving replacement text", () => {
  const dictionary = { " See Mux ": " cMux " };
  assert.deepEqual(normalizeCorrections(dictionary), { "see mux": "cMux" });
  assert.deepEqual(dictionary, { " See Mux ": " cMux " });
  assert.deepEqual(parseCorrectionDictionary("See mux = cmux\r\n\nEquals = x=y\n"), {
    "see mux": "cmux",
    equals: "x=y",
  });
  assert.deepEqual(parseCorrectionDictionary(" \n\t"), {});
});

test("malformed or duplicate rules cannot silently remove saved corrections", () => {
  for (const text of ["no separator", " = cmux", "sea = ", "sea = cmux\nSEA = wmux"]) {
    assert.throws(() => parseCorrectionDictionary(text));
  }
  assert.throws(() => normalizeCorrections({ sea: "cmux", SEA: "wmux" }), /Duplicate/);
  assert.throws(() => normalizeCorrections({ "a=b": "c" }));
  assert.throws(() => normalizeCorrections({ sea: "two\nlines" }));
});
