import { Deferred } from "../src/deferred.ts";

export function deferred(): Deferred {
  return new Deferred();
}

export function nextTurn(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}
