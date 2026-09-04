import {
  closeSync,
  constants,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export const REDEMPTION_STATE_FILE_NAME = "usage-redemptions.json";

const MAX_STATE_BYTES = 64 * 1024;
const MAX_PENDING_REDEMPTIONS = 128;
const ACCOUNT_KEY_PATTERN = /^[0-9a-f]{64}$/u;
const REQUEST_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export function redemptionStatePath(): string {
  return join(getAgentDir(), REDEMPTION_STATE_FILE_NAME);
}

/**
 * Persists uncertain writes before they are sent so a reload cannot turn a
 * retry into a second redemption. Invalid state fails closed: silently
 * discarding it would also discard the only safe idempotency key.
 */
export class PendingRedemptionStore {
  private readonly path: string;
  private readonly lockPath: string;
  private readonly pending = new Map<string, string>();
  private stateError?: string;

  constructor(path = redemptionStatePath()) {
    this.path = path;
    this.lockPath = `${path}.lock`;
    this.reload();
  }

  get available(): boolean {
    return this.stateError === undefined;
  }

  get loadError(): string | undefined {
    return this.stateError;
  }

  get(accountKey: string): string | undefined {
    if (!this.available) return undefined;
    this.reload();
    return this.available ? this.pending.get(accountKey) : undefined;
  }

  getOrCreate(accountKey: string, requestId: string): string {
    this.assertAvailable();
    if (!ACCOUNT_KEY_PATTERN.test(accountKey) || !REQUEST_ID_PATTERN.test(requestId)) {
      throw new Error("Refusing to store invalid reset-redemption state.");
    }
    return this.withLock(() => {
      const pending = this.readState();
      const existing = pending.get(accountKey);
      if (existing) {
        this.replacePending(pending);
        return existing;
      }
      if (pending.size >= MAX_PENDING_REDEMPTIONS) {
        throw new Error("Too many reset redemptions have an unknown outcome.");
      }
      pending.set(accountKey, requestId);
      this.save(pending);
      this.replacePending(pending);
      return requestId;
    });
  }

  delete(accountKey: string, requestId: string): void {
    this.assertAvailable();
    this.withLock(() => {
      const pending = this.readState();
      if (pending.get(accountKey) === requestId) {
        pending.delete(accountKey);
        this.save(pending);
      }
      this.replacePending(pending);
    });
  }

  private reload(): void {
    try {
      this.replacePending(this.readState());
      this.stateError = undefined;
    } catch (error) {
      this.pending.clear();
      this.stateError = describeError(error);
    }
  }

  private readState(): Map<string, string> {
    let raw: string;
    try {
      raw = readFileSync(this.path, "utf8");
    } catch (error) {
      if (isMissingFile(error)) return new Map();
      throw error;
    }
    if (Buffer.byteLength(raw) > MAX_STATE_BYTES) throw new Error("state file is too large");
    const parsed = JSON.parse(raw) as unknown;
    if (!isRecord(parsed) || parsed.version !== 1 || !Array.isArray(parsed.pending)) {
      throw new Error("state file has an unsupported format");
    }
    if (parsed.pending.length > MAX_PENDING_REDEMPTIONS) {
      throw new Error("state file has too many pending requests");
    }

    const pending = new Map<string, string>();
    for (const entry of parsed.pending) {
      if (
        !isRecord(entry) ||
        typeof entry.accountKey !== "string" ||
        !ACCOUNT_KEY_PATTERN.test(entry.accountKey) ||
        typeof entry.requestId !== "string" ||
        !REQUEST_ID_PATTERN.test(entry.requestId) ||
        pending.has(entry.accountKey)
      ) {
        throw new Error("state file contains an invalid pending request");
      }
      pending.set(entry.accountKey, entry.requestId);
    }
    return pending;
  }

  private assertAvailable(): void {
    if (this.stateError) {
      throw new Error(`${REDEMPTION_STATE_FILE_NAME} cannot be used (${this.stateError}).`);
    }
  }

  private withLock<T>(operation: () => T): T {
    try {
      mkdirSync(this.lockPath);
    } catch (error) {
      throw new Error(
        `Reset-redemption state is busy or locked (${describeError(error)}). No request was sent.`,
      );
    }
    try {
      return operation();
    } finally {
      rmSync(this.lockPath, { recursive: true, force: true });
    }
  }

  private save(pending: Map<string, string>): void {
    const directory = dirname(this.path);
    mkdirSync(directory, { recursive: true });
    const temporary = `${this.path}.${process.pid}.tmp`;
    const value = {
      version: 1,
      pending: [...pending].map(([accountKey, requestId]) => ({ accountKey, requestId })),
    };
    const descriptor = openSync(
      temporary,
      constants.O_CREAT | constants.O_TRUNC | constants.O_WRONLY,
      0o600,
    );
    try {
      writeFileSync(descriptor, `${JSON.stringify(value, null, 2)}\n`, "utf8");
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
    renameSync(temporary, this.path);
    if (process.platform !== "win32") {
      const directoryDescriptor = openSync(directory, constants.O_RDONLY);
      try {
        fsyncSync(directoryDescriptor);
      } finally {
        closeSync(directoryDescriptor);
      }
    }
  }

  private replacePending(pending: Map<string, string>): void {
    this.pending.clear();
    for (const entry of pending) this.pending.set(...entry);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isMissingFile(error: unknown): boolean {
  return isRecord(error) && error.code === "ENOENT";
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
