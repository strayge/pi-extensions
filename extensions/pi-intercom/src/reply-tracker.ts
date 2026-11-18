import type { Message } from "./types.ts";

interface PendingReply {
  peerId: string;
  messageId: string;
  resolve: (message: Message) => void;
  reject: (error: Error) => void;
}

/** Correlation is independent of delivery authorization and survives only while waiting. */
export class ReplyWaiter {
  private pending: PendingReply | null = null;
  private readonly timeoutMs: number;

  constructor(timeoutMs: number) {
    this.timeoutMs = timeoutMs;
  }

  get active(): boolean {
    return this.pending !== null;
  }

  wait(peerId: string, messageId: string, options: {
    signal?: AbortSignal;
    onFinish: () => void;
    deliveryState?: () => string;
  }): Promise<Message> {
    if (this.pending) return Promise.reject(new Error("Already waiting for a reply"));
    if (options.signal?.aborted) return Promise.reject(new Error("Cancelled before dispatch"));
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer);
        options.signal?.removeEventListener("abort", onAbort);
        this.pending = null;
        options.onFinish();
      };
      const onAbort = () => this.reject(new Error("Cancelled waiting; the recipient message was not cancelled"));
      const timer = setTimeout(() => this.reject(new Error(`No reply from "${peerId}" for message ${messageId} within ${this.timeoutMs}ms. Last known delivery state: ${options.deliveryState?.() ?? "unknown"}. Waiting ended; the recipient message was not cancelled.`)), this.timeoutMs);
      this.pending = {
        peerId,
        messageId,
        resolve: (message) => { cleanup(); resolve(message); },
        reject: (error) => { cleanup(); reject(error); },
      };
      options.signal?.addEventListener("abort", onAbort, { once: true });
    });
  }

  receive(peerId: string, message: Message): boolean {
    const pending = this.pending;
    if (!pending || pending.peerId !== peerId || message.replyTo !== pending.messageId) return false;
    pending.resolve(message);
    return true;
  }

  reject(error: Error, messageId?: string): void {
    if (messageId !== undefined && this.pending?.messageId !== messageId) return;
    this.pending?.reject(error);
  }
}
