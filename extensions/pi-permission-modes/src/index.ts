import { randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  openSync,
  lstatSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { Type } from "@earendil-works/pi-ai";
import {
  createBashToolDefinition,
  createPowerShellToolDefinition,
  getAgentDir,
  getPackageDir,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { PermissionOwner } from "./approvals.ts";
import { permissionAwareness } from "./awareness.ts";
import { discoverShellAccess } from "./bash-parse.ts";
import { defaultConfig, loadConfig } from "./config-load.ts";
import { createDirectTools } from "./direct-tools.ts";
import { approvalUI, networkUI } from "./file-approval.ts";
import { createSearchTools } from "./filtered-search.ts";
import { normalizeDomain } from "./network.ts";
import { assertBinding, bindPath, modelPath } from "./paths.ts";
import { activePiPackage, resolveCatalog, tightenCatalog } from "./policy.ts";
import { PermissionStore, type SessionBinding } from "./permission-state.ts";
import { runtime } from "./sandbox.ts";
import { createStatus } from "./status.ts";

interface Attachment {
  owner: PermissionOwner;
  release: () => void;
}
export interface PermissionBridgeRequest {
  version: 2;
  parentSessionId: string;
  cancel(): void;
  respond(attachment: {
    factory: (pi: ExtensionAPI) => void;
    verify(): void;
    resume(cancel: () => void): () => void;
    release(): void;
  }): void;
  reject(reason: string): void;
}
const retainedSymbol = Symbol.for("pi.permission-modes.reload.v2");
const globals = globalThis as typeof globalThis & { [retainedSymbol]?: Map<string, PermissionOwner> };
const retained = (globals[retainedSymbol] ??= new Map());
const quote = (text: string) => `'${text.replaceAll("'", "'\\''")}'`;

export default function permissionExtension(pi: ExtensionAPI, inherited?: Attachment): void {
  let owner = inherited?.owner;
  let retainedKey: string | undefined;
  let ownerSessionId: string | undefined;
  let ctx: ExtensionContext;
  let startupError: string | undefined;
  const status = createStatus(pi);
  const getOwner = () => {
    if (!owner) throw new Error(`Filesystem policy unavailable: ${startupError ?? "session has not started"}`);
    return owner;
  };
  const showStatus = () => {
    if (ctx) status(ctx, owner, startupError);
  };
  const context = () => ctx;
  const key = () => JSON.stringify([ctx.sessionManager.getSessionId(), ctx.sessionManager.getSessionFile() ?? null]);
  const agentDir = getAgentDir();
  const resolution = { agentDir, home: homedir(), piPackage: activePiPackage() ?? getPackageDir() };
  const requireRoot = () => {
    if (inherited) throw new Error("Profile and revocation controls belong to the parent session");
  };

  pi.registerFlag("perm", {
    description: "Filesystem profile (project, subproject, yolo, or a configured name)",
    type: "string",
  });
  pi.registerFlag("no-sandbox", {
    description: "Disable optional sandbox use; required filesystem/network layers still block execution",
    type: "boolean",
    default: false,
  });

  const [read, edit, write] = createDirectTools(getOwner, process.cwd());
  pi.registerTool(read);
  pi.registerTool(edit);
  pi.registerTool(write);
  const [find, grep, ls] = createSearchTools(getOwner, process.cwd());
  pi.registerTool(find);
  pi.registerTool(grep);
  pi.registerTool(ls);
  const bash = createBashToolDefinition(process.cwd());
  const powershell = createPowerShellToolDefinition(process.cwd());
  for (const shell of [bash, powershell]) {
    pi.registerTool({
      ...shell,
      execute: async (id, params, signal, update, toolCtx) => {
        const active = getOwner();
        const cwd = toolCtx.cwd;
        const accesses = shell.name === "bash" ? await discoverShellAccess(params.command, cwd) : [];
        // No command starts until every reliable operand and redirection has passed preflight.
        for (const request of accesses) await active.authorize([request.path], request.access, request.source, signal);
        return active.run(
          [modelPath(".", cwd)],
          "read",
          "Shell working directory",
          signal,
          async (snapshot, targets) => {
            for (const request of accesses) {
              const result = await active.authorize([request.path], request.access, request.source, signal);
              active.check(snapshot.revision);
              for (const target of result.targets) assertBinding(target);
            }
            const family = {
              id: active.id,
              network: () => active.network.snapshot(),
              reportEnforcement: (error?: string) => { active.enforcementError = error; showStatus(); },
              decideHost: (host: string, port?: number) =>
                active.reason ? Promise.resolve(false) : active.network.decide(host, port, active.askNetwork),
            };
            const operations = runtime.operations(
              snapshot,
              family,
              () => {
                active.check(snapshot.revision);
                for (const target of targets) assertBinding(target);
              },
              pi.getFlag("no-sandbox") === true,
            );
            const tool =
              shell.name === "bash"
                ? createBashToolDefinition(cwd, { operations })
                : createPowerShellToolDefinition(cwd, {
                    operations: {
                      exec: async (command, executionCwd, options) => {
                        const interpreter = "/usr/bin/pwsh";
                        if (!existsSync(interpreter))
                          throw new Error(
                            "Contained PowerShell is unavailable: /usr/bin/pwsh is required; no unsandboxed fallback",
                          );
                        return operations.exec(
                          `${quote(interpreter)} -NoLogo -NonInteractive -Command ${quote(command)}`,
                          executionCwd,
                          options,
                        );
                      },
                    },
                  });
            try {
              return await tool.execute(id, params, signal, update, toolCtx);
            } finally {
              showStatus();
            }
          },
        );
      },
    });
  }

  pi.registerTool({
    name: "request_directory_access",
    label: "Directory access",
    description:
      "Request R/O or R/W directory authority from the parent user. Directory grants never bypass path rules.",
    parameters: Type.Object({
      directory: Type.String(),
      access: Type.Union([Type.Literal("read"), Type.Literal("write")]),
      reason: Type.String(),
    }),
    async execute(_id, params, signal, _update, toolCtx) {
      const active = getOwner();
      await active.requestDirectory(modelPath(params.directory, toolCtx.cwd), params.access, params.reason, signal);
      showStatus();
      return {
        content: [{ type: "text", text: "Directory request completed; separate path rules still apply." }],
        details: undefined,
      };
    },
  });
  pi.registerTool({
    name: "request_path_exception",
    label: "Path-rule exception",
    description: "Request explicit exceptions for asking path rules. Hard denies cannot be approved away.",
    parameters: Type.Object({
      path: Type.String(),
      access: Type.Union([Type.Literal("read"), Type.Literal("write")]),
      reason: Type.String(),
    }),
    async execute(_id, params, signal, _update, toolCtx) {
      await getOwner().authorize([modelPath(params.path, toolCtx.cwd)], params.access, params.reason, signal);
      showStatus();
      return { content: [{ type: "text", text: "Path authorization completed." }], details: undefined };
    },
  });
  pi.registerTool({
    name: "request_network_access",
    label: "Network access",
    description:
      "Request permission for hostnames reached by governed subprocesses. Explicit denied domains remain denied.",
    parameters: Type.Object({ domains: Type.Array(Type.String()), reason: Type.String() }),
    async execute(_id, params, signal) {
      const active = getOwner();
      for (const raw of params.domains) {
        signal?.throwIfAborted();
        const domain = normalizeDomain(raw);
        if (!domain || domain.startsWith("*."))
          throw new Error("Tool requests require an exact hostname; use /net allow for wildcard policy");
        if (!(await active.network.decide(domain, undefined, active.askNetwork)))
          throw new Error(`Network access denied: ${domain}`);
      }
      showStatus();
      return { content: [{ type: "text", text: "Network access approved." }], details: undefined };
    },
  });

  pi.registerCommand("perm", {
    description: "Inspect/select filesystem profiles; grant, revoke, clear, init, or reset permission state",
    handler: async (args, commandCtx) => {
      ctx = commandCtx;
      requireRoot();
      const [action, ...rest] = args.trim().split(/\s+/);
      if (action === "reset" || action === "init") {
        if (!ctx.hasUI) throw new Error("Permission setup requires user acknowledgement in the UI");
        if (
          !(await ctx.ui.confirm(
            "Initialize permission policy v2?",
            "This is a clean schema break: command/per-tool grants and Plan Mode are not migrated. Existing global/project policy and state files are backed up. New defaults use project filesystem access and restricted networking.",
          ))
        )
          return;
        const resetting = owner;
        resetting?.block("Policy reset is draining governed work; /reload required");
        await resetting?.drain();
        if (resetting) await runtime.shutdown(resetting.id);
        if (owner !== resetting) throw new Error("Parent policy changed during reset; retry explicitly");
        const directory = path.join(agentDir, "permission-mode");
        mkdirSync(directory, { recursive: true, mode: 0o700 });
        if (bindPath(directory).canonical !== directory) throw new Error("Permission setup does not follow directory symlinks");
        chmodSync(directory, 0o700);
        const files = [
          path.join(directory, "permission-mode.json"),
          path.join(directory, "state-v2.json"),
          path.join(ctx.cwd, ".pi", "permission-mode.json"),
        ];
        for (const file of files) {
          const binding = bindPath(file);
          if (binding.canonical !== file || (!binding.missing.length && !lstatSync(file).isFile())) throw new Error(`Permission reset will not copy or replace a symlink or special file: ${file}`);
        }
        const suffix = `.backup-${randomUUID()}`;
        const lock = path.join(directory, ".authority.lock");
        const lockFd = openSync(lock, "wx", 0o600);
        try {
        const previous = files.map((file) => (existsSync(file) ? readFileSync(file) : undefined));
        const temporary = path.join(directory, `.config-${randomUUID()}.tmp`);
        try {
          for (let i = 0; i < files.length; i++) if (previous[i]) copyFileSync(files[i]!, files[i]! + suffix, 1);
          writeFileSync(temporary, `${JSON.stringify(defaultConfig(agentDir, homedir()), null, 2)}\n`, {
            mode: 0o600,
            flag: "wx",
          });
          renameSync(temporary, files[0]!);
          for (const file of files.slice(1)) if (existsSync(file)) rmSync(file);
          chmodSync(directory, 0o700);
        } catch (error) {
          for (let i = 0; i < files.length; i++) {
            if (previous[i]) writeFileSync(files[i]!, previous[i]!);
            else if (existsSync(files[i]!)) rmSync(files[i]!);
          }
          if (existsSync(temporary)) rmSync(temporary);
          throw error;
        }
        if (resetting) {
          resetting.resetPending = true;
          resetting.block("User reset policy; /reload required");
        }
        } finally { closeSync(lockFd); rmSync(lock); }
        ctx.ui.notify("Version 2 policy initialized. Run /reload. Old files are preserved as .backup-*.", "info");
        return;
      }
      const active = getOwner();
      if (!action || action === "status" || action === "grants") ctx.ui.notify(permissionAwareness(active), "info");
      else if (action === "clear") active.revoke();
      else if (action === "revoke") {
        if (!rest[0]) throw new Error("Usage: /perm revoke <approval-id>");
        active.revoke(rest[0]);
      } else if (action === "grant") {
        const access = rest.shift();
        if (access !== "read" && access !== "write") throw new Error("Usage: /perm grant read|write <directory>");
        await active.requestDirectory(modelPath(rest.join(" "), ctx.cwd), access, "User directory request");
      } else if (action === "allow")
        throw new Error("Command-pattern approvals were removed. Use /perm grant read|write <directory>.");
      else active.select(action);
      showStatus();
    },
  });
  pi.registerCommand("net", {
    description: "Inspect/toggle networking; /net allow <domain> or /net deny <domain>",
    handler: async (args, commandCtx) => {
      ctx = commandCtx;
      requireRoot();
      const active = getOwner();
      const [action, ...domains] = args.trim().split(/\s+/);
      if (!action) ctx.ui.notify(JSON.stringify(active.network.snapshot(), null, 2), "info");
      else if (action === "open" || action === "restricted" || action === "toggle")
        active.network.change({
          restricted: action === "toggle" ? !active.network.snapshot().restricted : action === "restricted",
        });
      else if (action === "allow" || action === "deny") {
        const normalized = domains.map((d) => {
          const domain = normalizeDomain(d);
          if (!domain) throw new Error(`Invalid domain: ${d}`);
          return domain;
        });
        if (action === "allow") active.network.grant(normalized);
        else
          active.network.change({
            deniedDomains: [...new Set([...active.network.snapshot().deniedDomains, ...normalized])],
          });
      } else throw new Error("Usage: /net [open|restricted|toggle|allow <domain>|deny <domain>]");
      showStatus();
    },
  });
  pi.registerShortcut("shift+tab", {
    description: "Cycle filesystem profiles",
    handler: async (_ctx) => {
      requireRoot();
      const active = getOwner();
      const order = active.config.cycleOrder;
      active.select(order[(order.indexOf(active.snapshot().mode) + 1) % order.length]!);
      showStatus();
    },
  });
  pi.registerShortcut("alt+n", {
    description: "Toggle subprocess network policy",
    handler: async () => {
      requireRoot();
      const active = getOwner();
      active.network.change({ restricted: !active.network.snapshot().restricted });
      showStatus();
    },
  });

  const stopBridge = pi.events.on("permission:attach:v2", (raw: unknown) => {
    const request = raw as PermissionBridgeRequest;
    if (!ctx || request.version !== 2 || request.parentSessionId !== ctx.sessionManager.getSessionId()) return;
    try {
      const active = getOwner();
      const release = active.attachChild(request.cancel);
      let bound = false;
      request.respond({
        factory: (childPi) => {
          permissionExtension(childPi, { owner: active, release });
          childPi.on("session_start", () => {
            active.snapshot();
            bound = true;
          });
        },
        verify: () => {
          active.snapshot();
          if (!bound) throw new Error("Required child permission hooks did not bind");
        },
        resume: (cancel) => active.attachChild(cancel),
        release,
      });
    } catch (error) {
      request.reject(String(error));
    }
  });
  const stopPresence = pi.events.on("permission:present:v2", (raw: unknown) => {
    const request = raw as { parentSessionId: string; respond(): void };
    if (ctx && request.parentSessionId === ctx.sessionManager.getSessionId()) request.respond();
  });

  pi.on("session_start", async (event, newCtx) => {
    ctx = newCtx;
    ownerSessionId = ctx.sessionManager.getSessionId();
    if (inherited) {
      owner = inherited.owner;
      owner.snapshot();
      showStatus();
      return;
    }
    try {
      const prior = event.reason === "reload" ? retained.get(key()) : undefined;
      const loaded = loadConfig(agentDir, prior?.root ?? ctx.cwd, homedir());
      if (prior && !prior.resetPending) {
        owner = prior;
        prior.ask = approvalUI(context);
        prior.askNetwork = networkUI(context, () => prior.approvalSignal);
        await prior.reload(loaded.global, loaded.project, resolution);
      } else {
        const rootPath = bindPath(path.resolve(ctx.cwd));
        const sessionFile = ctx.sessionManager.getSessionFile();
        const binding: SessionBinding | undefined = sessionFile
          ? {
              id: ctx.sessionManager.getSessionId(),
              file: bindPath(path.resolve(sessionFile)).canonical,
              cwd: rootPath.canonical,
            }
          : undefined;
        const store = new PermissionStore(agentDir);
        const restored = store.load(binding, rootPath.canonical);
        const previous = restored.session?.catalog ?? restored.project.catalog;
        const root = prior?.rootIdentity ??
          restored.session?.catalog.root ?? { family: randomUUID(), binding: rootPath };
        const global = resolveCatalog(loaded.global, root, resolution, previous?.base ?? previous);
        const catalog = tightenCatalog(global, loaded.project, resolution, previous);
        const grants = [
          ...(restored.session?.grants.filter((g) => g.lifetime === "session") ?? []),
          ...restored.project.grants,
        ];
        const exceptions = [
          ...(restored.session?.exceptions.filter((e) => e.lifetime === "session") ?? []),
          ...restored.project.exceptions,
        ];
        owner = new PermissionOwner(catalog, {
          store,
          restored: restored.session,
          grants,
          exceptions,
          ask: approvalUI(context),
          askNetwork: networkUI(context, () => owner?.approvalSignal),
        });
      }
      const flag = pi.getFlag("perm");
      if (typeof flag === "string" && flag) getOwner().select(flag);
      startupError = undefined;
      retainedKey = key();
      retained.set(retainedKey, owner);
    } catch (error) {
      startupError = String(error);
      owner?.block(startupError);
      ctx.ui.notify(
        `${startupError}\nGoverned operations are blocked. Use /perm reset for legacy policy, or repair the configuration and /reload.`,
        "error",
      );
    }
    showStatus();
  });
  pi.on("before_agent_start", () => ({
    systemPrompt: undefined,
    message: {
      customType: "permission-scope",
      content: owner ? permissionAwareness(owner) : `Filesystem policy unavailable: ${startupError}`,
      display: false,
    },
  }));
  pi.on("tool_call", (event) => {
    if (["read", "write", "edit", "grep", "find", "ls", "bash", "powershell"].includes(event.toolName)) {
      try {
        getOwner().snapshot();
      } catch (error) {
        return { block: true, reason: String(error) };
      }
    }
    return undefined;
  });
  pi.on("user_bash", () => ({
    operations: {
      exec: async (command, cwd, options) => {
        const active = getOwner();
        const accesses = await discoverShellAccess(command, cwd);
        for (const request of accesses)
          await active.authorize([request.path], request.access, request.source, options.signal);
        return active.run([path.resolve(cwd)], "read", "User shell", options.signal, async (snapshot) => {
          const family = {
            id: active.id,
            network: () => active.network.snapshot(),
            reportEnforcement: (error?: string) => { active.enforcementError = error; showStatus(); },
            decideHost: (host: string, port?: number) =>
              active.reason ? Promise.resolve(false) : active.network.decide(host, port, active.askNetwork),
          };
          return runtime
            .operations(snapshot, family, () => active.check(snapshot.revision), pi.getFlag("no-sandbox") === true)
            .exec(command, cwd, options);
        });
      },
    },
  }));
  pi.on("session_shutdown", async (event) => {
    stopBridge();
    // Keep a lightweight tombstone so a stale parent context cannot launch an ungoverned child.
    const sessionId = ownerSessionId;
    stopPresence();
    if (sessionId)
      pi.events.on("permission:present:v2", (raw: unknown) => {
        const request = raw as { parentSessionId: string; respond(): void };
        if (request.parentSessionId === sessionId) request.respond();
      });
    if (inherited) {
      inherited.release();
      return;
    }
    if (!owner) return;
    if (event.reason !== "reload" && retainedKey) retained.delete(retainedKey);
    owner.block("Session is shutting down");
    await owner.drain();
    await runtime.shutdown(owner.id);
  });
}
