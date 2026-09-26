import { randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  fsyncSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { parseConfig } from "./config-load.ts";
import { assertBinding, bindPath } from "./paths.ts";
import { validateCatalog } from "./policy.ts";
import type { DirectoryGrant, NetworkSnapshot, ResolvedCatalog, RuleException } from "./schema.ts";

export interface SessionBinding {
  id: string;
  file: string;
  cwd: string;
}
export interface SavedState {
  binding: SessionBinding;
  catalog: ResolvedCatalog;
  mode: string;
  grants: DirectoryGrant[];
  exceptions: RuleException[];
  network: NetworkSnapshot;
  generation: number;
}
interface ProjectState {
  generation: number;
  grants: DirectoryGrant[];
  exceptions: RuleException[];
  catalog?: ResolvedCatalog;
}
interface Document {
  version: 2;
  sessions: Record<string, SavedState>;
  projects: Record<string, ProjectState>;
}

function key(value: unknown): string {
  return JSON.stringify(value);
}

function secureFile(file: string, directory: boolean): void {
  const st = lstatSync(file);
  if (
    st.isSymbolicLink() ||
    (directory ? !st.isDirectory() : !st.isFile()) ||
    (process.getuid && st.uid !== process.getuid()) ||
    st.mode & 0o077
  )
    throw new Error(`Permission state must be private and owned by this user: ${file}`);
}

function validateRecords(grants: DirectoryGrant[], exceptions: RuleException[]): void {
  if (!Array.isArray(grants) || !Array.isArray(exceptions)) throw new Error("Malformed permission records");
  const ids = new Set<string>();
  for (const record of [...grants, ...exceptions]) {
    if (
      !record ||
      typeof record.id !== "string" ||
      !record.id ||
      ids.has(record.id) ||
      !["read", "write"].includes(record.access) ||
      !["session", "project"].includes(record.lifetime)
    )
      throw new Error("Malformed permission record");
    ids.add(record.id);
    if ("binding" in record) {
      assertBinding(record.binding);
      if (record.binding.identity.type !== "directory" || record.binding.missing.length)
        throw new Error("Invalid saved directory grant");
    } else if (typeof record.ruleId !== "string") throw new Error("Invalid saved rule exception");
  }
}

/** A protected whole-document lock prevents stale sessions from resurrecting project grants. */
export class PermissionStore {
  readonly directory: string;
  private sessionGeneration = 0;
  private projectGeneration = 0;
  private binding?: SessionBinding;

  constructor(agentDir: string) {
    this.directory = path.join(agentDir, "permission-mode");
    const parent = bindPath(agentDir);
    if (parent.missing.length || parent.lexical !== parent.canonical)
      throw new Error("Permission agent directory must exist without symlink redirection");
    try {
      mkdirSync(this.directory, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    secureFile(this.directory, true);
  }

  private transaction<T>(operation: (document: Document) => { result: T; write?: boolean }, signal?: AbortSignal): T {
    const lock = path.join(this.directory, ".authority.lock");
    let fd: number;
    try {
      fd = openSync(lock, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    } catch {
      throw new Error(
        `Permission state is locked or unsafe: ${lock}. Stop other writers and verify an orphan before manual recovery.`,
      );
    }
    const file = path.join(this.directory, "state-v2.json");
    let temporary: string | undefined;
    try {
      signal?.throwIfAborted();
      secureFile(this.directory, true);
      let document: Document = { version: 2, sessions: {}, projects: {} };
      try {
        secureFile(file, false);
        document = JSON.parse(readFileSync(file, "utf8")) as Document;
        if (
          document.version !== 2 ||
          !document.sessions ||
          typeof document.sessions !== "object" ||
          Array.isArray(document.sessions) ||
          !document.projects ||
          typeof document.projects !== "object" ||
          Array.isArray(document.projects)
        )
          throw new Error("Malformed permission state document");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      const outcome = operation(document);
      signal?.throwIfAborted();
      if (outcome.write) {
        temporary = path.join(this.directory, `.state-${randomUUID()}.tmp`);
        const out = openSync(temporary, "wx", 0o600);
        try {
          writeFileSync(out, `${JSON.stringify(document)}\n`);
          fsyncSync(out);
        } finally {
          closeSync(out);
        }
        signal?.throwIfAborted();
        renameSync(temporary, file);
        temporary = undefined;
        // The rename is the commit point. Do not report a committed grant as a failed write.
        try {
          const dir = openSync(this.directory, constants.O_RDONLY | constants.O_DIRECTORY);
          try {
            fsyncSync(dir);
          } finally {
            closeSync(dir);
          }
        } catch {
          /* Atomic rename has committed; a directory-flush failure cannot roll it back. */
        }
      }
      return outcome.result;
    } finally {
      if (temporary) {
        try {
          unlinkSync(temporary);
        } catch {}
      }
      const held = fstatSync(fd);
      closeSync(fd);
      const current = lstatSync(lock);
      if (held.dev === current.dev && held.ino === current.ino) unlinkSync(lock);
    }
  }

  load(binding: SessionBinding | undefined, cwd: string): { session?: SavedState; project: ProjectState } {
    this.binding = binding;
    return this.transaction((document) => {
      const project = document.projects[key(cwd)] ?? { generation: 0, grants: [], exceptions: [] };
      validateRecords(project.grants, project.exceptions);
      if (!Number.isSafeInteger(project.generation) || project.generation < 0)
        throw new Error("Invalid project generation");
      this.projectGeneration = project.generation;
      const session = binding ? document.sessions[key(binding.id)] : undefined;
      if (session) {
        if (key(session.binding) !== key(binding))
          throw new Error("Session permission binding mismatch: ID, session file, and starting cwd must all match");
        parseConfig(session.catalog.config);
        validateCatalog(session.catalog);
        validateRecords(session.grants, session.exceptions);
        if (
          !session.catalog.profiles[session.mode] ||
          !Number.isSafeInteger(session.generation) ||
          session.generation < 0
        )
          throw new Error("Invalid saved session authority");
        this.sessionGeneration = session.generation;
      }
      return { result: { session, project } };
    });
  }

  save(state: Omit<SavedState, "binding" | "generation">, cwd: string, signal?: AbortSignal): void {
    const generations = this.transaction((document) => {
      const projectKey = key(cwd);
      const project = document.projects[projectKey];
      const sessionKey = this.binding ? key(this.binding.id) : undefined;
      const current = sessionKey ? document.sessions[sessionKey] : undefined;
      if (
        (project?.generation ?? 0) !== this.projectGeneration ||
        (current?.generation ?? 0) !== this.sessionGeneration
      )
        throw new Error("Permission state changed in another session; reload before changing authority");
      const projectGrants = state.grants.filter((g) => g.lifetime === "project");
      const projectExceptions = state.exceptions.filter((e) => e.lifetime === "project");
      const changed =
        key(projectGrants) !== key(project?.grants ?? []) || key(projectExceptions) !== key(project?.exceptions ?? []);
      document.projects[projectKey] = {
        generation: this.projectGeneration + Number(changed),
        grants: projectGrants,
        exceptions: projectExceptions,
        catalog: state.catalog,
      };
      if (sessionKey && this.binding)
        document.sessions[sessionKey] = { ...state, binding: this.binding, generation: this.sessionGeneration + 1 };
      return {
        result: {
          session: this.sessionGeneration + Number(!!sessionKey),
          project: this.projectGeneration + Number(changed),
        },
        write: !!sessionKey || changed,
      };
    }, signal);
    // A successful atomic commit is the only event that advances the writer's generations.
    this.sessionGeneration = generations.session;
    this.projectGeneration = generations.project;
  }
}
