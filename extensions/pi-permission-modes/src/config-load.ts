import { readFileSync } from "node:fs";
import { bindPath, configLocation } from "./paths.ts";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { FilesystemProfile, ModeDef, NetworkPolicy, PathRule, PermissionModeConfig, ProcessMode, RuleAction } from "./schema.ts";

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function keys(value: Record<string, unknown>, allowed: string[], label: string): void {
  for (const key of Object.keys(value)) if (!allowed.includes(key)) throw new Error(`${label}: unknown field ${key}`);
}

function strings(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !item || item.includes("\0"))) {
    throw new Error(`${label} must be an array of nonempty strings`);
  }
  return [...new Set(value as string[])];
}

function text(value: unknown, label: string): string {
  if (typeof value !== "string" || !value || value.includes("\0"))
    throw new Error(`${label} must be a nonempty string`);
  return value;
}

function profile(value: unknown): FilesystemProfile {
  const p = object(value, "filesystem");
  if (p.kind === "unrestricted") {
    keys(p, ["kind"], "unrestricted filesystem");
    return { kind: "unrestricted" };
  }
  keys(p, ["kind", "readOnly", "readWrite", "resourceReads"], "filesystem");
  if (p.kind !== "scoped") throw new Error("filesystem.kind must be scoped or unrestricted");
  const resources = strings(p.resourceReads, "resourceReads");
  if (resources.some((r) => r !== "pi" && r !== "system")) throw new Error("resourceReads supports only pi and system");
  return {
    kind: "scoped",
    readOnly: strings(p.readOnly, "readOnly"),
    readWrite: strings(p.readWrite, "readWrite"),
    resourceReads: resources as ("pi" | "system")[],
  };
}

export function parseConfig(value: unknown): PermissionModeConfig {
  const c = object(value, "permission configuration");
  if (c.version !== 3) throw new Error("Unsupported permission configuration version; only version 3 is supported. Back up customized policy and explicitly run /perm reset.");
  keys(c, ["version", "$schema", "defaultMode", "processMode", "cycleOrder", "modes", "pathRules", "network"], "configuration");
  if (c.processMode !== undefined && c.processMode !== "compatible" && c.processMode !== "strict")
    throw new Error("processMode must be compatible or strict");
  const modes: Record<string, ModeDef> = Object.create(null);
  for (const [name, raw] of Object.entries(object(c.modes, "modes"))) {
    if (!/^[a-zA-Z0-9_-]+$/.test(name) || ["__proto__", "constructor", "prototype"].includes(name))
      throw new Error(`Invalid profile name: ${name}`);
    const mode = object(raw, `profile ${name}`);
    keys(mode, ["label", "color", "filesystem"], `profile ${name}`);
    if (!["muted", "mdLink", "accent", "error"].includes(String(mode.color)))
      throw new Error(`Invalid profile color: ${name}`);
    modes[name] = {
      label: text(mode.label, "label"),
      color: mode.color as ModeDef["color"],
      filesystem: profile(mode.filesystem),
    };
  }
  const defaultMode = text(c.defaultMode, "defaultMode");
  const cycleOrder = strings(c.cycleOrder, "cycleOrder");
  if (!modes[defaultMode] || !cycleOrder.length || cycleOrder.some((name) => !modes[name]))
    throw new Error("defaultMode and cycleOrder must name defined profiles");
  if (!Array.isArray(c.pathRules)) throw new Error("pathRules must be an array");
  const pathRules: PathRule[] = c.pathRules.map((raw) => {
    const r = object(raw, "path rule");
    keys(r, ["path", "scope", "read", "write"], "path rule");
    if (r.scope !== "file" && r.scope !== "tree") throw new Error("rule scope must be file or tree");
    for (const access of ["read", "write"] as const) {
      if (r[access] !== undefined && r[access] !== "allow" && r[access] !== "ask" && r[access] !== "deny")
        throw new Error(`rule ${access} must be allow, ask, or deny`);
    }
    if (!r.read && !r.write) throw new Error("path rule needs a read or write action");
    return {
      path: text(r.path, "rule path"),
      scope: r.scope,
      ...(r.read ? { read: r.read as RuleAction } : {}),
      ...(r.write ? { write: r.write as RuleAction } : {}),
    };
  });
  if (new Set(pathRules.map((rule) => JSON.stringify(rule))).size !== pathRules.length) throw new Error("Duplicate path rules are not allowed");
  if (c.$schema !== undefined && typeof c.$schema !== "string") throw new Error("$schema must be a string");
  const n = object(c.network, "network");
  keys(n, ["default", "allowedDomains", "deniedDomains"], "network");
  if (n.default !== "open" && n.default !== "restricted") throw new Error("network.default must be open or restricted");
  const network: NetworkPolicy = {
    default: n.default,
    allowedDomains: domainPatterns(n.allowedDomains, "allowedDomains"),
    deniedDomains: domainPatterns(n.deniedDomains, "deniedDomains"),
  };
  return {
    version: 3,
    ...(typeof c.$schema === "string" ? { $schema: c.$schema } : {}),
    defaultMode,
    ...(c.processMode !== undefined ? { processMode: c.processMode as ProcessMode } : {}),
    cycleOrder,
    modes,
    pathRules,
    network,
  };
}

/** Explicit arrays replace defaults; a profile's filesystem field replaces the whole profile scope. */
export function mergeConfig(base: PermissionModeConfig, raw: unknown): PermissionModeConfig {
  const overlay = object(raw, "configuration override");
  if (overlay.version !== 3) throw new Error("Unsupported permission configuration version; only version 3 is supported. Back up customized policy and explicitly run /perm reset.");
  keys(
    overlay,
    ["version", "$schema", "defaultMode", "processMode", "cycleOrder", "modes", "pathRules", "network"],
    "configuration override",
  );
  const modes = { ...base.modes };
  if (overlay.modes !== undefined) {
    for (const [name, mode] of Object.entries(object(overlay.modes, "modes")))
      modes[name] = { ...modes[name], ...object(mode, `profile ${name}`) } as ModeDef;
  }
  return parseConfig({
    ...base,
    ...overlay,
    modes,
    network: overlay.network !== undefined ? { ...base.network, ...object(overlay.network, "network") } : base.network,
  });
}

export const DEFAULTS_PATH = fileURLToPath(new URL("../permission-mode.defaults.json", import.meta.url));
export function defaultConfig(agentDir?: string, home?: string): PermissionModeConfig {
  const config = parseConfig(JSON.parse(readFileSync(DEFAULTS_PATH, "utf8")));
  if (process.platform === "darwin") {
    // Native tools may resolve per-user temporary directories independently of TMPDIR.
    for (const mode of Object.values(config.modes))
      if (mode.filesystem.kind === "scoped") mode.filesystem.readWrite.push("/var/folders");
  }
  if (agentDir && home && path.resolve(agentDir) !== path.join(home, ".pi", "agent")) {
    config.pathRules.push({
      path: path.join(home, ".pi", "agent", "auth.json"),
      scope: "file",
      read: "ask",
      write: "ask",
    });
  }
  return config;
}

export function readConfig(file: string): unknown | undefined {
  const binding = bindPath(configLocation(file));
  if (binding.missing.length) return undefined;
  if (binding.canonical !== binding.lexical || binding.identity.type !== "file") throw new Error(`Permission configuration must be a regular file without symlink redirection: ${file}`);
  return JSON.parse(readFileSync(binding.canonical, "utf8"));
}

export function loadConfig(
  agentDir: string,
  home: string,
): { global: PermissionModeConfig } {
  const raw = readConfig(path.join(agentDir, "permission-mode", "permission-mode.json"));
  return {
    global: raw === undefined ? defaultConfig(agentDir, home) : mergeConfig(defaultConfig(agentDir, home), raw),
  };
}

/** Match the proxy's WHATWG host normalization, including inet_aton hex/octal and abbreviated IPv4. */
export function normalizeDomain(raw: string): string | undefined {
  const value = raw.trim().toLowerCase()
    .replace(/^[a-z][a-z0-9+.-]*:\/\//, "")
    .replace(/^[^/@]*@/, "").replace(/[/?#].*$/, "").replace(/:\d+$/, "").replace(/\.$/, "");
  if (!/^(\*\.)?[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(value)) return undefined;
  const wildcard = value.startsWith("*.");
  try {
    const host = new URL(`http://${wildcard ? value.slice(2) : value}/`).hostname.replace(/\.$/, "");
    return (wildcard ? "*." : "") + host;
  } catch { return undefined; }
}

export function domainPatterns(value: unknown, label: string): string[] {
  return [...new Set(strings(value, label).map((host) => {
    const normalized = /^(\*\.)?[a-zA-Z0-9](?:[a-zA-Z0-9.-]*[a-zA-Z0-9])?$/.test(host) ? normalizeDomain(host) : undefined;
    if (!normalized) throw new Error(`Invalid domain: ${host}`);
    return normalized;
  }))];
}

export function domainMatches(host: string, pattern: string): boolean {
  const target = normalizeDomain(host);
  const rule = normalizeDomain(pattern);
  if (!target || !rule) return false;
  return rule.startsWith("*.") ? target.endsWith(rule.slice(1)) && target !== rule.slice(2) : target === rule;
}
