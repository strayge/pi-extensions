export interface ApprovalTask<T> {
  promise: Promise<T>;
  run(): Promise<T>;
}

/** Pi has one dialog slot, so ownership spans the entire approval and confirmation flow. */
export class ApprovalQueue {
  private active = false;
  private waiting: (() => void)[] = [];

  enqueue<T>(operation: () => Promise<T>, signal?: AbortSignal): ApprovalTask<T> {
    let resolve!: (value: T) => void;
    let reject!: (reason: unknown) => void;
    const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
    let started = false;
    const remove = () => {
      signal?.removeEventListener("abort", abort);
      this.waiting = this.waiting.filter((entry) => entry !== start);
    };
    const abort = () => {
      if (started) return;
      started = true;
      remove();
      reject(signal!.reason);
    };
    const run = () => {
      if (!started) {
        started = true;
        remove();
        try {
          signal?.throwIfAborted();
          operation().then(resolve, reject);
        } catch (error) { reject(error); }
      }
      return promise;
    };
    const start = () => {
      this.active = true;
      const release = () => {
        this.active = false;
        this.waiting.shift()?.();
      };
      void run().then(release, release);
    };
    if (signal?.aborted) abort();
    else {
      signal?.addEventListener("abort", abort, { once: true });
      this.waiting.push(start);
      if (!this.active) this.waiting.shift()?.();
    }
    return { promise, run };
  }

  run<T>(operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    return this.enqueue(operation, signal).promise;
  }
}
