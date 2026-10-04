/** Filesystem authority and network policy have independent lifetimes. */
export type Access = "read" | "write";
export type RuleAction = "allow" | "ask" | "deny";
export type Lifetime = "session" | "project";
export type ProcessMode = "compatible" | "strict";
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
  version: 3;
  $schema?: string;
  defaultMode: string;
  processMode?: ProcessMode;
  cycleOrder: string[];
  modes: Record<string, ModeDef>;
  pathRules: PathRule[];
  network: NetworkPolicy;
}

/** Execution identities are pinned within a launch, not persisted across launches. */
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

/** Exact-file authority follows a name inside a pinned parent, not a replaceable leaf inode. */
export interface FileBinding {
  lexical: string;
  canonical: string;
  parent: PathBinding;
}

export type PermissionBinding = PathBinding | FileBinding;

export interface RootIdentity {
  family: string;
  binding: PathBinding;
}

export interface AccessGrant {
  id: string;
  binding: PermissionBinding;
  access: Access;
  lifetime: Lifetime;
}

export interface ResolvedRule extends PathRule {
  id: string;
  definition: string;
  binding?: PermissionBinding;
  blocked?: string;
}

export interface RuleException {
  id: string;
  ruleId: string;
  access: Access;
  lifetime: Lifetime;
}

export interface ResourceGrant {
  /** Host-runtime resources are rediscovered instead of becoming saved authority. */
  runtime?: true;
  definition?: string;
  binding: PermissionBinding;
  scope: "file" | "tree";
  access: Access;
}

export interface ResolvedProfile {
  kind: "scoped" | "unrestricted";
  grants: ResourceGrant[];
}

export interface ResolvedCatalog {
  root: RootIdentity;
  config: PermissionModeConfig;
  profiles: Record<string, ResolvedProfile>;
  rules: ResolvedRule[];
}

export interface FilesystemSnapshot {
  revision: number;
  root: RootIdentity;
  mode: string;
  processMode?: ProcessMode;
  profile: ResolvedProfile;
  rules: ResolvedRule[];
  grants: AccessGrant[];
  exceptions: RuleException[];
}

export interface NetworkSnapshot {
  revision: number;
  restricted: boolean;
  allowedDomains: string[];
  deniedDomains: string[];
}
