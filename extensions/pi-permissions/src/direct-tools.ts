import { constants } from "node:fs";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  createEditToolDefinition,
  createReadToolDefinition,
  createWriteToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { PermissionOwner } from "./approvals.ts";
import { assertBinding, modelPath, readPath, refreshWriteBinding } from "./paths.ts";
import { decide } from "./policy.ts";
import type { FilesystemSnapshot, PathBinding } from "./schema.ts";

/** Operations close over the authorized native target; Pi keeps the original input for display. */
function check(owner: PermissionOwner, snapshot: FilesystemSnapshot, target: PathBinding, signal?: AbortSignal): void {
  signal?.throwIfAborted();
  owner.check(snapshot.revision);
  assertBinding(target);
}

export function createDirectTools(getOwner: () => PermissionOwner | undefined, cwd: string) {
  const read = createReadToolDefinition(cwd);
  const edit = createEditToolDefinition(cwd);
  const write = createWriteToolDefinition(cwd);
  return [
    {
      ...read,
      execute: async (...args: Parameters<typeof read.execute>) => {
        const [id, params, signal, update, ctx] = args;
        const owner = getOwner();
        if (!owner) return createReadToolDefinition(ctx.cwd || cwd).execute(...args);
        const requested = modelPath(params.path, ctx.cwd || cwd);
        const selected = readPath(requested);
        return owner.run(
          [...new Set([requested, selected])],
          "read",
          "Read file",
          signal,
          async (snapshot, targets, signal) => {
            const target = targets.find((t) => t.lexical === selected)!;
            const ops = {
              access: async () => {
                check(owner, snapshot, target, signal);
                await access(selected, constants.R_OK);
                signal?.throwIfAborted();
              },
              readFile: async () => {
                check(owner, snapshot, target, signal);
                const data = await readFile(selected, { signal });
                signal?.throwIfAborted();
                return data;
              },
              detectImageMimeType: async () => {
                check(owner, snapshot, target, signal);
                const module = await import(
                  new URL("./utils/mime.js", import.meta.resolve("@earendil-works/pi-coding-agent")).href
                );
                check(owner, snapshot, target, signal);
                const mime = (await module.detectSupportedImageMimeTypeFromFile(selected)) as string | undefined;
                signal?.throwIfAborted();
                return mime;
              },
            };
            return createReadToolDefinition(cwd, { operations: ops }).execute(id, params, signal, update, ctx);
          },
        );
      },
    },
    {
      ...edit,
      execute: async (...args: Parameters<typeof edit.execute>) => {
        const [id, params, signal, update, ctx] = args;
        const selected = modelPath(params.path, ctx.cwd || cwd);
        const owner = getOwner();
        if (!owner) return createEditToolDefinition(ctx.cwd || cwd).execute(...args);
        return owner.run([selected], "write", "Edit file", signal, async (snapshot, [target], signal) => {
          const ops = {
            access: async () => {
              check(owner, snapshot, target!, signal);
              await access(selected, constants.R_OK | constants.W_OK);
              signal?.throwIfAborted();
            },
            readFile: async () => {
              check(owner, snapshot, target!, signal);
              return readFile(selected, { signal });
            },
            writeFile: async (_path: string, text: string) => {
              check(owner, snapshot, target!, signal);
              await writeFile(selected, text, { signal });
            },
          };
          return createEditToolDefinition(cwd, { operations: ops }).execute(id, params, signal, update, ctx);
        });
      },
    },
    {
      ...write,
      execute: async (...args: Parameters<typeof write.execute>) => {
        const [id, params, signal, update, ctx] = args;
        const selected = modelPath(params.path, ctx.cwd || cwd);
        const owner = getOwner();
        if (!owner) return createWriteToolDefinition(ctx.cwd || cwd).execute(...args);
        return owner.run([selected], "write", "Write file", signal, async (snapshot, [initial], signal) => {
          let target = initial!;
          const parents = [target];
          const checkWrite = () => {
            signal.throwIfAborted();
            owner.check(snapshot.revision);
            // Advancing the binding must not forget any previously captured ancestor identity.
            for (const parent of parents) assertBinding(parent, true);
            const refreshed = refreshWriteBinding(target);
            if (refreshed.prefix !== target.prefix) parents.push(refreshed);
            target = refreshed;
            if (decide(snapshot, target, "write").action !== "allow")
              throw new Error(`Filesystem access denied: ${selected}`);
          };
          const ops = {
            mkdir: async () => {
              checkWrite();
              await mkdir(path.dirname(selected), { recursive: true });
              checkWrite();
            },
            writeFile: async (_path: string, text: string) => {
              checkWrite();
              await writeFile(selected, text, { signal });
            },
          };
          return createWriteToolDefinition(cwd, { operations: ops }).execute(id, params, signal, update, ctx);
        });
      },
    },
  ] as const;
}
