import { randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  openSync,
  lstatSync,
  copyFileSync,
  constants,
  fstatSync,
  unlinkSync,
  existsSync,
  mkdirSync,
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
import { assertBinding, bindPath, configLocation, modelPath } from "./paths.ts";
import { activePiPackage, resolveCatalog } from "./policy.ts";
import { LEGACY_STATE_FILE, PermissionStore, STATE_FILE, type SessionBinding } from "./permission-state.ts";
import { runtime } from "./sandbox.ts";
import { GlobalPolicyWriter } from "./policy-write.ts";
import { createStatus } from "./status.ts";
import type { PathBinding } from "./schema.ts";

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
const retainedSymbol = Symbol.for("pi.permission-modes.reload.v3");
const rootsSymbol = Symbol.for("pi.permission-modes.starting-roots.v2");
const globals = globalThis as typeof globalThis & {
  [retainedSymbol]?: Map<string, PermissionOwner>;
  [rootsSymbol]?: Map<string, PathBinding>;
};
const retained = (globals[retainedSymbol] ??= new Map<string, PermissionOwner>());
const startingRoots = (globals[rootsSymbol] ??= new Map<string, PathBinding>());
const quote = (text: string) => `'${text.replaceAll("'", "'\\''")}'`;

export default function permissionExtension(pi: ExtensionAPI, inherited?: Attachment): void {
  let owner = inherited?.owner;
  let retainedKey: string | undefined;
  let startingRoot: PathBinding | undefined;
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

  const getToolOwner = () => startupError ? undefined : getOwner();
  const [read, edit, write] = createDirectTools(getToolOwner, process.cwd());
  pi.registerTool(read);
  pi.registerTool(edit);
  pi.registerTool(write);
  const [find, grep, ls] = createSearchTools(getToolOwner, process.cwd());
  pi.registerTool(find);
  pi.registerTool(grep);
  pi.registerTool(ls);
  const bash = createBashToolDefinition(process.cwd());
  const powershell = createPowerShellToolDefinition(process.cwd());
  for (const shell of [bash, powershell]) {
    pi.registerTool({
      ...shell,
      execute: async (id, params, signal, update, toolCtx) => {
        if (startupError) {
          const tool = shell.name === "bash"
            ? createBashToolDefinition(toolCtx.cwd) : createPowerShellToolDefinition(toolCtx.cwd);
          return tool.execute(id, params, signal, update, toolCtx);
        }
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
          async (snapshot, targets, signal) => {
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
                        const candidates = process.platform === "darwin"
                          ? ["/usr/local/bin/pwsh", "/opt/homebrew/bin/pwsh"] : ["/usr/bin/pwsh"];
                        const interpreter = candidates.find(existsSync);
                        if (!interpreter)
                          throw new Error(
                            `Contained PowerShell is unavailable: install ${candidates.join(" or ")}; no unsandboxed fallback`,
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
            "Initialize permission policy v3?",
            "All user permission policy/state files will be backed up before reset. Stored approvals across projects are discarded, not migrated. Repository policy files are untouched. New defaults use project filesystem access and unrestricted networking.",
          ))
        )
          return;
        const resetting = owner;
        const root = startingRoot;
        if (!root) throw new Error("The starting project root is unavailable; restart the session before resetting policy");
        assertBinding(root);
        resetting?.block("Policy reset is draining governed work; /reload required");
        await resetting?.drain();
        if (resetting) await runtime.shutdown(resetting.id);
        if (owner !== resetting || startingRoot !== root) throw new Error("Parent policy changed during reset; retry explicitly");
        assertBinding(root);
        if (resetting) assertBinding(resetting.rootIdentity.binding);
        const directory = configLocation(path.join(agentDir, "permission-mode"));
        mkdirSync(directory, { recursive: true, mode: 0o700 });
        if (bindPath(directory).canonical !== directory) throw new Error("Permission setup does not follow directory symlinks");
        chmodSync(directory, 0o700);
        const files = [
          path.join(directory, "permission-mode.json"),
          path.join(directory, STATE_FILE),
          path.join(directory, LEGACY_STATE_FILE),
        ];
        for (const file of files) {
          const binding = bindPath(file);
          if (binding.canonical !== file || (!binding.missing.length && !lstatSync(file).isFile())) throw new Error(`Permission reset will not copy or replace a symlink or special file: ${file}`);
        }
        const suffix = `.backup-${randomUUID()}`;
        const lock = path.join(directory, ".authority.lock");
        const lockFd = openSync(lock, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
        const heldLock = fstatSync(lockFd);
        const temporary = path.join(directory, `.config-${randomUUID()}.tmp`);
        const changed: string[] = [];
        try {
          // Finish every backup before changing any source file.
          for (const file of files) if (existsSync(file)) copyFileSync(file, file + suffix, constants.COPYFILE_EXCL);
          writeFileSync(temporary, `${JSON.stringify(defaultConfig(agentDir, homedir()), null, 2)}\n`, { mode: 0o600, flag: "wx" });
          try {
            renameSync(temporary, files[0]!);
            changed.push(files[0]!);
            for (const file of files.slice(1)) if (existsSync(file)) { unlinkSync(file); changed.push(file); }
          } catch (error) {
            for (const file of changed.reverse()) {
              if (existsSync(file + suffix)) {
                copyFileSync(file + suffix, temporary);
                renameSync(temporary, file);
              } else if (existsSync(file)) unlinkSync(file);
            }
            throw error;
          }
          if (resetting) {
            resetting.resetPending = true;
            resetting.block("User reset policy; /reload required");
          }
        } finally {
          try { if (existsSync(temporary)) rmSync(temporary); } catch {}
          try {
            closeSync(lockFd);
            const current = lstatSync(lock);
            if (current.dev === heldLock.dev && current.ino === heldLock.ino) unlinkSync(lock);
          } catch {
            // A completed reset remains committed; an orphan lock blocks subsequent state writes.
            try { closeSync(lockFd); } catch {}
          }
        }
        ctx.ui.notify("Version 3 policy initialized. Restart Pi to discard old owner/runtime prototypes. Old user files are preserved as .backup-*; reapprove paths and restore reviewed custom rules manually.", "info");
        return;
      }
      const active = getOwner();
      if (!action || action === "status" || action === "grants" || action === "inspect") ctx.ui.notify(permissionAwareness(active), "info");
      else if (action === "clear") {
        if (!rest.length) active.revoke();
        else if (rest.length === 1 && rest[0] === "global") await active.changeGlobal({ kind: "clear" });
        else throw new Error("Usage: /perm clear [global]");
      } else if (action === "revoke") {
        if (rest.length !== 1 || !rest[0]) throw new Error("Usage: /perm revoke <approval-id|block:id|global:rule-id>");
        const id = rest[0];
        if (id.startsWith("global:")) await active.changeGlobal({ kind: "revoke", id: id.slice("global:".length) });
        else {
          const snapshot = active.snapshot();
          if (!snapshot.grants.some((g) => g.id === id) && !snapshot.exceptions.some((e) => e.id === id) && !active.sessionBlocks.some((b) => b.id === id)) throw new Error("Unknown or stale approval ID; use /perm inspect");
          active.revoke(id);
        }
      } else if (action === "grant") {
        const access = rest.shift();
        if ((access !== "read" && access !== "write") || !rest.length)
          throw new Error("Usage: /perm grant read|write <path>");
        await active.requestGrant(modelPath(rest.join(" "), ctx.cwd), access, "User path request");
      } else active.select(action);
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
    if (ctx && !startupError && request.parentSessionId === ctx.sessionManager.getSessionId()) request.respond();
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
      if (prior) owner = prior;
      retainedKey = key();
      startingRoot = prior?.rootIdentity.binding ?? startingRoots.get(retainedKey) ?? bindPath(path.resolve(ctx.cwd));
      startingRoots.set(retainedKey, startingRoot);
      assertBinding(startingRoot);
      const loaded = loadConfig(agentDir, homedir());
      if (prior && !prior.resetPending) {
        owner = prior;
        prior.ask = approvalUI(context);
        prior.askNetwork = networkUI(context, () => prior.approvalSignal);
        prior.confirmGlobal = async (preview, signal) => {
          if (!ctx.hasUI) throw new Error("Global permission changes require the parent UI");
          signal?.throwIfAborted();
          return ctx.ui.confirm(preview.title, preview.message, { signal });
        };
        prior.warn = (message) => ctx.ui.notify(message, "warning");
        await prior.reload(loaded.global, undefined, resolution);
      } else {
        const rootPath = startingRoot;
        const sessionFile = ctx.sessionManager.getSessionFile();
        const binding: SessionBinding | undefined = sessionFile
          ? {
              id: ctx.sessionManager.getSessionId(),
              file: bindPath(path.resolve(sessionFile)).canonical,
              cwd: rootPath.canonical,
            }
          : undefined;
        const initialRoot = prior?.rootIdentity ?? { family: randomUUID(), binding: rootPath };
        const startupResolution = { ...resolution, macExecutableFilesCache: new Map<string, string[]>() };
        resolveCatalog(loaded.global, initialRoot, startupResolution);
        const store = new PermissionStore(agentDir);
        const restored = store.load(binding, rootPath.canonical, startupResolution, loaded.global);
        const previous = restored.session?.catalog ?? restored.project.catalog;
        const root = { family: prior?.id ?? restored.session?.catalog.root.family ?? initialRoot.family, binding: rootPath };
        const catalog = resolveCatalog(loaded.global, root, startupResolution, previous);
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
          policyWriter: new GlobalPolicyWriter(resolution),
          confirmGlobal: async (preview, signal) => {
            if (!ctx.hasUI) throw new Error("Global permission changes require the parent UI");
            signal?.throwIfAborted();
            return ctx.ui.confirm(preview.title, preview.message, { signal });
          },
          warn: (message) => ctx.ui.notify(message, "warning"),
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
      const failure = String(error);
      if (owner) {
        owner.block(failure);
        await owner.drain();
        await runtime.shutdown(owner.id);
      }
      owner = undefined;
      retained.delete(key());
      startupError = failure;
      ctx.ui.notify(
        `${startupError}\nPermission policy failed to initialize. Filesystem and network restrictions are disabled. Repair the reported configuration or filesystem boundary, then /reload to restore restrictions.`,
        "warning",
      );
    }
    showStatus();
  });
  pi.on("before_agent_start", () => ({
    systemPrompt: undefined,
    message: {
      customType: "permission-scope",
      content: owner ? permissionAwareness(owner) : `Permission policy failed to initialize: ${startupError}. Filesystem access is unrestricted and subprocess networking is open.`,
      display: false,
    },
  }));
  pi.on("tool_call", (event) => {
    if (startupError) return undefined;
    if (["read", "write", "edit", "grep", "find", "ls", "bash", "powershell"].includes(event.toolName)) {
      try {
        getOwner().snapshot();
      } catch (error) {
        return { block: true, reason: String(error) };
      }
    }
    return undefined;
  });
  pi.on("user_bash", () => startupError ? undefined : ({
    operations: {
      exec: async (command, cwd, options) => {
        const active = getOwner();
        const accesses = await discoverShellAccess(command, cwd);
        for (const request of accesses)
          await active.authorize([request.path], request.access, request.source, options.signal);
        return active.run([path.resolve(cwd)], "read", "User shell", options.signal, async (snapshot, _targets, signal) => {
          const family = {
            id: active.id,
            network: () => active.network.snapshot(),
            reportEnforcement: (error?: string) => { active.enforcementError = error; showStatus(); },
            decideHost: (host: string, port?: number) =>
              active.reason ? Promise.resolve(false) : active.network.decide(host, port, active.askNetwork),
          };
          return runtime
            .operations(snapshot, family, () => active.check(snapshot.revision), pi.getFlag("no-sandbox") === true)
            .exec(command, cwd, { ...options, signal });
        });
      },
    },
  }));
  pi.on("session_shutdown", async (event) => {
    stopBridge();
    // Retired sessions stay governed; reload lets the replacement report its own initialization state.
    const sessionId = ownerSessionId;
    stopPresence();
    if (sessionId && event.reason !== "reload")
      pi.events.on("permission:present:v2", (raw: unknown) => {
        const request = raw as { parentSessionId: string; respond(): void };
        if (request.parentSessionId === sessionId) request.respond();
      });
    if (inherited) {
      inherited.release();
      return;
    }
    if (event.reason !== "reload" && retainedKey) {
      retained.delete(retainedKey);
      startingRoots.delete(retainedKey);
    }
    if (!owner) return;
    owner.block("Session is shutting down");
    await owner.drain();
    await runtime.shutdown(owner.id);
  });
}
