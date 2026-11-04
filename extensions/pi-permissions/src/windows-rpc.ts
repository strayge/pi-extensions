import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { TextDecoder } from "node:util";

const MAX_FRAME = 2 * 1024 * 1024;
const MAX_PENDING = 64;
const MAX_PROCESSES = 32;
const MAX_REVERSE = 32;
const MAX_QUEUE = 128;
const INPUT_CHUNK = 32 * 1024;

export class WindowsTransportError extends Error {}
export class WindowsResponseError extends Error {
  readonly code: number;
  readonly data: unknown;
  constructor(message: string, code: number, data?: unknown) {
    super(message); this.code = code; this.data = data;
  }
}
export interface WindowsNetworkRequest {
  processId: string;
  request: { host: string; port: number; protocol: "http" | "https_connect" | "socks5_tcp" | "socks5_udp" };
}
export interface WindowsNetworkDecision { allow: boolean; revision: number }
export interface WindowsProcessEvent {
  method: "process/output" | "process/exited" | "process/closed";
  processId: string;
  seq: number;
  stream?: "stdout" | "stderr" | "pty";
  chunk?: Buffer;
  exitCode?: number;
  sandboxDenied?: boolean;
}
export interface WindowsStartParams {
  processId: string;
  argv: string[];
  cwd: string;
  env: Record<string, string>;
  sandbox: Record<string, unknown> & { windowsSandboxLevel: "mxc" };
  pipeStdin?: boolean;
  enforceManagedNetwork?: boolean;
  networkProxy?: Record<string, unknown>;
}
export interface WindowsRpcOptions {
  executable: string;
  prefixArgs?: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  requestTimeoutMs?: number;
  policyTimeoutMs?: number;
  shutdownTimeoutMs?: number;
  /** The revision belongs to the evaluated verdict, not a later sample of mutable policy. */
  decideNetwork?: (request: WindowsNetworkRequest, signal: AbortSignal) => Promise<WindowsNetworkDecision>;
  networkRevision?: () => number;
}
interface Pending { resolve(value: unknown): void; reject(error: Error): void; cleanup(): void }
interface Frame { make(): string | undefined; bytes: number; resolve(): void; reject(error: Error): void }
interface ManagedProcess {
  event(event: WindowsProcessEvent): void;
  lastSeq: number;
  retired: boolean;
  closed: Promise<void>;
  resolve(): void;
  reject(error: Error): void;
}
interface Reverse {
  processId: string;
  controller: AbortController;
  timer: ReturnType<typeof setTimeout>;
}

/** Protocol failure retires this connection; commands are never replayed on a replacement server. */
export class WindowsRpcClient {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly options: WindowsRpcOptions;
  private readonly pending = new Map<number, Pending>();
  private readonly processes = new Map<string, ManagedProcess>();
  private readonly reverse = new Map<string | number, Reverse>();
  private readonly controls: Frame[] = [];
  private readonly ordinary: Frame[] = [];
  private readonly exited: Promise<void>;
  private nextId = 0;
  private inputWrites = 0;
  private reverseCallbacks = 0;
  private writing = false;
  private queuedBytes = 0;
  private initialized = false;
  private initializing = false;
  private closing = false;
  private closePromise?: Promise<void>;
  private failure?: WindowsTransportError;
  private diagnostic = "";
  private buffer: Buffer = Buffer.alloc(4096);
  private buffered = 0;

  constructor(options: WindowsRpcOptions) {
    this.options = { ...options };
    if (options.decideNetwork && !options.networkRevision) throw new Error("Executor network review requires a live policy revision");
    for (const timeout of [options.requestTimeoutMs ?? 120000, options.policyTimeoutMs ?? 120000, options.shutdownTimeoutMs ?? 5000])
      if (!Number.isSafeInteger(timeout) || timeout <= 0 || timeout > 2147483647) throw new Error("Executor deadlines must be positive finite milliseconds");
    this.child = spawn(options.executable, [...(options.prefixArgs ?? []), "--listen", "stdio", "--concurrent-requests", "4"], {
      cwd: options.cwd, env: options.env, windowsHide: true, stdio: ["pipe", "pipe", "pipe"],
    });
    this.exited = new Promise((resolve) => this.child.once("close", resolve));
    this.child.once("error", (error) => this.fail(error));
    this.child.once("exit", () => { if (!this.closing) this.fail(new Error("Executor exited unexpectedly")); });
    this.child.stdin.on("error", (error) => this.fail(error));
    this.child.stdout.on("error", (error) => this.fail(error));
    this.child.stdout.on("end", () => { if (!this.closing) this.fail(new Error("Executor transport reached EOF")); });
    this.child.stdout.on("data", (chunk: Buffer) => {
      try { this.consume(chunk); } catch (error) { this.fail(error); }
    });
    this.child.stderr.on("data", (chunk: Buffer) => { this.diagnostic = (this.diagnostic + chunk.toString("utf8")).slice(-32768); });
    this.child.stderr.on("error", (error) => this.fail(error));
  }

  get healthy(): boolean { return this.initialized && !this.failure && !this.closing; }
  get stderr(): string { return this.diagnostic; }

  async initialize(signal?: AbortSignal, timeoutMs?: number): Promise<Record<string, unknown>> {
    if (this.initialized || this.initializing) throw new Error("Executor is already initializing or initialized");
    this.initializing = true;
    try {
      const response = await this.request<Record<string, unknown>>("initialize", { clientName: "pi-permissions" }, signal, timeoutMs);
      if (typeof response?.sessionId !== "string" || !response.sessionId || !response.environmentInfo || typeof response.environmentInfo !== "object" || Array.isArray(response.environmentInfo))
        throw new Error("Executor initialization metadata is missing");
      await this.send(() => JSON.stringify({ method: "initialized", params: {} }), false);
      this.initialized = true;
      return response;
    } catch (error) { this.fail(error); throw error; }
  }

  request<T>(method: string, params: unknown, signal?: AbortSignal, timeoutMs = this.options.requestTimeoutMs ?? 120000): Promise<T> {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2147483647) return Promise.reject(new Error("Invalid executor request deadline"));
    const control = method === "process/terminate" || method === "process/signal";
    signal?.throwIfAborted();
    if (this.failure || (this.closing && !control)) return Promise.reject(this.failure ?? new WindowsTransportError("Executor is closing"));
    if (this.pending.size >= MAX_PENDING + (control ? MAX_PROCESSES : 0)) return Promise.reject(new Error("Executor request capacity exceeded"));
    const id = ++this.nextId;
    const frame = JSON.stringify({ id, method, params });
    return new Promise<T>((resolve, reject) => {
      const abort = () => {
        const call = this.pending.get(id); if (!call) return;
        this.pending.delete(id); call.cleanup(); reject(signal?.reason ?? new Error("Executor request aborted"));
      };
      const timer = setTimeout(() => this.fail(new Error(`Executor request deadline exceeded: ${method}`)), timeoutMs);
      const cleanup = () => { clearTimeout(timer); signal?.removeEventListener("abort", abort); };
      this.pending.set(id, { resolve: (value) => resolve(value as T), reject, cleanup });
      signal?.addEventListener("abort", abort, { once: true });
      void this.send(() => this.pending.has(id) ? frame : undefined, control).catch((error: Error) => {
        const call = this.pending.get(id); if (!call) return;
        this.pending.delete(id); call.cleanup(); call.reject(error);
      });
    });
  }

  async startProcess(params: WindowsStartParams, event: (event: WindowsProcessEvent) => void, timeoutMs?: number): Promise<void> {
    if (!this.healthy) throw this.failure ?? new WindowsTransportError("Executor is not ready");
    if (params.sandbox.windowsSandboxLevel !== "mxc") throw new Error("Confined Windows processes require explicit MXC selection");
    if (!params.processId || Buffer.byteLength(params.processId) > 256) throw new Error("Invalid executor process identity");
    if (this.processes.size >= MAX_PROCESSES || this.processes.has(params.processId)) throw new Error("Executor process capacity or identity conflict");
    let resolve!: () => void; let reject!: (error: Error) => void;
    const closed = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
    void closed.catch(() => {});
    const process: ManagedProcess = { event, lastSeq: -1, retired: false, closed, resolve, reject };
    this.processes.set(params.processId, process);
    try {
      const result = await this.request<{ processId: string; sandboxType: string }>("process/start", { ...params, tty: false, arg0: null }, undefined, timeoutMs);
      if (!result || typeof result !== "object" || Array.isArray(result) || result.processId !== params.processId || result.sandboxType !== "windowsMxc") {
        this.fail(new Error("Executor did not confirm Windows MXC confinement")); throw this.failure;
      }
      if (process.retired && this.processes.has(params.processId)) await this.terminateProcess(params.processId);
    } catch (error) {
      if (this.processes.get(params.processId) === process) { this.processes.delete(params.processId); process.reject(error as Error); }
      throw error;
    }
  }

  async writeProcess(processId: string, bytes: Buffer): Promise<void> {
    if (this.inputWrites >= 2) throw new Error("Executor input is backpressured");
    this.inputWrites++;
    try {
      // Empty input is byte delivery, not EOF; the grep bridge owns its terminal marker.
      for (let offset = 0; offset < bytes.length || (offset === 0 && !bytes.length); offset += INPUT_CHUNK) {
        const process = this.processes.get(processId);
        if (!process || process.retired) throw new Error("Executor process is not accepting input");
        const response = await this.request<{ status: string }>("process/write", {
          processId, chunk: bytes.subarray(offset, offset + INPUT_CHUNK).toString("base64"), writeId: randomUUID(),
        });
        if (response.status !== "accepted") throw new Error(`Executor rejected stdin bytes: ${response.status}`);
      }
    } finally { this.inputWrites--; }
  }

  readProcess<T>(processId: string, afterSeq: number | null = null): Promise<T> {
    return this.request<T>("process/read", { processId, afterSeq, maxBytes: 65536, waitMs: 0 });
  }

  async terminateProcess(processId: string): Promise<void> {
    const process = this.processes.get(processId);
    if (!process) return;
    process.retired = true; this.cancelReverse(processId);
    await this.request("process/terminate", { processId });
  }

  waitClosed(processId: string): Promise<void> {
    if (this.failure) return Promise.reject(this.failure);
    return this.processes.get(processId)?.closed ?? Promise.resolve();
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closing = true;
    this.closePromise = (async () => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const drain = Promise.all([...this.processes].map(async ([id, process]) => {
          await this.terminateProcess(id); await process.closed;
        }));
        await Promise.race([drain, new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new WindowsTransportError("Executor shutdown did not drain processes")), this.options.shutdownTimeoutMs ?? 5000);
        })]);
      } finally {
        clearTimeout(timer);
        this.fail(new Error("Executor connection closed"));
        await Promise.race([this.exited, new Promise<void>((resolve) => {
          const killTimer = setTimeout(resolve, this.options.shutdownTimeoutMs ?? 5000); killTimer.unref();
          void this.exited.then(() => { clearTimeout(killTimer); resolve(); });
        })]);
      }
    })();
    return this.closePromise;
  }

  private send(make: Frame["make"], control: boolean): Promise<void> {
    if (this.failure) return Promise.reject(this.failure);
    let first: string | undefined;
    try { first = make(); } catch (error) { return Promise.reject(error); }
    if (first === undefined) return Promise.resolve();
    const bytes = Math.max(1024, Buffer.byteLength(first));
    if (bytes > MAX_FRAME) return Promise.reject(new Error("Executor request frame exceeded limit"));
    if (this.controls.length + this.ordinary.length >= MAX_QUEUE || this.queuedBytes + bytes > 4 * MAX_FRAME + (control ? 65536 : 0))
      return Promise.reject(new Error("Executor transport queue exceeded"));
    return new Promise<void>((resolve, reject) => {
      this.queuedBytes += bytes;
      (control ? this.controls : this.ordinary).push({ make, bytes, resolve, reject });
      this.pump();
    });
  }

  private pump(): void {
    if (this.writing || this.failure) return;
    const frame = this.controls.shift() ?? this.ordinary.shift();
    if (!frame) return;
    this.queuedBytes -= frame.bytes;
    let data: string | undefined;
    try {
      data = frame.make();
      if (data !== undefined && Buffer.byteLength(data) > MAX_FRAME) throw new Error("Executor request frame exceeded limit");
    } catch (error) { frame.reject(error as Error); this.pump(); return; }
    if (data === undefined) { frame.resolve(); this.pump(); return; }
    this.writing = true;
    this.child.stdin.write(`${data}\n`, (error) => {
      this.writing = false;
      if (error) { frame.reject(error); this.fail(error); }
      else { frame.resolve(); this.pump(); }
    });
  }

  private consume(chunk: Buffer): void {
    if (this.failure) return;
    let offset = 0;
    for (;;) {
      const end = chunk.indexOf(10, offset);
      const part = chunk.subarray(offset, end < 0 ? chunk.length : end);
      if (this.buffered + part.length > MAX_FRAME) throw new Error("Executor response frame exceeded limit");
      if (this.buffered + part.length > this.buffer.length) {
        const next = Buffer.alloc(Math.min(MAX_FRAME, Math.max(this.buffer.length * 2, this.buffered + part.length)));
        this.buffer.copy(next, 0, 0, this.buffered); this.buffer = next;
      }
      part.copy(this.buffer, this.buffered); this.buffered += part.length;
      if (end < 0) return;
      const text = new TextDecoder("utf-8", { fatal: true }).decode(this.buffer.subarray(0, this.buffered)); this.buffered = 0;
      if (text.trim()) this.message(JSON.parse(text));
      offset = end + 1; if (offset === chunk.length) return;
    }
  }

  private message(value: unknown): void {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid executor message");
    const message = value as Record<string, unknown>;
    if (message.method === "network/policyRequest") { this.reviewNetwork(message); return; }
    if (typeof message.method === "string") {
      if (Object.hasOwn(message, "id")) throw new Error(`Unsupported executor reverse method: ${message.method}`);
      this.processEvent(message); return;
    }
    if (typeof message.id !== "number" || !Number.isSafeInteger(message.id)) throw new Error("Invalid executor response id");
    const pending = this.pending.get(message.id); if (!pending) return;
    if (Object.hasOwn(message, "error") === Object.hasOwn(message, "result")) throw new Error("Executor response must contain exactly one result or error");
    if (Object.hasOwn(message, "error")) {
      const error = message.error as { message?: unknown; code?: unknown; data?: unknown };
      if (!error || typeof error.message !== "string" || typeof error.code !== "number" || !Number.isSafeInteger(error.code)) throw new Error("Invalid executor error");
      this.pending.delete(message.id); pending.cleanup(); pending.reject(new WindowsResponseError(error.message, error.code, error.data));
    } else { this.pending.delete(message.id); pending.cleanup(); pending.resolve(message.result); }
  }

  private processEvent(message: Record<string, unknown>): void {
    if (!["process/output", "process/exited", "process/closed"].includes(String(message.method))) return;
    const params = message.params as Record<string, unknown>;
    if (!params || typeof params.processId !== "string" || !Number.isSafeInteger(params.seq)) throw new Error("Invalid executor process event");
    const process = this.processes.get(params.processId); if (!process) return;
    if ((params.seq as number) <= process.lastSeq) throw new Error("Executor process event sequence regressed");
    process.lastSeq = params.seq as number;
    const event: WindowsProcessEvent = { method: message.method as WindowsProcessEvent["method"], processId: params.processId, seq: process.lastSeq };
    if (event.method === "process/output") {
      if (typeof params.chunk !== "string" || !["stdout", "stderr", "pty"].includes(String(params.stream))) throw new Error("Invalid executor process output");
      event.chunk = Buffer.from(params.chunk, "base64");
      if (event.chunk.toString("base64") !== params.chunk) throw new Error("Invalid executor output encoding");
      event.stream = params.stream as WindowsProcessEvent["stream"];
    } else if (event.method === "process/exited") {
      if (!Number.isSafeInteger(params.exitCode)) throw new Error("Invalid executor exit code");
      event.exitCode = params.exitCode as number; event.sandboxDenied = params.sandboxDenied === true;
    }
    process.event(event);
    if (event.method === "process/closed") { this.processes.delete(params.processId); this.cancelReverse(params.processId); process.resolve(); }
  }

  private reviewNetwork(message: Record<string, unknown>): void {
    const id = message.id; const params = message.params as WindowsNetworkRequest;
    if ((typeof id !== "string" && typeof id !== "number") || (typeof id === "number" && !Number.isSafeInteger(id)) ||
      !params || typeof params.processId !== "string" || Buffer.byteLength(params.processId) > 256 ||
      !params.request || typeof params.request.host !== "string" || Buffer.byteLength(params.request.host) > 253 ||
      !Number.isInteger(params.request.port) || params.request.port < 0 || params.request.port > 65535 ||
      !["http", "https_connect", "socks5_tcp", "socks5_udp"].includes(params.request.protocol)) throw new Error("Invalid executor network request");
    if (this.reverse.has(id)) throw new Error("Executor reused a live reverse request id");
    const controller = new AbortController();
    const deadline = performance.now() + (this.options.policyTimeoutMs ?? 120000);
    const reply = (allow: boolean, revision: number) => {
      const reverse = this.reverse.get(id); if (!reverse) return;
      this.reverse.delete(id); clearTimeout(reverse.timer); controller.abort();
      void this.send(() => {
        const process = this.processes.get(params.processId);
        const current = allow && !this.closing && process && !process.retired && performance.now() < deadline && revision >= 0 && revision === this.networkRevision();
        return JSON.stringify({ id, result: { decision: current ? { type: "allow" } : { type: "deny", reason: "Pi network policy denied or retired this request" } } });
      }, true).catch((error) => this.fail(error));
    };
    const timer = setTimeout(() => reply(false, -1), this.options.policyTimeoutMs ?? 120000);
    this.reverse.set(id, { processId: params.processId, controller, timer });
    const process = this.processes.get(params.processId);
    if (this.reverse.size > MAX_REVERSE || this.reverseCallbacks >= MAX_REVERSE || !process || process.retired || this.closing || !this.options.decideNetwork) { reply(false, -1); return; }
    this.reverseCallbacks++;
    void Promise.resolve().then(() => controller.signal.aborted ? { allow: false, revision: -1 } : this.options.decideNetwork!(params, controller.signal)).then(
      (verdict) => reply(verdict?.allow === true, typeof verdict?.revision === "number" ? verdict.revision : -1),
    ).catch(() => reply(false, -1)).finally(() => { this.reverseCallbacks--; });
  }

  private networkRevision(): number {
    try { const value = this.options.networkRevision?.() ?? 0; return Number.isSafeInteger(value) && value >= 0 ? value : -1; }
    catch { return -1; }
  }

  private cancelReverse(processId: string): void {
    for (const [id, request] of this.reverse) {
      if (request.processId !== processId) continue;
      this.reverse.delete(id); clearTimeout(request.timer); request.controller.abort();
      void this.send(() => JSON.stringify({ id, result: { decision: { type: "deny", reason: "Pi retired the process" } } }), true).catch((error) => this.fail(error));
    }
  }

  private fail(reason: unknown): void {
    if (this.failure) return;
    this.failure = reason instanceof WindowsTransportError ? reason : new WindowsTransportError(reason instanceof Error ? reason.message : String(reason));
    for (const call of this.pending.values()) { call.cleanup(); call.reject(this.failure); } this.pending.clear();
    for (const process of this.processes.values()) process.reject(this.failure); this.processes.clear();
    for (const request of this.reverse.values()) { clearTimeout(request.timer); request.controller.abort(); } this.reverse.clear();
    for (const frame of [...this.controls, ...this.ordinary]) frame.reject(this.failure); this.controls.length = 0; this.ordinary.length = 0;
    this.queuedBytes = 0;
    this.child.stdin.destroy(); this.child.stdout.destroy(); this.child.stderr.destroy(); this.child.kill("SIGKILL");
  }
}
