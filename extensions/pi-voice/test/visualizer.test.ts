import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth, wrapTextWithAnsi, type Component, type TUI } from "@earendil-works/pi-tui";
import { cleanDictationTranscript } from "../src/filler-cleanup.ts";
import { RecordingMeter, SpectrumAnalyzer } from "../src/visualizer.ts";
import { testTheme, testTui } from "./ui-helpers.ts";

/** Captures the actual width-aware widget without replacing the editor. */
function meterHarness(mode: "tui" | "rpc" = "tui") {
  let widget: Component | string[] | undefined;
  let installs = 0;
  let renders = 0;
  const theme = testTheme();
  theme.fg = (_color, text) => `\u001b[36m${text}\u001b[0m`;
  const tui = testTui();
  tui.requestRender = () => { renders++; };
  const ctx = {
    hasUI: true, mode,
    ui: {
      theme,
      setWidget(_key: string, value: string[] | ((tui: TUI, theme: ExtensionContext["ui"]["theme"]) => Component) | undefined) {
        installs++;
        widget = typeof value === "function" ? value(tui, theme) : value;
      },
    },
  } as unknown as ExtensionContext;
  const meter = new RecordingMeter();
  return {
    ctx, meter,
    lines(width: number) {
      assert.ok(widget && !Array.isArray(widget));
      return widget.render(width);
    },
    get widget() { return widget; },
    get installs() { return installs; },
    get renders() { return renders; },
  };
}

function plain(text: string): string {
  return text.replace(/\u001b\[[0-9;]*m/g, "");
}

test("recording preview wraps the whole snapshot before keeping the latest three visual rows", () => {
  const h = meterHarness();
  h.meter.start(h.ctx, "long styled stop/cancel hints");
  h.meter.setPreview("first\nsecond\n你好世界你好世界\nlast phrase with words");
  for (const width of [40, 8, 3, 1, 0, 20]) {
    const lines = h.lines(width);
    assert.ok(lines.length <= 4);
    assert.ok(lines.every((line) => visibleWidth(line) <= width));
    const expected = width > 0
      ? wrapTextWithAnsi("first\nsecond\n你好世界你好世界\nlast phrase with words", width).slice(-3).map((line) => truncateToWidth(line, width))
      : [];
    assert.deepEqual(lines.slice(1).map(plain), expected.map(plain));
  }
  h.meter.stop();
});

test("transcript-only changes repaint without reinstalling the widget, and Stop/restart clears the tail", () => {
  const h = meterHarness();
  h.meter.start(h.ctx, "hints", "arrived before widget startup");
  assert.deepEqual(h.lines(80).slice(1).map(plain), ["arrived before widget startup"]);
  const installs = h.installs;
  const renders = h.renders;
  h.meter.setPreview("changed words");
  assert.equal(h.renders, renders + 1);
  assert.equal(h.installs, installs);
  h.meter.setPreview("changed words");
  assert.equal(h.renders, renders + 1);
  assert.deepEqual(h.lines(80).slice(1).map(plain), ["changed words"]);
  h.meter.setPreview("");
  assert.equal(h.lines(80).length, 1);
  h.meter.setPreview("discard this");
  h.meter.stop();
  assert.equal(h.widget, undefined);
  h.meter.setPreview("late text");
  h.meter.start(h.ctx, "hints");
  assert.equal(h.lines(80).length, 1);
  h.meter.stop();
});

test("live cleanup recomputes full raw snapshots, including growing phrases and filler-only replacements", () => {
  const h = meterHarness();
  const settings = { fillerWords: ["um", "uh"], corrections: { "see mux": "cmux", cmux: "wrong cascade" } };
  h.meter.start(h.ctx, "hints");
  const update = (raw: string) => h.meter.setPreview(cleanDictationTranscript(raw, settings));
  update("Um, check see");
  assert.deepEqual(h.lines(80).slice(1).map(plain), ["check see"]);
  update("Um, check see mux");
  assert.deepEqual(h.lines(80).slice(1).map(plain), ["check cmux"]);
  update("Um, check see mux again");
  assert.deepEqual(h.lines(80).slice(1).map(plain), ["check cmux again"]);
  update("Um, uh");
  assert.equal(h.lines(80).length, 1);
  h.meter.stop();
});

test("cleanup matches across wrapping and tail boundaries before clipping", () => {
  const h = meterHarness();
  h.meter.start(h.ctx, "hints");
  const raw = "old words ".repeat(20) + "see mux alpha beta gamma";
  const settings = { fillerWords: ["um"], corrections: { "see mux alpha beta": "cmux" } };
  h.meter.setPreview(cleanDictationTranscript(raw, settings));
  assert.deepEqual(h.lines(6).slice(1).map(plain), ["words", "cmux", "gamma"]);
  h.meter.stop();
});

test("RPC keeps the existing meter-only string widget contract", () => {
  const h = meterHarness("rpc");
  h.meter.start(h.ctx, "hints", "not for RPC");
  const installs = h.installs;
  h.meter.setPreview("no expansion");
  assert.equal(h.installs, installs);
  assert.ok(Array.isArray(h.widget));
  assert.equal(h.widget.length, 1);
  h.meter.stop();
});

test("analyzer levels rise on a tone and decay on silence", () => {
  const analyzer = new SpectrumAnalyzer();
  const tone = new Float32Array(512);
  for (let index = 0; index < tone.length; index += 1) {
    // 1 kHz at the 16 kHz capture rate.
    tone[index] = Math.sin((2 * Math.PI * index) / 16) * 0.5;
  }
  analyzer.push(tone);
  const peak = Math.max(...analyzer.bands);
  assert.ok(peak > 0);
  analyzer.push(new Float32Array(512));
  assert.ok(Math.max(...analyzer.bands) < peak);
  analyzer.reset();
  assert.ok(analyzer.bands.every((band) => band === 0));
});
