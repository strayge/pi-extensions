/**
 * The footer component handed to `ctx.ui.setFooter`.
 *
 * It owns nothing but rendering: session state lives in `RuntimeState`, the
 * layout in the config, and re-render triggers in the extension entry point.
 * The exceptions are its two timers, both of which exist because their items
 * change with the clock rather than with anything pi announces. Both are armed
 * only when the layout asks for them — a statusline that repaints every second
 * for no reason is a statusline that eats a laptop battery.
 */

import type {
  ExtensionContext,
  ReadonlyFooterDataProvider,
  Theme,
} from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import { nextColdTransition } from "./cache-age.ts";
import { renderStatusline } from "./render.ts";
import type { RuntimeState } from "./runtime.ts";
import type { SlotRegistry } from "./slots.ts";
import type { ContextItemConfig, StatuslineConfig } from "./types.ts";
import { collectUsage } from "./usage.ts";

const CLOCK_INTERVAL_MS = 5000;

/** Fire just past the deadline, so the render that follows already sees it. */
const COLD_TIMER_SLACK_MS = 250;

export interface FooterDeps {
  getConfig: () => StatuslineConfig;
  getContext: () => ExtensionContext | undefined;
  runtime: RuntimeState;
  slots: SlotRegistry;
  /** Called with the live render hook so events elsewhere can request a repaint. */
  onRequestRender: (request: (() => void) | undefined) => void;
  /** Hands out the footer data provider, which pi only passes to this factory.
   *  The editor's live preview needs it to render through the real pipeline. */
  onFooterData: (footerData: ReadonlyFooterDataProvider | undefined) => void;
}

export function createFooterFactory(deps: FooterDeps) {
  return (tui: TUI, theme: Theme, footerData: ReadonlyFooterDataProvider) => {
    const requestRender = () => tui.requestRender();
    deps.onRequestRender(requestRender);
    deps.onFooterData(footerData);

    const unsubscribeBranch = footerData.onBranchChange(requestRender);
    let clock: ReturnType<typeof setInterval> | undefined;
    let coldTimer: ReturnType<typeof setTimeout> | undefined;
    let coldDue: number | undefined;

    const syncClock = (config: StatuslineConfig) => {
      const wantsClock = config.lines.some((line) =>
        line.some((item) => item.type === "time" && item.hidden !== true),
      );
      if (wantsClock && !clock) {
        clock = setInterval(requestRender, CLOCK_INTERVAL_MS);
        clock.unref?.();
      } else if (!wantsClock && clock) {
        clearInterval(clock);
        clock = undefined;
      }
    };

    /**
     * Arm one wake-up for the moment the cache goes cold.
     *
     * A single shot rather than a poll: the transition happens while nothing
     * else is going on, so without it the marker would first appear whenever the
     * user next typed — which is after the miss has already been paid for. Every
     * render re-derives it, so a new response pushes the deadline back for free.
     *
     * The deadline itself does not depend on `now`, so an unchanged one keeps the
     * timer it already has: a streaming response renders many times a second, and
     * every one of those would otherwise tear down and rebuild the same timer.
     */
    const syncColdTimer = (config: StatuslineConfig, now: number) => {
      const items = config.lines
        .flat()
        .filter((item): item is ContextItemConfig => item.type === "context" && !item.hidden);
      const due = nextColdTransition(items, deps.runtime, now);
      if (due === coldDue) return;

      coldDue = due;
      if (coldTimer) clearTimeout(coldTimer);
      coldTimer = undefined;
      if (due === undefined) return;

      coldTimer = setTimeout(requestRender, due - now + COLD_TIMER_SLACK_MS);
      coldTimer.unref?.();
    };

    return {
      render(width: number): string[] {
        const ctx = deps.getContext();
        if (!ctx) return [];
        const config = deps.getConfig();
        const now = Date.now();
        syncClock(config);
        syncColdTimer(config, now);

        return renderStatusline(width, config, theme, {
          ctx,
          footerData,
          runtime: deps.runtime,
          usage: collectUsage(ctx),
          slots: deps.slots,
          preview: false,
          now,
        });
      },
      invalidate() {},
      dispose() {
        unsubscribeBranch();
        if (clock) clearInterval(clock);
        clock = undefined;
        if (coldTimer) clearTimeout(coldTimer);
        coldTimer = undefined;
        coldDue = undefined;
        deps.onRequestRender(undefined);
        deps.onFooterData(undefined);
      },
    };
  };
}
