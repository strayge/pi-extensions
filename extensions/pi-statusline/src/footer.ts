/**
 * The footer component handed to `ctx.ui.setFooter`.
 *
 * It owns nothing but rendering: session state lives in `RuntimeState`, the
 * layout in the config, and re-render triggers in the extension entry point.
 * The one thing it does own is the clock tick, which only runs when a `time`
 * item is actually configured — a statusline that repaints every second for no
 * reason is a statusline that eats a laptop battery.
 */

import type {
  ExtensionContext,
  ReadonlyFooterDataProvider,
  Theme,
} from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import { renderStatusline } from "./render.ts";
import type { RuntimeState } from "./runtime.ts";
import type { SlotRegistry } from "./slots.ts";
import type { StatuslineConfig } from "./types.ts";
import { collectUsage } from "./usage.ts";

const CLOCK_INTERVAL_MS = 5000;

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

    return {
      render(width: number): string[] {
        const ctx = deps.getContext();
        if (!ctx) return [];
        const config = deps.getConfig();
        syncClock(config);

        return renderStatusline(width, config, theme, {
          ctx,
          footerData,
          runtime: deps.runtime,
          usage: collectUsage(ctx),
          slots: deps.slots,
          preview: false,
          now: Date.now(),
        });
      },
      invalidate() {},
      dispose() {
        unsubscribeBranch();
        if (clock) clearInterval(clock);
        clock = undefined;
        deps.onRequestRender(undefined);
        deps.onFooterData(undefined);
      },
    };
  };
}
