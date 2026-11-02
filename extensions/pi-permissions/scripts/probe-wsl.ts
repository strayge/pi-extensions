import { spawnSync } from "node:child_process";
import { closeSync, constants, existsSync, fstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readlinkSync, realpathSync, renameSync, rmSync, statfsSync, writeFileSync } from "node:fs";
import { release } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { bindPath, identity, sameIdentity } from "../src/paths.ts";
import type { RuntimePolicy } from "../src/sandbox.ts";

const usage = `Usage: node --experimental-strip-types scripts/probe-wsl.ts <existing-parent> [--keep] [--cmd-exe <path-to-cmd.exe>]

Run manually in a normal WSL terminal, not through Pi's governed tools.
Creates a uniquely named disposable folder beneath existing-parent.
Writes only that folder; does not change policy, mounts outside child namespaces,
Windows case-sensitivity flags, or ACLs. Dependencies must already be installed.

Examples:
  node --experimental-strip-types scripts/probe-wsl.ts /tmp
  node --experimental-strip-types scripts/probe-wsl.ts /mnt/c/Users/YOU/probe-parent

Optional --cmd-exe first confirms host execution outside the sandbox, then
exposes that executable read-only inside it. Both attempts run only:
cmd.exe /d /c exit 0. A successful sandboxed launch is a failed check;
an unavailable host baseline makes the interop result inconclusive.
The optional interop test also inspects sandbox path metadata and attempts
local Unix-socket connections without sending protocol data.
--keep retains the disposable folder for inspection.

This tests native paths and the patched Linux mount backend directly. It does
NOT bypass the running Pi policy or exercise grants, asks, direct-tool gates,
network policy, all WSL variants, or a complete Windows interop attack surface.
A clean report is feasibility evidence, NOT proof of supported confinement.
`;

interface Check { name: string; ok: boolean; detail?: string }
interface ChildReport { checks: Check[]; observations?: Record<string, unknown>[] }
type Region = RuntimePolicy["program"][number];
const args = process.argv.slice(2);
if (args.length === 0 || args.includes("--help")) {
  console.log(usage);
  process.exit(args.includes("--help") ? 0 : 2);
}
const parentArg = args.shift()!;
let keep = false;
let cmdExe: string | undefined;
while (args.length) {
  const arg = args.shift();
  if (arg === "--keep") keep = true;
  else if (arg === "--cmd-exe" && args[0] && !args[0].startsWith("--")) cmdExe = args.shift();
  else throw new Error(`Unknown or incomplete option: ${arg}\n${usage}`);
}
if (process.platform !== "linux") throw new Error("This probe requires Linux/WSL; no native Windows execution.");
if (!path.isAbsolute(parentArg)) throw new Error("Supply an existing absolute parent directory.");
const parent = realpathSync.native(parentArg);
if (identity(parent).type !== "directory") throw new Error("The parent must be an existing directory.");
const bwrap = "/usr/bin/bwrap";
if (!existsSync(bwrap)) throw new Error("Install bubblewrap separately before running this probe.");
const runtimeUrl = import.meta.resolve("@anthropic-ai/sandbox-runtime");
const helper = fileURLToPath(new URL(`../vendor/seccomp/${process.arch}/apply-seccomp`, runtimeUrl));
if (!existsSync(helper)) throw new Error(`Missing sandbox seccomp helper: ${helper}`);
if (cmdExe) {
  cmdExe = realpathSync.native(cmdExe);
  if (path.basename(cmdExe).toLowerCase() !== "cmd.exe" || identity(cmdExe).type !== "file")
    throw new Error("--cmd-exe must name an existing cmd.exe regular file.");
}
const backend = await import(new URL("./sandbox/linux-sandbox-utils.js", runtimeUrl).href);
const fixture = mkdtempSync(path.join(parent, "pi-permissions-wsl-probe-"));
const fixtureIdentity = identity(fixture);
const checks: Check[] = [];
const errors: { scenario: string; detail: string }[] = [];
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
const region = (file: string, directory: boolean, write: boolean, read = true): Region => ({ path: file, directory, read, write });
const work = path.join(fixture, "Work");
const readonly = path.join(fixture, "ReadOnly");
const exact = path.join(fixture, "Exact");
const pinned = path.join(fixture, "Pinned");
const guarded = path.join(work, "Guarded");
const sandboxEnv = { PATH: "/usr/bin:/bin", HOME: "/tmp", ...(process.env.WSL_INTEROP ? { WSL_INTEROP: process.env.WSL_INTEROP } : {}) };
let interopBaselinePassed = false;

/** Use the installed patched backend without relaxing the extension's native-filesystem guard. */
async function sandbox(name: string, regions: Region[], guards: string[], script: string, beforeSpawn?: (sources: ReadonlyMap<string, number>) => void): Promise<void> {
  const fds: number[] = [];
  const hostSources = new Map<string, number>();
  let wrapped = false;
  try {
    const sources = new Map<string, Region>();
    for (const entry of [...resources, ...regions]) if (entry.read) sources.set(entry.path, entry);
    const policy: RuntimePolicy = {
      bindings: {}, sourceFds: {}, guards,
      grants: [...resources, ...regions].filter((entry) => entry.read),
      rules: regions.filter((entry) => !entry.read || !entry.write),
      program: [...resources, ...regions],
    };
    for (const [file, entry] of sources) {
      const binding = bindPath(file);
      const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | (entry.directory ? constants.O_DIRECTORY : 0));
      fds.push(fd);
      hostSources.set(file, fd);
      const stat = fstatSync(fd, { bigint: true });
      if (String(stat.dev) !== binding.identity.dev || String(stat.ino) !== binding.identity.ino)
        throw new Error(`Source changed while pinning ${file}`);
      policy.bindings[file] = binding;
      policy.sourceFds![file] = fds.length + 2;
    }
    const childScript = `(async () => {\n${childPrelude}\n${script}\nconsole.log(JSON.stringify({checks, observations}));\n})().catch(error => { console.error(error); process.exitCode = 1; });`;
    const command = `${quote(node)} -e ${quote(childScript)}`;
    const generated = await backend.wrapCommandWithSandboxLinux({
      command, needsNetworkRestriction: false, allowAllUnixSockets: false,
      binShell: "/bin/bash", bwrapPath: bwrap, seccompConfig: { applyPath: helper },
      readConfig: { denyOnly: ["/"], allowWithinDeny: [], explicitPolicy: policy },
      writeConfig: { allowOnly: [], denyWithinAllow: [], explicitPolicy: policy },
    });
    wrapped = true;
    if (!generated.includes("--ro-bind-fd") || !generated.includes(helper))
      throw new Error("The installed backend is missing required descriptor mounts or the seccomp helper.");
    beforeSpawn?.(hostSources);
    const result = spawnSync("/bin/bash", ["-c", `exec ${generated}`], {
      cwd: "/", env: sandboxEnv,
      stdio: ["ignore", "pipe", "pipe", ...fds], encoding: "utf8", timeout: 20000, killSignal: "SIGKILL", maxBuffer: 1024 * 1024,
    });
    if (result.error || result.status !== 0)
      throw new Error(`${result.error?.message ?? `exit=${result.status}, signal=${result.signal}`} ${result.stderr}`.trim());
    const report = JSON.parse(result.stdout.trim()) as ChildReport;
    if (!Array.isArray(report.checks) || report.checks.length === 0) throw new Error("No child checks returned.");
    for (const observation of report.observations ?? []) console.log(JSON.stringify({ scenario: name, observation }));
    for (const check of report.checks) record({ ...check, name: `${name}: ${check.name}` });
  } catch (error) {
    const detail = String(error);
    errors.push({ scenario: name, detail });
    console.log(JSON.stringify({ scenario: name, error: detail }));
  } finally {
    for (const fd of fds) closeSync(fd);
    if (wrapped) backend.cleanupBwrapMountPoints();
  }
}

function record(check: Check): void {
  checks.push(check);
  console.log(JSON.stringify(check));
}

/** Marker classification avoids dumping arbitrary contents if an unexpected target is exposed. */
function inspectProbeFile(file: string) {
  try {
    const content = readFileSync(file, "utf8");
    return { marker: content === "PINNED" || content === "REPLACEMENT" ? content : "unexpected", length: content.length, identity: identity(file) };
  } catch (error) {
    return { error: (error as NodeJS.ErrnoException).code };
  }
}

const node = realpathSync.native(process.execPath);
const systemPaths = ["/usr", "/bin", "/sbin", "/lib", "/lib64", "/etc/ld.so.cache", "/etc/ld.so.conf", "/etc/ld.so.conf.d", "/etc/ssl/certs", "/etc/passwd", "/etc/group", "/etc/nsswitch.conf", helper, node];
const resources: Region[] = [];
for (const file of systemPaths) {
  if (!existsSync(file)) continue;
  const canonical = realpathSync.native(file);
  if (resources.some((entry) => entry.path === canonical || (entry.directory && canonical.startsWith(`${entry.path}/`)))) continue;
  resources.push(region(canonical, identity(canonical).type === "directory", false));
}
resources.sort((a, b) => a.path.split("/").length - b.path.split("/").length);
const childPrelude = `
const fs = require('node:fs');
const cp = require('node:child_process');
const checks = [];
const observations = [];
function inspectProbeFile(file) {
  try {
    const content = fs.readFileSync(file, 'utf8'), stat = fs.statSync(file, {bigint: true});
    return {marker: ['PINNED', 'REPLACEMENT'].includes(content) ? content : 'unexpected', length: content.length,
      identity: {dev: String(stat.dev), ino: String(stat.ino), birthtimeNs: String(stat.birthtimeNs)}};
  } catch (error) { return {error: error.code}; }
}
function check(name, ok, detail) { checks.push({name, ok, ...(detail ? {detail} : {})}); }
function readable(file, text) { try { return fs.readFileSync(file, 'utf8') === text; } catch { return false; } }
function blocked(name, action) { try { action(); check(name, false, 'operation succeeded'); } catch (e) { check(name, true, e.code); } }
`;

try {
  for (const dir of [work, readonly, exact, pinned, guarded, path.join(work, "Hidden")]) mkdirSync(dir);
  writeFileSync(path.join(fixture, "Outside.txt"), "OUTSIDE");
  writeFileSync(path.join(readonly, "Data.txt"), "READONLY");
  writeFileSync(path.join(exact, "Only.txt"), "EXACT");
  writeFileSync(path.join(exact, "Sibling.txt"), "SIBLING");
  writeFileSync(path.join(pinned, "Data.txt"), "PINNED");
  writeFileSync(path.join(work, "Secret.txt"), "SECRET");
  writeFileSync(path.join(guarded, "Locked.txt"), "LOCKED");
  // Production prepares a real empty mountpoint before masking a future restriction.
  writeFileSync(path.join(work, "Future.txt"), "");
  writeFileSync(path.join(work, "Hidden", "Secret.txt"), "HIDDEN");
  writeFileSync(path.join(work, "Hidden", "Allowed.txt"), "EXCEPTION");
  const alias = path.join(work, "sEcReT.TxT");
  const nativeAlias = existsSync(alias) ? bindPath(alias) : undefined;
  const source = bindPath(path.join(work, "Secret.txt"));
  console.log(JSON.stringify({
    probe: "native paths + patched Linux backend only", probeVersion: 3, fixture, kernel: release(), node: process.version,
    filesystemType: `0x${statfsSync(fixture).type.toString(16)}`,
    bwrap: spawnSync(bwrap, ["--version"], { encoding: "utf8", timeout: 3000 }).stdout?.trim(),
    caseAliasExists: !!nativeAlias,
    aliasIdentityMatches: nativeAlias ? sameIdentity(source.identity, nativeAlias.identity) : null,
    aliasCanonicalMatches: nativeAlias ? source.canonical === nativeAlias.canonical : null,
    interopAttemptRequested: !!cmdExe,
  }));

  const roData = path.join(readonly, "Data.txt");
  await sandbox("read-only tree", [region(readonly, true, false)], [], `
    const dir = ${JSON.stringify(readonly)}, file = ${JSON.stringify(roData)};
    check('read approved content', readable(file, 'READONLY'));
    check('outside content hidden', !readable(${JSON.stringify(path.join(fixture, "Outside.txt"))}, 'OUTSIDE'));
    blocked('append denied', () => fs.appendFileSync(file, 'BAD'));
    blocked('create denied', () => fs.writeFileSync(dir + '/New.txt', 'BAD'));
    blocked('mkdir denied', () => fs.mkdirSync(dir + '/NewDir'));
    blocked('rename denied', () => fs.renameSync(file, dir + '/Moved.txt'));
    blocked('unlink denied', () => fs.unlinkSync(file));
  `);
  record({ name: "host verification: read-only content unchanged", ok: existsSync(roData) && readFileSync(roData, "utf8") === "READONLY" });

  await sandbox("read-write tree", [region(work, true, true)], [], `
    const dir = ${JSON.stringify(work)};
    fs.mkdirSync(dir + '/Scratch');
    fs.writeFileSync(dir + '/Scratch/A.txt', 'A');
    fs.appendFileSync(dir + '/Scratch/A.txt', 'B');
    fs.renameSync(dir + '/Scratch/A.txt', dir + '/Scratch/B.txt');
    check('create/edit/rename admitted', readable(dir + '/Scratch/B.txt', 'AB'));
    fs.unlinkSync(dir + '/Scratch/B.txt'); fs.rmdirSync(dir + '/Scratch');
    check('delete admitted', !fs.existsSync(dir + '/Scratch'));
    check('outside content hidden', !readable(${JSON.stringify(path.join(fixture, "Outside.txt"))}, 'OUTSIDE'));
    try { fs.writeFileSync(${JSON.stringify(path.join(fixture, "Outside.txt"))}, 'BAD'); } catch {}
  `);
  // Private skeleton directories may accept shadow writes; the host must remain unchanged.
  record({ name: "host verification: outside file unchanged", ok: readFileSync(path.join(fixture, "Outside.txt"), "utf8") === "OUTSIDE" });

  const hidden = path.join(work, "Hidden");
  const secret = path.join(work, "Secret.txt");
  const locked = path.join(guarded, "Locked.txt");
  const future = path.join(work, "Future.txt");
  await sandbox("nested rules", [
    region(work, true, true), region(guarded, true, true), region(secret, false, false, false), region(locked, false, false),
    region(future, false, false, false), region(hidden, true, false, false), region(path.join(hidden, "Allowed.txt"), false, true),
  ], [work, guarded], `
    const dir = ${JSON.stringify(work)};
    check('exact file deny hides content', !readable(dir + '/Secret.txt', 'SECRET'));
    check('tree deny hides content', !readable(dir + '/Hidden/Secret.txt', 'HIDDEN'));
    check('narrow exception admitted', readable(dir + '/Hidden/Allowed.txt', 'EXCEPTION'));
    fs.appendFileSync(dir + '/Hidden/Allowed.txt', '!');
    check('narrow exception writable', readable(dir + '/Hidden/Allowed.txt', 'EXCEPTION!'));
    blocked('read-only file append denied', () => fs.appendFileSync(dir + '/Guarded/Locked.txt', 'BAD'));
    blocked('prepared future placeholder overwrite denied', () => fs.writeFileSync(dir + '/Future.txt', 'BAD'));
    blocked('guarded intermediate rename denied', () => fs.renameSync(dir + '/Guarded', dir + '/Guarded-moved'));
    ${nativeAlias ? `
    check('alternate-case file deny hides content', !readable(dir + '/sEcReT.TxT', 'SECRET'));
    check('alternate-case tree deny hides content', !readable(dir + '/hIdDeN/Secret.txt', 'HIDDEN'));
    blocked('alternate-case file write denied', () => fs.appendFileSync(dir + '/Guarded/lOcKeD.TxT', 'BAD'));
    blocked('alternate-case prepared placeholder overwrite denied', () => fs.writeFileSync(dir + '/fUtUrE.TxT', 'BAD'));
    ` : ""}
  `);
  for (const [file, expected] of [[secret, "SECRET"], [locked, "LOCKED"], [future, ""]])
    record({ name: `host verification: ${path.basename(file!)} unchanged`, ok: existsSync(file!) && readFileSync(file!, "utf8") === expected });

  await sandbox("exact-file grant", [region(path.join(exact, "Only.txt"), false, true)], [], `
    const file = ${JSON.stringify(path.join(exact, "Only.txt"))};
    check('approved file readable', readable(file, 'EXACT'));
    fs.appendFileSync(file, '!');
    check('approved file writable', readable(file, 'EXACT!'));
    check('sibling content hidden', !readable(${JSON.stringify(path.join(exact, "Sibling.txt"))}, 'SIBLING'));
    try { fs.writeFileSync(${JSON.stringify(path.join(exact, "New.txt"))}, 'BAD'); } catch {}
  `);
  record({ name: "host verification: sibling creation isolated", ok: !existsSync(path.join(exact, "New.txt")) });

  await sandbox("descriptor pinning", [region(pinned, true, false)], [], `
    const mounted = inspectProbeFile(${JSON.stringify(path.join(pinned, "Data.txt"))});
    observations.push({mountedFile: mounted,
      mountInfo: fs.readFileSync('/proc/self/mountinfo', 'utf8').split('\\n').filter(line => line.includes('/Pinned'))});
    check('original source retained after replacement', mounted.marker === 'PINNED', JSON.stringify(mounted));
  `, (sources) => {
    const directoryFd = sources.get(pinned)!;
    console.log(JSON.stringify({ scenario: "descriptor pinning", observation: {
      stage: "before replacement", directory: identity(directoryFd), link: readlinkSync(`/proc/self/fd/${directoryFd}`),
    } }));
    renameSync(pinned, `${pinned}-original`);
    mkdirSync(pinned);
    writeFileSync(path.join(pinned, "Data.txt"), "REPLACEMENT");
    console.log(JSON.stringify({ scenario: "descriptor pinning", observation: {
      stage: "after replacement", directory: identity(directoryFd), link: readlinkSync(`/proc/self/fd/${directoryFd}`),
      throughDirectoryFd: inspectProbeFile(`/proc/self/fd/${directoryFd}/Data.txt`),
      originalPath: inspectProbeFile(path.join(`${pinned}-original`, "Data.txt")), replacementPath: inspectProbeFile(path.join(pinned, "Data.txt")),
    } }));
  });

  if (cmdExe) {
    const baseline = spawnSync(cmdExe, ["/d", "/c", "exit", "0"], {
      cwd: fixture, env: sandboxEnv, stdio: "ignore", timeout: 5000, killSignal: "SIGKILL",
    });
    interopBaselinePassed = !baseline.error && baseline.status === 0;
    console.log(JSON.stringify({ interopHostBaseline: interopBaselinePassed, code: (baseline.error as NodeJS.ErrnoException | undefined)?.code, status: baseline.status }));
    if (!interopBaselinePassed) {
      const error = { scenario: "Windows interop", detail: "Host baseline unavailable; sandbox denial is inconclusive." };
      errors.push(error);
      console.log(JSON.stringify(error));
    } else {
      await sandbox("Windows interop", [region(work, true, true), region(cmdExe, false, false)], [], `
        const result = cp.spawnSync(${JSON.stringify(cmdExe)}, ['/d', '/c', 'exit', '0'], {timeout: 5000, encoding: 'utf8'});
        check('host-working Windows launch unavailable inside sandbox', !!result.error && ['ENOENT', 'EACCES', 'EPERM', 'ENOEXEC'].includes(result.error.code),
          JSON.stringify({code: result.error?.code, status: result.status, signal: result.signal}));
        function surface(file) {
          try {
            const stat = fs.statSync(file);
            let executable = false;
            try { fs.accessSync(file, fs.constants.X_OK); executable = true; } catch {}
            return {type: stat.isCharacterDevice() ? 'character-device' : stat.isDirectory() ? 'directory' : stat.isSocket() ? 'socket' : stat.isFile() ? 'file' : 'other',
              mode: (stat.mode & 0o777).toString(8), rdev: stat.rdev, executable};
          } catch (error) { return {error: error.code}; }
        }
        async function socketAttempt(target) {
          return new Promise(resolve => {
            const socket = new (require('node:net').Socket)();
            let finished = false;
            function finish(outcome) { if (finished) return; finished = true; socket.destroy(); resolve(outcome); }
            socket.once('connect', () => finish({connected: true}));
            socket.once('error', error => finish({connected: false, code: error.code}));
            socket.setTimeout(1500, () => finish({connected: false, code: 'timeout'}));
            try { socket.connect(target); } catch (error) { finish({connected: false, code: error.code}); }
          });
        }
        const inheritedSocket = process.env.WSL_INTEROP;
        observations.push({init: surface('/init'), bridgeDirectory: surface('/run/WSL'),
          inheritedSocket: inheritedSocket ? surface(inheritedSocket) : {configured: false},
          nonexistentSocketAttempt: await socketAttempt(${JSON.stringify(path.join(fixture, "never-created.sock"))}),
          inheritedSocketAttempt: inheritedSocket ? await socketAttempt(inheritedSocket) : {configured: false}});
      `);
    }
  }
  console.log(JSON.stringify({ summary: { passed: checks.filter((entry) => entry.ok).length, failed: checks.filter((entry) => !entry.ok).length, errors: errors.length },
    notTested: ["approval/direct-tool integration", "future-rule placeholder lifecycle", "mixed per-directory sensitivity", "Unicode and 8.3 aliases", "junction/reparse behavior", "concurrent host mutations", "network modes", ...(interopBaselinePassed ? ["other Windows interop routes"] : ["Windows executable confinement"])],
  }));
  process.exitCode = errors.length ? 2 : checks.some((entry) => !entry.ok) ? 1 : 0;
} finally {
  if (keep) console.log(`Retained disposable folder: ${fixture}`);
  else if (sameIdentity(identity(fixture), fixtureIdentity)) {
    rmSync(fixture, { recursive: true });
    console.log("Disposable folder removed.");
  } else {
    console.error(`Folder identity changed; refusing cleanup: ${fixture}`);
    process.exitCode = 2;
  }
}
