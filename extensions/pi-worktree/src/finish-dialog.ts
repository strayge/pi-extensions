import { homedir } from "node:os";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { stripTerminalControls } from "./git.ts";
import { manualDialogOptions } from "./input-dialog.ts";

export interface FinishDialogProposal {
  mainPath: string;
  worktreePath: string;
  ignored: string[];
  recoveryWarning?: string;
  branch?: string;
  tip?: string;
  merged: boolean;
  risk: string[];
}

export function deletionWarning(proposal: FinishDialogProposal): string {
  if (!proposal.branch || proposal.risk.length === 0) return "";
  const count = proposal.risk.length;
  return `Warning: ${count} ${count === 1 ? "commit is" : "commits are"} not reachable from other branches/tags.`;
}

function displayPath(path: string): string {
  const home = homedir();
  const safe = stripTerminalControls(path);
  return safe === home ? "~" : safe.startsWith(`${home}/`) ? `~${safe.slice(home.length)}` : safe;
}

function workspaceSummary(proposal: FinishDialogProposal): string[] {
  return [
    `Remove   ${displayPath(proposal.worktreePath)}`,
    `Return   ${displayPath(proposal.mainPath)}`,
  ];
}

function finishDetails(proposal: FinishDialogProposal, deleteBranch: boolean): string[] {
  return [
    ...(proposal.ignored.length > 0
      ? [
          "",
          "Ignored to delete:",
          ...proposal.ignored.map(
            (entry) => `  ${stripTerminalControls(entry).replace(/^!! /, "")}`,
          ),
        ]
      : []),
    ...(proposal.recoveryWarning
      ? ["", stripTerminalControls(proposal.recoveryWarning).trim()]
      : []),
    ...(deleteBranch && proposal.branch && proposal.risk.length > 0
      ? ["", deletionWarning(proposal)]
      : []),
  ];
}

export function createFinishDialog(
  proposal: FinishDialogProposal,
  done: (choice: boolean | undefined) => void,
  requestRender: () => void,
  color: (role: "accent" | "warning" | "muted", text: string) => string,
  rows: () => number,
) {
  let deleteBranch = Boolean(proposal.branch && proposal.merged);
  let offset = 0;
  return {
    invalidate() {},
    handleInput(data: string) {
      if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) done(undefined);
      else if (matchesKey(data, "enter")) done(deleteBranch);
      else if (proposal.branch && (matchesKey(data, "space") || matchesKey(data, "tab"))) {
        deleteBranch = !deleteBranch;
        offset = 0;
        requestRender();
      } else if (matchesKey(data, "down") || matchesKey(data, "pageDown")) {
        offset += 1;
        requestRender();
      } else if (matchesKey(data, "up") || matchesKey(data, "pageUp")) {
        offset = Math.max(0, offset - 1);
        requestRender();
      }
    },
    render(width: number): string[] {
      if (width <= 0) return [];
      const branch = stripTerminalControls(proposal.branch ?? "");
      const title = color("accent", `Finish worktree${branch ? ` · ${branch}` : ""}`);
      const toggle = proposal.branch
        ? `[${deleteBranch ? "x" : " "}] Delete branch ${branch} (${proposal.merged ? "merged" : "merge unverified"})`
        : "No branch will be deleted";
      const loss = proposal.recoveryWarning
        ? [color("warning", "DATA LOSS: worktree removal discards recovery history.")]
        : [];
      const workspace = workspaceSummary(proposal);
      const styled = (line: string) =>
        line === "Ignored to delete:" ||
        line.startsWith("Warning:") ||
        line.startsWith("Administrative recovery warning:")
          ? color("warning", line)
          : line;
      const height = Math.max(1, rows());
      // Very short terminals prioritize reachable evidence over decorative spacing.
      const footer = [
        ...(height >= 4 ? [""] : []),
        color("muted", "Enter finish · Esc cancel · Space toggle branch · ↑/↓ scroll"),
      ];
      const headerBudget = Math.max(0, height - footer.length - 1);
      const expandedHeader = [
        title,
        "",
        ...workspace.flatMap((line) => wrapTextWithAnsi(line, width)),
        "",
        toggle,
        ...loss,
      ];
      // Keep the choice and loss warning pinned without consuming the last detail row.
      const compact = expandedHeader.length > headerBudget;
      const compactHeader =
        headerBudget >= 2 + loss.length
          ? [title, toggle, ...loss]
          : headerBudget >= 1 + loss.length
            ? [toggle, ...loss]
            : [loss.length > 0 ? color("warning", `DATA LOSS · ${toggle}`) : toggle];
      const header = (compact ? compactHeader : expandedHeader).slice(0, headerBudget);
      const lines = [...(compact ? workspace : []), ...finishDetails(proposal, deleteBranch)]
        .map(styled)
        .flatMap((line) => wrapTextWithAnsi(line, width));
      const available = Math.max(0, height - header.length - footer.length);
      offset = Math.min(offset, Math.max(0, lines.length - available));
      return [...header, ...lines.slice(offset, offset + available), ...footer].map((line) =>
        truncateToWidth(line, width),
      );
    },
  };
}

export async function confirmFinish(
  ctx: ExtensionCommandContext,
  proposal: FinishDialogProposal,
  agent: boolean,
): Promise<boolean | undefined> {
  if (ctx.mode === "tui") {
    const factory: Parameters<typeof ctx.ui.custom<boolean | undefined>>[0] = (
      tui,
      theme,
      _keys,
      done,
    ) =>
      createFinishDialog(
        proposal,
        done,
        () => tui.requestRender(),
        (role, text) => theme.fg(role, text),
        () => tui.terminal.rows,
      );
    return ctx.ui.custom<boolean | undefined>(
      agent
        ? Object.assign(factory, { [Symbol.for("pi-extensions:input-dialog")]: true })
        : factory,
    );
  }
  const keep = "Return and remove worktree; KEEP branch";
  const remove = "Return and remove worktree; DELETE branch";
  const defaultDelete = Boolean(proposal.branch && proposal.merged);
  const choices = proposal.branch ? (defaultDelete ? [remove, keep] : [keep, remove]) : [keep];
  const selected = await ctx.ui.select(
    [
      `Finish worktree${proposal.branch ? ` · ${stripTerminalControls(proposal.branch)}` : ""}`,
      "",
      ...workspaceSummary(proposal),
      "",
      proposal.branch
        ? `Branch   ${stripTerminalControls(proposal.branch)} (${proposal.merged ? "merged" : "merge unverified"})`
        : "No branch deletion",
      ...finishDetails(proposal, true),
      "",
      "First option is the default.",
    ].join("\n"),
    choices,
    agent ? undefined : manualDialogOptions(),
  );
  return selected === undefined ? undefined : selected === remove;
}
