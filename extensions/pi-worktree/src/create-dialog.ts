import { homedir } from "node:os";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { type AddBaseProvenance, quoteTerminalValue } from "./command.ts";

export interface CreateDialogProposal {
  branch: string;
  base: AddBaseProvenance;
  path: string;
}

function displayValue(value: string): string {
  const quoted = quoteTerminalValue(value);
  return quoted === `"${value}"` && !/\s/u.test(value) ? value : quoted;
}

function createSummary(proposal: CreateDialogProposal, fullOid = false): string {
  const { branch, base, path } = proposal;
  const home = homedir();
  const displayPath =
    path === home ? "~" : path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
  return [
    `Branch   ${displayValue(branch)} (${base.kind === "existing-local-branch" ? "existing" : "new"})`,
    `Base     ${displayValue(base.label)} · ${displayValue(fullOid ? base.oid : base.oid.slice(0, 8))}`,
    `Path     ${displayValue(displayPath)}`,
  ].join("\n");
}

export function createWorktreeDialog(
  proposal: CreateDialogProposal,
  done: (choice: boolean) => void,
  requestRender: () => void,
  color: (role: "accent" | "muted", text: string) => string,
  rows: () => number,
) {
  let offset = 0;
  return {
    invalidate() {},
    handleInput(data: string) {
      if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) done(false);
      else if (matchesKey(data, "enter")) done(true);
      else if (matchesKey(data, "down") || matchesKey(data, "pageDown")) {
        offset += 1;
        requestRender();
      } else if (matchesKey(data, "up") || matchesKey(data, "pageUp")) {
        offset = Math.max(0, offset - 1);
        requestRender();
      }
    },
    render(width: number): string[] {
      if (width <= 0) return [];
      const height = Math.max(1, rows());
      const footer = [
        ...(height >= 4 ? [""] : []),
        color("muted", "Enter create & switch · Esc cancel · ↑/↓ scroll"),
      ];
      const header = [
        color("accent", `Create worktree · ${displayValue(proposal.branch)}`),
        "",
      ].slice(0, Math.max(0, Math.min(2, height - footer.length - 1)));
      const lines = createSummary(proposal)
        .split("\n")
        .flatMap((line) => wrapTextWithAnsi(line, width));
      const available = Math.max(0, height - header.length - footer.length);
      offset = Math.min(offset, Math.max(0, lines.length - available));
      return [...header, ...lines.slice(offset, offset + available), ...footer].map((line) =>
        truncateToWidth(line, width),
      );
    },
  };
}

export async function confirmCreate(
  ctx: ExtensionCommandContext,
  proposal: CreateDialogProposal,
): Promise<boolean> {
  if (ctx.mode === "tui") {
    return ctx.ui.custom<boolean>((tui, theme, _keys, done) =>
      createWorktreeDialog(
        proposal,
        done,
        () => tui.requestRender(),
        (role, text) => theme.fg(role, text),
        () => tui.terminal.rows,
      ),
    );
  }
  return ctx.ui.confirm(
    `Create worktree · ${displayValue(proposal.branch)}`,
    createSummary(proposal, true),
  );
}
