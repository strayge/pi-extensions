import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  assertTargetFilesystemAvailable,
  executeRemoval,
  formatAdministrativeRecoveryWarning,
  prepareRemoval,
  type RemovalPlan,
  revalidateWorktreeIdentity,
} from "./command.ts";
import { confirmCreate } from "./create-dialog.ts";
import { confirmFinish } from "./finish-dialog.ts";
import {
  addWorktree,
  branchDeletionRisk,
  currentWorktreePath,
  defaultWorktreePath,
  deleteApprovedBranch,
  isAncestor,
  listWorktrees,
  localBranchExists,
  pathIdentity,
  pathsEqual,
  resolveCommit,
  sameWorktreeIdentity,
  stripTerminalControls,
  symbolicBranch,
  validateBranch,
  type WorktreeRecord,
  worktreeForBranch,
} from "./git.ts";
import { manualDialogOptions } from "./input-dialog.ts";
import { switchToWorktree } from "./session.ts";
import type { WorktreeSettingsRuntime } from "./settings.ts";

const APPROVAL = "worktree-approved";
const OUTCOME = "worktree-outcome";
const CONSUMED = "worktree-consumed";

export type WorktreeRequest =
  | { action: "create"; branch: string; base?: string; path?: string }
  | { action: "switch"; path: string }
  | { action: "finish"; path?: string }
  | { action: "status" };

interface FinishPlan {
  removal: RemovalPlan;
  target: WorktreeRecord;
  deleteBranch: boolean;
  risk: string[];
}

interface ApprovedArrival {
  token: string;
  action: "create" | "switch" | "finish";
  sourceSession: string;
  target: WorktreeRecord;
  agent: boolean;
  finish?: FinishPlan;
}

interface Proposal {
  request: WorktreeRequest;
  session: string;
  cwd: string;
  branchLeaf: string | null;
  isCurrent(): boolean;
}

interface Owner {
  isCurrent(): boolean;
}

function entryData<T>(ctx: ExtensionContext, type: string): T[] {
  return ctx.sessionManager
    .getBranch()
    .flatMap((entry) =>
      entry.type === "custom" && entry.customType === type ? [entry.data as T] : [],
    );
}

function usable(record: WorktreeRecord): void {
  if (
    record.bare ||
    record.prunableReason !== undefined ||
    record.lockedReason !== undefined ||
    !existsSync(record.path)
  ) {
    throw new Error(
      `Worktree is bare, locked, or unavailable: ${record.path}. Repair it with Git first.`,
    );
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function registerWorktreeLifecycle(
  pi: ExtensionAPI,
  settings: WorktreeSettingsRuntime,
  getOwner: () => Owner,
): (ctx: ExtensionCommandContext) => Promise<void> {
  const proposals = new Map<string, Proposal>();
  let busy = false;
  let owningSession: string | undefined;
  pi.on("session_start", (_event, ctx) => {
    owningSession = ctx.sessionManager.getSessionId();
    proposals.clear();
  });

  function assertNoPendingInput(ctx: ExtensionContext): void {
    if (ctx.hasPendingMessages()) {
      throw new Error(
        "Worktree transition NOT accepted: queued input is pending. Current workspace unchanged. Process queued input, then reissue the worktree request.",
      );
    }
  }

  pi.on("input", (_event, ctx) => {
    if (ctx.sessionManager.getSessionId() !== owningSession || (!busy && proposals.size === 0))
      return;
    ctx.ui.notify(
      "Worktree transition pending: this input was not accepted. Resubmit it after the operation completes.",
      "warning",
    );
    return { action: "handled" };
  });

  pi.on("tool_call", (event, ctx) => {
    if (ctx.sessionManager.getSessionId() !== owningSession || (!busy && proposals.size === 0))
      return;
    if (
      (event.toolName === "worktree" && (event.input as { action?: string }).action === "status") ||
      ["read", "grep", "find", "ls"].includes(event.toolName) ||
      pi.getAllTools().find((tool) => tool.name === event.toolName)?.annotations?.readOnlyHint ===
        true
    )
      return;
    return {
      block: true,
      terminate: true,
      reason:
        "A worktree transition is pending. Tools that may mutate the current workspace are not accepted; reissue after completion.",
    };
  });

  function report(ctx: ExtensionContext, agent: boolean, text: string): void {
    if (agent) {
      pi.sendMessage(
        { customType: "worktree-completion", content: text, display: true },
        { triggerTurn: true },
      );
    } else ctx.ui.notify(stripTerminalControls(text), "info");
  }

  async function cleanup(ctx: ExtensionCommandContext, plan: FinishPlan): Promise<void> {
    await executeRemoval(pi, ctx, plan.removal, async () => {
      const destination = await revalidateWorktreeIdentity(pi, ctx, plan.target);
      usable(destination);
      if (
        !destination.isMain ||
        !pathsEqual(ctx.cwd, destination.path) ||
        !pathsEqual(await currentWorktreePath(pi, ctx.cwd, ctx.signal), destination.path)
      ) {
        throw new Error("Main destination changed during revalidation; cleanup was refused.");
      }
    });
    if (!plan.deleteBranch) return;
    try {
      await deleteApprovedBranch(
        pi,
        ctx.cwd,
        plan.removal.selected,
        plan.target,
        plan.risk,
        ctx.signal,
      );
    } catch (error) {
      throw new Error(
        `Active workspace: ${ctx.cwd}. Removed ${plan.removal.selected.path}, but branch deletion failed or could not be confirmed: ${message(error)}`,
      );
    }
  }

  async function arrive(ctx: ExtensionCommandContext, approval: ApprovedArrival): Promise<void> {
    const target = await revalidateWorktreeIdentity(pi, ctx, approval.target);
    usable(target);
    if (
      !pathsEqual(ctx.cwd, target.path) ||
      !pathsEqual(await currentWorktreePath(pi, ctx.cwd, ctx.signal), target.path)
    ) {
      throw new Error(
        "Replacement workspace does not match the approved destination; cleanup was refused.",
      );
    }
    if (!approval.finish) {
      report(
        ctx,
        approval.agent,
        `Worktree ${approval.action === "create" ? "created and " : ""}switched. Active workspace: ${ctx.cwd}. Conversation preserved. No implementation, commit, merge, fetch, or push performed.`,
      );
      return;
    }
    const plan = approval.finish;
    if (!target.isMain || !sameWorktreeIdentity(plan.target, target)) {
      throw new Error("The approved main checkout changed; worktree and branch were retained.");
    }
    await cleanup(ctx, plan);
    report(
      ctx,
      approval.agent,
      `Returned to ${ctx.cwd}; conversation preserved. Removed worktree ${plan.removal.selected.path}. Branch ${plan.removal.selected.branch ?? "(detached)"} ${plan.deleteBranch ? "deleted" : "preserved"}. No commit, merge, fetch, or push performed.`,
    );
  }

  pi.registerCommand("worktree-arrive", {
    description: "Complete an approved workspace transition in the replacement runtime",
    handler: async (token, ctx) => {
      if (!ctx.hasUI || busy || ctx.sessionManager.getSessionId() !== owningSession) return;
      const approval = entryData<ApprovedArrival>(ctx, APPROVAL).find(
        (entry) => entry.token === token,
      );
      const activated = ctx.sessionManager
        .getBranch()
        .some(
          (entry) =>
            entry.type === "custom_message" &&
            entry.customType === "worktree-activated" &&
            (entry.details as { token?: string; session?: string } | undefined)?.token === token &&
            (entry.details as { session?: string }).session === ctx.sessionManager.getSessionId(),
        );
      const consumed = ctx.sessionManager
        .getEntries()
        .some(
          (entry) =>
            entry.type === "custom" &&
            entry.customType === CONSUMED &&
            (entry.data as { token?: string } | undefined)?.token === token,
        );
      if (!approval || !activated || consumed) return;
      // A source session cannot execute its own transferred approval.
      if (ctx.sessionManager.getSessionId() === approval.sourceSession) return;
      busy = true;
      const owner = getOwner();
      try {
        pi.appendEntry(CONSUMED, { token });
        try {
          if (ctx.hasPendingMessages())
            throw new Error(
              "Workspace cleanup was not accepted because queued input is pending in the replacement workspace; the remaining worktree and branch were retained.",
            );
          await ctx.waitForIdle();
          if (!owner.isCurrent()) return;
          if (ctx.hasPendingMessages())
            throw new Error(
              "Workspace cleanup was not accepted because queued input appeared at the idle boundary; the remaining worktree and branch were retained.",
            );
          await arrive(ctx, approval);
          pi.appendEntry(OUTCOME, { token, success: true, approval });
        } catch (error) {
          if (!owner.isCurrent()) return;
          pi.appendEntry(OUTCOME, { token, success: false, approval, error: message(error) });
          report(
            ctx,
            approval.agent,
            `Workspace transition partial result in ${ctx.cwd}: ${message(error)} No further cleanup performed; any remaining worktree/branch is retained. Retry finish with the remaining registered path or use /worktree removal.`,
          );
        }
      } finally {
        busy = false;
      }
    },
  });

  async function transition(
    ctx: ExtensionCommandContext,
    target: WorktreeRecord,
    agent: boolean,
    action: ApprovedArrival["action"],
    owner: Owner,
    finish?: FinishPlan,
  ): Promise<void> {
    if (!owner.isCurrent() || ctx.signal?.aborted) return;
    assertNoPendingInput(ctx);
    const token = randomUUID();
    pi.appendEntry(APPROVAL, {
      token,
      action,
      agent,
      sourceSession: ctx.sessionManager.getSessionId(),
      target,
      finish,
    } satisfies ApprovedArrival);
    const result = await switchToWorktree(ctx, target.path, async (replacement) => {
      try {
        // Only an actual replacement activates the transferred approval. Retained cancelled
        // session files cannot later replay it, and copies cannot authorize another session.
        await replacement.sendMessage(
          {
            customType: "worktree-activated",
            content: "Workspace switch succeeded; completing the approved workspace operation.",
            display: false,
            details: { token, session: replacement.sessionManager.getSessionId() },
          },
          { triggerTurn: false },
        );
        await replacement.sendUserMessage(`/worktree-arrive ${token}`, {
          expandPromptTemplates: true,
          deliverAs: "followUp",
        });
      } catch (error) {
        if (agent)
          await replacement.sendMessage(
            {
              customType: "worktree-completion",
              content: `Active workspace: ${replacement.cwd}. Transition completion failed: ${message(error)}. No further cleanup was performed.`,
              display: true,
            },
            { triggerTurn: true },
          );
        else
          replacement.ui.notify(
            stripTerminalControls(`Transition completion failed: ${message(error)}`),
            "error",
          );
      }
    });
    if (result !== "switched" && owner.isCurrent()) {
      pi.appendEntry(CONSUMED, { token, outcome: result });
      report(
        ctx,
        agent,
        `Workspace switch ${result}. Active workspace remains ${ctx.cwd}. No worktree was removed and no branch was deleted.`,
      );
    }
  }

  async function create(
    ctx: ExtensionCommandContext,
    request: Extract<WorktreeRequest, { action: "create" }>,
    agent: boolean,
    owner: Owner,
  ): Promise<void> {
    const records = await listWorktrees(pi, ctx.cwd, ctx.signal);
    const main = records[0];
    if (!main) throw new Error("Git returned no registered main checkout.");
    usable(main);
    if (!request.branch.trim()) throw new Error("Branch name is required.");
    const branch = await validateBranch(pi, ctx.cwd, request.branch, ctx.signal);
    const branchExists = await localBranchExists(pi, ctx.cwd, branch, ctx.signal);
    if (worktreeForBranch(records, branch))
      throw new Error(`Branch ${branch} is already checked out.`);
    if (branchExists && request.base !== undefined)
      throw new Error(
        "An existing branch cannot have a new base; omit base or propose a new branch.",
      );
    const base = branchExists
      ? branch
      : (request.base ?? (await symbolicBranch(pi, ctx.cwd, ctx.signal)));
    if (!base) throw new Error("Detached HEAD requires an explicit base.");
    const oid = await resolveCommit(
      pi,
      ctx.cwd,
      branchExists ? `refs/heads/${branch}` : base,
      ctx.signal,
    );
    const path = pathIdentity(
      request.path
        ? resolve(ctx.cwd, request.path)
        : defaultWorktreePath(main.path, branch, settings.get().effectiveRoot),
    );
    assertTargetFilesystemAvailable(path);
    if (records.some((record) => pathsEqual(record.path, path)))
      throw new Error("The proposed path is already registered.");
    const provenance = {
      kind: branchExists
        ? ("existing-local-branch" as const)
        : request.base === undefined
          ? ("current-branch" as const)
          : ("explicit-commit-ish" as const),
      label: base,
      oid,
    };
    if (!(await confirmCreate(ctx, { branch, base: provenance, path }, agent))) {
      report(
        ctx,
        agent,
        `Worktree creation cancelled. Active workspace remains ${ctx.cwd}. No worktree was created.`,
      );
      return;
    }
    if (!owner.isCurrent() || ctx.signal?.aborted) return;
    assertNoPendingInput(ctx);
    assertTargetFilesystemAvailable(path);
    const latest = await listWorktrees(pi, ctx.cwd, ctx.signal);
    const latestMain = latest.find((record) => record.isMain);
    if (!latestMain || !sameWorktreeIdentity(main, latestMain))
      throw new Error("Main checkout changed after confirmation.");
    usable(latestMain);
    if (
      worktreeForBranch(latest, branch) ||
      latest.some((record) => pathsEqual(record.path, path)) ||
      (await localBranchExists(pi, ctx.cwd, branch, ctx.signal)) !== branchExists ||
      (branchExists &&
        (await resolveCommit(pi, ctx.cwd, `refs/heads/${branch}`, ctx.signal)) !== oid)
    ) {
      throw new Error("Branch or path changed after confirmation; reissue the proposal.");
    }
    await addWorktree(
      pi,
      ctx.cwd,
      { path, branch, startOid: branchExists ? undefined : oid },
      ctx.signal,
    );
    const created = (await listWorktrees(pi, ctx.cwd, ctx.signal)).find((record) =>
      pathsEqual(record.path, path),
    );
    if (!created || created.head !== oid || created.branch !== branch)
      throw new Error(`Created worktree retained at ${path}, but identity verification failed.`);
    usable(created);
    await transition(ctx, created, agent, "create", owner);
  }

  async function finish(
    ctx: ExtensionCommandContext,
    request: Extract<WorktreeRequest, { action: "finish" }>,
    agent: boolean,
    owner: Owner,
  ): Promise<void> {
    const records = await listWorktrees(pi, ctx.cwd, ctx.signal);
    const current = await currentWorktreePath(pi, ctx.cwd, ctx.signal);
    const target = records.find((record) => record.isMain);
    if (!target) throw new Error("Git returned no main checkout.");
    usable(target);
    const previous = entryData<{ success: boolean; approval: ApprovedArrival }>(ctx, OUTCOME)
      .reverse()
      .find((entry) => !entry.success && entry.approval.finish);
    const featurePath =
      request.path ??
      (pathsEqual(current, target.path)
        ? previous?.approval.finish?.removal.selected.path
        : current);
    const feature = records.find(
      (record) => featurePath !== undefined && pathsEqual(record.path, featurePath),
    );
    if (!feature || feature.isMain)
      throw new Error(
        "Finish requires a registered linked worktree; supply its exact path to retry cleanup from main.",
      );
    if (!pathsEqual(current, feature.path) && !pathsEqual(current, target.path))
      throw new Error("Finish must start in the feature worktree or its main checkout.");
    const removal = await prepareRemoval(pi, ctx, feature, true);
    const deletion =
      feature.branch &&
      feature.branchRef &&
      feature.head &&
      target.head &&
      feature.branchRef !== target.branchRef
        ? { branchRef: feature.branchRef, tip: feature.head, targetTip: target.head }
        : undefined;
    const canDelete = deletion !== undefined;
    const merged =
      deletion !== undefined &&
      (await isAncestor(pi, ctx.cwd, deletion.tip, deletion.targetTip, ctx.signal));
    const risk = deletion
      ? await branchDeletionRisk(
          pi,
          ctx.cwd,
          deletion.branchRef,
          deletion.tip,
          deletion.targetTip,
          ctx.signal,
        )
      : [];
    const choice = await confirmFinish(
      ctx,
      {
        mainPath: target.path,
        worktreePath: feature.path,
        ignored: removal.ignored,
        recoveryWarning: formatAdministrativeRecoveryWarning(removal.historyRisks),
        branch: canDelete ? feature.branch : undefined,
        tip: feature.head,
        merged,
        risk,
      },
      agent,
    );
    if (choice === undefined) {
      report(
        ctx,
        agent,
        `Finish cancelled. Active workspace remains ${ctx.cwd}. No worktree was removed or branch deleted.`,
      );
      return;
    }
    if (!owner.isCurrent() || ctx.signal?.aborted) return;
    assertNoPendingInput(ctx);
    const checkedTarget = await revalidateWorktreeIdentity(pi, ctx, target);
    usable(checkedTarget);
    const checkedFeature = await revalidateWorktreeIdentity(pi, ctx, feature);
    usable(checkedFeature);
    const plan: FinishPlan = { removal, target, deleteBranch: choice && canDelete, risk };
    if (pathsEqual(current, target.path)) {
      // Retry cleanup needs no further replacement, but still uses the same guarded plan.
      await cleanup(ctx, plan);
      report(
        ctx,
        agent,
        `Active workspace: ${ctx.cwd}. Removed worktree ${feature.path}; branch ${plan.deleteBranch ? "deleted" : "preserved"}.`,
      );
    } else await transition(ctx, target, agent, "finish", owner, plan);
  }

  async function apply(
    ctx: ExtensionCommandContext,
    request: WorktreeRequest,
    agent: boolean,
    owner: Owner,
  ): Promise<void> {
    if (!ctx.hasUI)
      throw new Error(
        "Worktree transitions require TUI or RPC approval; no side effects in headless mode.",
      );
    assertNoPendingInput(ctx);
    await ctx.waitForIdle();
    if (!owner.isCurrent()) return;
    assertNoPendingInput(ctx);
    if (request.action === "create") await create(ctx, request, agent, owner);
    else if (request.action === "finish") await finish(ctx, request, agent, owner);
    else if (request.action === "switch") {
      const record = (await listWorktrees(pi, ctx.cwd, ctx.signal)).find(
        (candidate) => candidate.path === request.path,
      );
      if (!record) throw new Error("Switch requires an exact existing registered worktree path.");
      usable(record);
      if (pathsEqual(record.path, await currentWorktreePath(pi, ctx.cwd, ctx.signal)))
        throw new Error("That worktree is already current.");
      if (
        !(await ctx.ui.confirm(
          "Switch Git worktree",
          stripTerminalControls(
            `Continue the full active conversation at ${record.path} (HEAD ${record.head})?`,
          ),
          agent ? undefined : manualDialogOptions(),
        ))
      ) {
        report(ctx, agent, `Workspace switch cancelled. Active workspace remains ${ctx.cwd}.`);
        return;
      }
      const latest = await revalidateWorktreeIdentity(pi, ctx, record);
      usable(latest);
      await transition(ctx, latest, agent, "switch", owner);
    }
  }

  pi.registerCommand("worktree-apply", {
    description: "Apply a one-use agent worktree proposal at an idle command boundary",
    handler: async (token, ctx) => {
      const proposal = proposals.get(token);
      if (!proposal) return;
      proposals.delete(token);
      if (
        busy ||
        ctx.sessionManager.getSessionId() !== owningSession ||
        !proposal.isCurrent() ||
        proposal.session !== ctx.sessionManager.getSessionId() ||
        !pathsEqual(proposal.cwd, ctx.cwd) ||
        (proposal.branchLeaf !== null &&
          !ctx.sessionManager.getBranch().some((entry) => entry.id === proposal.branchLeaf))
      )
        return;
      busy = true;
      try {
        await apply(ctx, proposal.request, true, proposal);
      } catch (error) {
        if (proposal.isCurrent())
          report(
            ctx,
            true,
            `Worktree request stopped in ${ctx.cwd}: ${message(error)}. No further actions performed. No commit, merge, fetch, or push performed.`,
          );
      } finally {
        busy = false;
      }
    },
  });

  pi.registerTool({
    name: "worktree",
    label: "Worktree",
    description:
      "Propose create+switch, switch to an exact registered path, or finish (return to main then safely remove a linked worktree, optionally delete its branch). One approval; preserves the full active conversation. Never commits, merges, fetches, or pushes. Finish path may select a retained worktree for cleanup retry from main.",
    exposure: "model-only",
    executionMode: "sequential",
    promptGuidelines: [
      "Call worktree alone, never alongside other tools or in background children. A pending transition terminates the turn; await its factual completion in the new workspace before any edits. The agent owns implementation and merge decisions; this tool only manages workspaces.",
    ],
    parameters: Type.Union([
      Type.Object({
        action: Type.Literal("create"),
        branch: Type.String({ minLength: 1 }),
        base: Type.Optional(Type.String()),
        path: Type.Optional(Type.String()),
      }),
      Type.Object({ action: Type.Literal("switch"), path: Type.String({ minLength: 1 }) }),
      Type.Object({ action: Type.Literal("finish"), path: Type.Optional(Type.String()) }),
      Type.Object({ action: Type.Literal("status") }),
    ]),
    async execute(_id, request, signal, _update, ctx) {
      if (!owningSession || ctx.sessionManager.getSessionId() !== owningSession) {
        throw new Error(
          "Worktree is only available to the owning foreground session, not background children.",
        );
      }
      if (request.action === "status") {
        const records = await listWorktrees(pi, ctx.cwd, signal);
        return {
          content: [{ type: "text", text: JSON.stringify({ cwd: ctx.cwd, worktrees: records }) }],
          details: { records },
        };
      }
      if (!ctx.hasUI)
        throw new Error(
          "Worktree transitions require TUI or RPC approval; no side effects in headless mode.",
        );
      if (signal?.aborted || ctx.signal?.aborted) throw new Error("Worktree proposal cancelled.");
      assertNoPendingInput(ctx);
      if (busy || proposals.size)
        throw new Error("A worktree proposal is already pending; wait for its result.");
      const token = randomUUID();
      const owner = getOwner();
      proposals.set(token, {
        request,
        session: ctx.sessionManager.getSessionId(),
        cwd: ctx.cwd,
        branchLeaf: ctx.sessionManager.getLeafId(),
        isCurrent: owner.isCurrent,
      });
      try {
        // Deliberately do not await: the command waits for this tool result to persist.
        pi.sendUserMessage(`/worktree-apply ${token}`, {
          expandPromptTemplates: true,
          deliverAs: "followUp",
        });
      } catch (error) {
        proposals.delete(token);
        throw error;
      }
      return {
        content: [
          {
            type: "text",
            text: "Worktree proposal pending user approval and command-boundary execution. Nothing has succeeded yet; no edits should start in the old workspace. Completion will report the actual active workspace and outcome.",
          },
        ],
        details: { token, status: "pending" },
        terminate: true,
      };
    },
  });

  pi.on("session_shutdown", async () => {
    owningSession = undefined;
    proposals.clear();
  });

  return async (ctx) => {
    if (busy || proposals.size) {
      ctx.ui.notify("A worktree request is already pending.", "warning");
      return;
    }
    busy = true;
    const owner = getOwner();
    try {
      await apply(ctx, { action: "finish" }, false, owner);
    } catch (error) {
      if (owner.isCurrent()) ctx.ui.notify(stripTerminalControls(message(error)), "error");
    } finally {
      busy = false;
    }
  };
}
