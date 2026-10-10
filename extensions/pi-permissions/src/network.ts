import { domainMatches, domainPatterns, normalizeDomain } from "./config-load.ts";
export { normalizeDomain } from "./config-load.ts";
import type { NetworkPolicy, NetworkSnapshot } from "./schema.ts";

export type NetAskResult = "allow-session" | "allow-forever" | "deny" | "dismiss";
export type NetAsk = (host: string, port?: number, signal?: AbortSignal) => Promise<NetAskResult>;
export const matchesDomainPattern = domainMatches;
export function isHostAllowed(host: string, patterns: Iterable<string>): boolean {
  return [...patterns].some((p) => domainMatches(host, p));
}

/** Every proxied connection consults current state; old prompt answers cannot undo a newer denial. */
export class NetworkSession {
  private current: NetworkSnapshot;
  private readonly pending = new Map<string, Promise<boolean>>();
  private readonly persist: (state: NetworkSnapshot) => void;
  private readonly available: () => boolean;
  private readonly queueApproval: <T>(operation: () => Promise<T>, signal?: AbortSignal) => Promise<T>;
  constructor(
    policy: NetworkPolicy,
    persist: (state: NetworkSnapshot) => void,
    restored?: NetworkSnapshot,
    available = () => true,
    queueApproval: <T>(operation: () => Promise<T>, signal?: AbortSignal) => Promise<T> = (operation) => operation(),
  ) {
    this.current = restored ? structuredClone(restored) : {
      revision: 0,
      restricted: policy.default === "restricted",
      allowedDomains: domainPatterns(policy.allowedDomains, "allowedDomains"),
      deniedDomains: domainPatterns(policy.deniedDomains, "deniedDomains"),
    };
    if (
      !Number.isSafeInteger(this.current.revision) || this.current.revision < 0 ||
      typeof this.current.restricted !== "boolean" ||
      !Array.isArray(this.current.allowedDomains) ||
      !Array.isArray(this.current.deniedDomains) ||
      [...this.current.allowedDomains, ...this.current.deniedDomains].some(
        (d) => typeof d !== "string" || normalizeDomain(d) !== d,
      ) ||
      !domainPatterns(policy.allowedDomains, "allowedDomains").every((domain) => this.current.allowedDomains.includes(domain)) ||
      !domainPatterns(policy.deniedDomains, "deniedDomains").every((domain) => this.current.deniedDomains.includes(domain))
    )
      throw new Error("Invalid saved network policy");
    this.persist = persist;
    this.available = available;
    this.queueApproval = queueApproval;
  }
  snapshot(): NetworkSnapshot {
    return structuredClone(this.current);
  }
  change(update: Partial<Omit<NetworkSnapshot, "revision">>): void {
    if (!this.available()) throw new Error("Network policy unavailable: owner is blocked or retired");
    this.update(update);
  }
  private update(update: Partial<Omit<NetworkSnapshot, "revision">>): void {
    const next = { ...this.current, ...update, revision: this.current.revision + 1 };
    next.allowedDomains = domainPatterns(next.allowedDomains, "allowedDomains");
    next.deniedDomains = domainPatterns(next.deniedDomains, "deniedDomains");
    this.persist(next);
    this.current = next;
  }
  reconfigure(policy: NetworkPolicy, previous: NetworkPolicy): void {
    this.update({
      restricted: policy.default === previous.default ? this.current.restricted : policy.default === "restricted",
      allowedDomains: [
        ...new Set([
          ...policy.allowedDomains,
          ...this.current.allowedDomains.filter((d) => !domainPatterns(previous.allowedDomains, "allowedDomains").includes(d)),
        ]),
      ],
      deniedDomains: [
        ...new Set([
          ...policy.deniedDomains,
          ...this.current.deniedDomains.filter((d) => !domainPatterns(previous.deniedDomains, "deniedDomains").includes(d)),
        ]),
      ],
    });
  }
  grant(domains: string[]): void {
    domains = domainPatterns(domains, "allowedDomains");
    if (domains.some((d) => isHostAllowed(d, this.current.deniedDomains)))
      throw new Error("An explicitly denied domain cannot be approved");
    this.change({ allowedDomains: [...new Set([...this.current.allowedDomains, ...domains])] });
  }
  async decide(host: string, port?: number, ask?: NetAsk, signal?: AbortSignal): Promise<boolean> {
    signal?.throwIfAborted();
    if (!this.available()) return false;
    if (!this.current.restricted) return true;
    const normalized = normalizeDomain(host);
    if (!normalized || normalized.startsWith("*.")) return false;
    host = normalized;
    if (isHostAllowed(host, this.current.deniedDomains)) return false;
    if (isHostAllowed(host, this.current.allowedDomains)) return true;
    if (!ask) return false;
    let pending = this.pending.get(host);
    if (!pending) {
      pending = this.queueApproval(async () => {
        signal?.throwIfAborted();
        if (!this.available()) return false;
        if (!this.current.restricted) return true;
        if (isHostAllowed(host, this.current.deniedDomains)) return false;
        if (isHostAllowed(host, this.current.allowedDomains)) return true;
        const revision = this.current.revision;
        const answer = await ask(host, port, signal);
        signal?.throwIfAborted();
        if (!this.available() || this.current.revision !== revision) return false;
        if (answer === "allow-session" || answer === "allow-forever") {
          this.grant([host]);
          return true;
        }
        if (answer === "deny") this.change({ deniedDomains: [...new Set([...this.current.deniedDomains, host])] });
        return false;
      }, signal).finally(() => this.pending.delete(host));
      this.pending.set(host, pending);
    }
    const allowed = await pending;
    signal?.throwIfAborted();
    return allowed;
  }
}
