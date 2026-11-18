import { spawn, type ChildProcess } from "child_process";

export type HerdrErrorCode =
  | "HERDR_UNAVAILABLE"
  | "HERDR_UNSUPPORTED_VERSION"
  | "PANE_GONE"
  | "NOT_FOUND"
  | "TIMEOUT"
  | "VALIDATION_ERROR";

export type HerdrResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: { code: HerdrErrorCode; message: string; details?: unknown } };

export interface HerdrClient {
  run<T = unknown>(args: string[], options?: { timeoutMs?: number; signal?: AbortSignal; textOk?: boolean }): Promise<HerdrResult<T>>;
}

type SpawnHerdr = (command: string, args: readonly string[], options: { shell: false; windowsHide: true; env: NodeJS.ProcessEnv }) => ChildProcess;

function error(code: HerdrErrorCode, message: string, details?: unknown): HerdrResult<never> {
  return { ok: false, error: { code, message, ...(details !== undefined ? { details } : {}) } };
}

function parseLastJson(value: string): unknown | undefined {
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  try { return JSON.parse(trimmed) as unknown; } catch {}
  for (const line of trimmed.split(/\r?\n/).reverse()) {
    try { return JSON.parse(line) as unknown; } catch {}
  }
  return undefined;
}

function normalizeCode(raw: unknown): HerdrErrorCode {
  const code = String(raw ?? "").toLowerCase();
  if (code.includes("timeout") || code.includes("timed_out")) return "TIMEOUT";
  if (code.includes("gone")) return "PANE_GONE";
  if (code.includes("not_found") || code.includes("not-found") || code === "no_such_pane") return "NOT_FOUND";
  return "VALIDATION_ERROR";
}

export function createHerdrClient(options: { bin?: string; spawn?: SpawnHerdr } = {}): HerdrClient {
  const bin = options.bin ?? process.env.HERDR_BIN ?? "herdr";
  const spawnImpl = options.spawn ?? spawn;
  return {
    run<T>(args: string[], runOptions: { timeoutMs?: number; signal?: AbortSignal; textOk?: boolean } = {}): Promise<HerdrResult<T>> {
      return new Promise((resolveResult) => {
        let child: ChildProcess;
        try {
          child = spawnImpl(bin, args, { shell: false, windowsHide: true, env: process.env });
        } catch (cause) {
          const code = (cause as NodeJS.ErrnoException | undefined)?.code;
          resolveResult(error("HERDR_UNAVAILABLE", code === "ENOENT"
            ? "Herdr is not installed or is not on PATH. Install Herdr 0.7.5+ or set HERDR_BIN."
            : `Failed to start Herdr: ${cause instanceof Error ? cause.message : String(cause)}`));
          return;
        }

        let stdout = "";
        let stderr = "";
        let settled = false;
        const finish = (result: HerdrResult<T>) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          runOptions.signal?.removeEventListener("abort", abort);
          resolveResult(result);
        };
        const abort = () => {
          child.kill();
          finish(error("TIMEOUT", `Herdr command '${args.join(" ")}' was aborted.`));
        };
        const timer = setTimeout(() => {
          child.kill();
          finish(error("TIMEOUT", `Herdr command '${args.join(" ")}' timed out after ${runOptions.timeoutMs ?? 15_000}ms.`));
        }, runOptions.timeoutMs ?? 15_000);
        timer.unref?.();

        if (runOptions.signal?.aborted) abort();
        else runOptions.signal?.addEventListener("abort", abort, { once: true });
        child.stdout?.on("data", (chunk) => { stdout += chunk.toString(); });
        child.stderr?.on("data", (chunk) => { stderr += chunk.toString(); });
        child.on("error", (cause) => {
          const code = (cause as NodeJS.ErrnoException).code;
          finish(error("HERDR_UNAVAILABLE", code === "ENOENT"
            ? "Herdr is not installed or is not on PATH. Install Herdr 0.7.5+ or set HERDR_BIN."
            : `Failed to run Herdr: ${cause.message}`));
        });
        child.on("close", (exitCode) => {
          const parsed = parseLastJson(stdout) ?? (exitCode === 0 ? undefined : parseLastJson(stderr));
          if (parsed && typeof parsed === "object" && !Array.isArray(parsed) && "error" in parsed) {
            const raw = (parsed as { error?: { code?: unknown; message?: unknown } }).error;
            finish(error(normalizeCode(raw?.code), String(raw?.message ?? "Herdr command failed."), raw));
            return;
          }
          if (exitCode === 0) {
            if (parsed !== undefined) {
              const envelope = parsed as { result?: unknown };
              finish({ ok: true, data: (envelope.result ?? parsed) as T });
            } else if (runOptions.textOk) {
              finish({ ok: true, data: stdout.trim() as T });
            } else {
              finish({ ok: true, data: {} as T });
            }
            return;
          }
          const message = stderr.split(/\r?\n/).find((line) => line.trim())?.trim() ?? `Herdr exited with code ${exitCode}.`;
          finish(error("VALIDATION_ERROR", message, { exitCode }));
        });
      });
    },
  };
}
