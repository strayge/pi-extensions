/** Filesystem authority and network policy have independent lifetimes. */
export type Access = "read" | "write";
export type RuleAction = "ask" | "deny";
export type Lifetime = "session" | "project";
export type ModeColor = "muted" | "mdLink" | "accent" | "error";

export type FilesystemProfile =
  | { kind: "unrestricted" }
  | { kind: "scoped"; readOnly: string[]; readWrite: string[]; resourceReads: ("pi" | "system")[] };

export interface ModeDef {
  label: string;
  color: ModeColor;
  filesystem: FilesystemProfile;
}

export interface PathRule {
  path: string;
  scope: "file" | "tree";
  read?: RuleAction;
  write?: RuleAction;
}

export interface NetworkPolicy {
  default: "restricted" | "open";
  allowedDomains: string[];
  deniedDomains: string[];
}

export interface PermissionModeConfig {
  version: 2;
  $schema?: string;
  defaultMode: string;
  cycleOrder: string[];
  modes: Record<string, ModeDef>;
  pathRules: PathRule[];
  network: NetworkPolicy;
}

/** Object identity is retained across reloads instead of trusting a new realpath. */
export interface FileIdentity {
  dev: string;
  ino: string;
  birthtimeNs: string;
  type: "file" | "directory" | "symlink" | "other";
}

export interface PathBinding {
  lexical: string;
  canonical: string;
  prefix: string;
  identity: FileIdentity;
  missing: string[];
}

export interface RootIdentity {
  family: string;
  binding: PathBinding;
}

export interface DirectoryGrant {
  id: string;
  binding: PathBinding;
  access: Access;
  lifetime: Lifetime;
}

export interface ResolvedRule extends Omit<PathRule, "path"> {
  id: string;
  definition: string;
  binding: PathBinding;
}

export interface RuleException {
  id: string;
  ruleId: string;
  access: Access;
  lifetime: Lifetime;
}

export interface ResourceGrant {
  definition?: string;
  binding: PathBinding;
  scope: "file" | "tree";
  access: Access;
}

export interface ResolvedProfile {
  kind: "scoped" | "unrestricted";
  grants: ResourceGrant[];
}

export interface ResolvedCatalog {
  /** Global bindings survive even while a repository overlay omits their scope. */
  base?: ResolvedCatalog;
  root: RootIdentity;
  config: PermissionModeConfig;
  profiles: Record<string, ResolvedProfile>;
  rules: ResolvedRule[];
}

export interface FilesystemSnapshot {
  revision: number;
  root: RootIdentity;
  mode: string;
  profile: ResolvedProfile;
  rules: ResolvedRule[];
  grants: DirectoryGrant[];
  exceptions: RuleException[];
}

export interface NetworkSnapshot {
  revision: number;
  restricted: boolean;
  allowedDomains: string[];
  deniedDomains: string[];
}
