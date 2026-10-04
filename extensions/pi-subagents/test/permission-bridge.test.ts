import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { attachParentPermissions } from "../src/permission-bridge.ts";

function harness(governed: boolean, attach = true) {
  const verify = vi.fn();
  const release = vi.fn();
  const factory = vi.fn();
  const cancel = vi.fn();
  const pi = { events: { emit: (channel: string, request: any) => {
    if (channel === "permission:present:v2" && governed) request.respond();
    if (channel === "permission:attach:v2" && attach) { expect(request.parentSessionId).toBe("parent"); expect(request.version).toBe(2); expect(request.cancel).toBe(cancel); request.respond({ factory, verify, release, resume: () => release }); }
  } } } as unknown as ExtensionAPI;
  const ctx = { sessionManager: { getSessionId: () => "parent" } } as unknown as ExtensionContext;
  return { pi, ctx, cancel, factory, verify, release };
}

describe("permission attachment", () => {
  it("is optional for an ungoverned parent", () => {
    const f = harness(false);
    expect(attachParentPermissions(f.pi, f.ctx, f.cancel)).toBeUndefined();
  });
  it("fails a governed launch instead of dropping required enforcement", () => {
    const f = harness(true, false);
    expect(() => attachParentPermissions(f.pi, f.ctx, f.cancel)).toThrow(/Required parent filesystem policy/);
  });
  it("retains the parent's live factory and explicit lifecycle verification", () => {
    const f = harness(true);
    const attachment = attachParentPermissions(f.pi, f.ctx, f.cancel)!;
    attachment.factory(f.pi);
    attachment.verify();
    attachment.release();
    expect(f.factory).toHaveBeenCalledWith(f.pi);
    expect(f.verify).toHaveBeenCalledOnce();
    expect(f.release).toHaveBeenCalledOnce();
  });
});
