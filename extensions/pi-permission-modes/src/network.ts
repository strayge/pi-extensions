import { domainMatches } from "./config-load.ts";
import type { NetworkPolicy, NetworkSnapshot } from "./schema.ts";

export type NetAskResult = "allow-session" | "allow-forever" | "deny" | "dismiss";
export type NetAsk = (host: string, port?: number) => Promise<NetAskResult>;
export const matchesDomainPattern = domainMatches;
export function isHostAllowed(host: string, patterns: Iterable<string>): boolean {
  return [...patterns].some((p) => domainMatches(host, p));
}
export function normalizeDomain(raw: string): string | undefined {
  const value = raw
    .trim()
    .toLowerCase()
    .replace(/^[a-z][a-z0-9+.-]*:\/\//, "")
    .replace(/^[^/@]*@/, "")
    .replace(/[/?#].*$/, "")
    .replace(/:\d+$/, "");
  return /^(\*\.)?[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(value) ? value : undefined;
}

/** Every proxied connection consults current state; old prompt answers cannot undo a newer denial. */
export class NetworkSession {
  private current: NetworkSnapshot;
  private readonly pending = new Map<string, Promise<boolean>>();
  private readonly persist: (state: NetworkSnapshot) => void;
  constructor(policy: NetworkPolicy, persist: (state: NetworkSnapshot) => void, restored?: NetworkSnapshot) {
    this.current = restored ?? {
      revision: 0,
      restricted: policy.default === "restricted",
      allowedDomains: [...policy.allowedDomains],
      deniedDomains: [...policy.deniedDomains],
    };
    if (
      !Number.isSafeInteger(this.current.revision) ||
      typeof this.current.restricted !== "boolean" ||
      !Array.isArray(this.current.allowedDomains) ||
      !Array.isArray(this.current.deniedDomains) ||
      [...this.current.allowedDomains, ...this.current.deniedDomains].some(
        (d) => typeof d !== "string" || normalizeDomain(d) !== d,
      )
    )
      throw new Error("Invalid saved network policy");
    this.persist = persist;
  }
  snapshot(): NetworkSnapshot {
    return structuredClone(this.current);
  }
  change(update: Partial<Omit<NetworkSnapshot, "revision">>): void {
    const next = { ...this.current, ...update, revision: this.current.revision + 1 };
    this.persist(next);
    this.current = next;
  }
  reconfigure(policy: NetworkPolicy, previous: NetworkPolicy): void {
    this.change({
      restricted: policy.default === previous.default ? this.current.restricted : policy.default === "restricted",
      allowedDomains: [
        ...new Set([
          ...policy.allowedDomains,
          ...this.current.allowedDomains.filter((d) => !previous.allowedDomains.includes(d)),
        ]),
      ],
      deniedDomains: [
        ...new Set([
          ...policy.deniedDomains,
          ...this.current.deniedDomains.filter((d) => !previous.deniedDomains.includes(d)),
        ]),
      ],
    });
  }
  grant(domains: string[]): void {
    for (const domain of domains)
      if (!normalizeDomain(domain) || normalizeDomain(domain) !== domain) throw new Error(`Invalid domain: ${domain}`);
    if (domains.some((d) => isHostAllowed(d, this.current.deniedDomains)))
      throw new Error("An explicitly denied domain cannot be approved");
    this.change({ allowedDomains: [...new Set([...this.current.allowedDomains, ...domains])] });
  }
  async decide(host: string, port?: number, ask?: NetAsk): Promise<boolean> {
    if (!this.current.restricted) return true;
    if (isHostAllowed(host, this.current.deniedDomains)) return false;
    if (isHostAllowed(host, this.current.allowedDomains)) return true;
    if (!ask) return false;
    let pending = this.pending.get(host);
    if (!pending) {
      const revision = this.current.revision;
      pending = (async () => {
        const answer = await ask(host, port);
        if (this.current.revision !== revision) return false;
        if (answer === "allow-session" || answer === "allow-forever") {
          this.grant([host]);
          return true;
        }
        if (answer === "deny") this.change({ deniedDomains: [...new Set([...this.current.deniedDomains, host])] });
        return false;
      })().finally(() => this.pending.delete(host));
      this.pending.set(host, pending);
    }
    return pending;
  }
}
