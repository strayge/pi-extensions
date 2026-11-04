import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { bindPath } from "./paths.ts";
import type { FilesystemSnapshot } from "./schema.ts";
import { prepareWindowsExecutor } from "./windows-executor.ts";
import { prepareWindowsComparison, windowsSystemDirectory } from "./windows-platform.ts";
import { windowsRuntimeResources } from "./windows-resources.ts";
import { discoverWindowsShell, WindowsRuntime } from "./windows-runtime.ts";

const native = { skip: process.platform !== "win32" || process.env.PI_NATIVE_WINDOWS_MXC !== "1", timeout: 180000 };
async function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), "native-shell-resources-")); const project = path.join(root, "spaced Кириллица project"); mkdirSync(project);
  const readonly = path.join(project, "readonly"); mkdirSync(readonly); const protectedFile = path.join(readonly, "protected.txt"); writeFileSync(protectedFile, "unchanged");
  const binding = bindPath(project);
  const snapshot: FilesystemSnapshot = { revision: 0, root: { family: "test", binding }, mode: "project", profile: { kind: "scoped", grants: [{ binding, scope: "tree", access: "write" }, { binding: bindPath(tmpdir()), scope: "tree", access: "write" }] },
    rules: [{ id: "readonly", definition: "readonly", path: readonly, scope: "tree", write: "deny", binding: bindPath(readonly) }], grants: [], exceptions: [] };
  try {
    const prepared = await prepareWindowsExecutor({ project: binding, agentDir: root });
    return { root, project, binding, snapshot, protectedFile, runtime: new WindowsRuntime(prepared), close: async () => { try { await prepared.close(); } finally { rmSync(root, { recursive: true, force: true }); } } };
  } catch (error) { rmSync(root, { recursive: true, force: true }); throw error; }
}

test("Windows facilities include selected runtime metadata but not neighboring application configuration", { skip: process.platform !== "win32" }, () => {
  prepareWindowsComparison(); const root = mkdtempSync(path.join(tmpdir(), "runtime-facilities-"));
  try {
    for (const name of ["runtime.exe", "library.dll", "runtime.exe.config", "runtime.deps.json", "runtime.runtimeconfig.json", "unrelated.config", "private.runtimeconfig.json"]) writeFileSync(path.join(root, name), "synthetic; never executed");
    const resources = windowsRuntimeResources(path.join(root, "runtime.exe")); const paths = resources.map((resource) => resource.binding.canonical);
    for (const name of ["runtime.exe", "library.dll", "runtime.exe.config", "runtime.deps.json", "runtime.runtimeconfig.json"]) assert.ok(paths.includes(path.join(root, name)));
    for (const name of ["unrelated.config", "private.runtimeconfig.json"]) assert.ok(!paths.includes(path.join(root, name)));
    assert.ok(resources.every((resource) => resource.scope === "file" && resource.access === "read"));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("native PowerShell facilities permit providers and relative paths without granting installation roots", native, async (t) => {
  const f = await fixture();
  try {
    const interpreters = [path.join(windowsSystemDirectory(), "WindowsPowerShell", "v1.0", "powershell.exe"), ...(process.env.ProgramFiles ? [path.join(process.env.ProgramFiles, "PowerShell", "7", "pwsh.exe")] : [])];
    for (const executable of interpreters) {
      if (!existsSync(executable)) { t.diagnostic(`Optional interpreter unavailable: ${executable}`); continue; }
      const shell = discoverWindowsShell("powershell", f.binding, { shellPath: executable }); let output = "";
      const code = `$ErrorActionPreference='Stop'; Set-Content -LiteralPath './данные file.txt' -Value 'native-provider' -NoNewline; [Console]::WriteLine('DATA:'+(Get-Content -LiteralPath './данные file.txt' -Raw)); [Console]::WriteLine('PWD:'+$PWD.Path); try {Set-Content -LiteralPath './readonly/protected.txt' -Value 'changed' -ErrorAction Stop; [Console]::WriteLine('ESCAPED')} catch {[Console]::WriteLine('DENIED')}`;
      const result = await f.runtime.operations(f.snapshot, shell, () => false, () => {}).exec(code, f.project, { onData: (chunk) => { output += chunk; }, timeout: 30 });
      assert.equal(result.exitCode, 0, output); assert.match(output, /DATA:native-provider/); assert.ok(output.includes(`PWD:${f.project}`), output); assert.match(output, /DENIED/); assert.doesNotMatch(output, /ESCAPED/);
      assert.equal(readFileSync(f.protectedFile, "utf8"), "unchanged");
    }
    const resources = [...f.runtime.bootstrapResources.values()].flat(); assert.ok(resources.length > 0); assert.ok(resources.every((resource) => resource.scope === "file" && resource.access === "read"));
  } finally { await f.close(); }
});

test("native developer commands retain project I/O with explicitly readable toolchains", native, async (t) => {
  const f = await fixture();
  const literal = (value: string) => `'${value.replaceAll("'", "''")}'`;
  const execute = async (command: string) => {
    const shell = discoverWindowsShell("powershell", f.binding);
    let output = ""; const result = await f.runtime.operations(f.snapshot, shell, () => false, () => {}).exec(`$ErrorActionPreference='Stop'; ${command}`, f.project, { onData: (chunk) => { output += chunk; }, timeout: 45 });
    assert.equal(result.exitCode, 0, output); return output;
  };
  const toolchain = (directory: string) => { f.snapshot.profile.grants.push({ binding: bindPath(realpathSync(directory)), scope: "tree", access: "read" }); };
  try {
    await t.test("native Node reads and writes relative to the project", async () => {
      toolchain(path.dirname(process.execPath));
      const script = "const fs=require('node:fs');fs.writeFileSync('node-output.txt','native-node');console.log(fs.readFileSync('node-output.txt','utf8'))";
      assert.match(await execute(`& ${literal(realpathSync(process.execPath))} -e ${literal(script)}; if($LASTEXITCODE -ne 0){throw 'Node failed'}`), /native-node/);
      assert.equal(readFileSync(path.join(f.project, "node-output.txt"), "utf8"), "native-node");
    });
    const scoop = process.env.SCOOP ?? path.join(homedir(), "scoop");
    const gitRoot = [process.env.ProgramFiles && path.join(process.env.ProgramFiles, "Git"), process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, "Programs", "Git"), path.join(scoop, "apps", "git", "current")].find((root) => root && existsSync(path.join(root, "cmd", "git.exe")));
    await t.test("native Git status, commit and worktree operations do not use personal configuration", { skip: gitRoot ? false : "No supported native Git installation found" }, async () => {
      toolchain(gitRoot!); const git = realpathSync(path.join(gitRoot!, "cmd", "git.exe"));
      const output = await execute(`$env:GIT_CONFIG_NOSYSTEM='1'; $env:GIT_CONFIG_GLOBAL=Join-Path $PWD.Path 'fixture-gitconfig'; Set-Content -LiteralPath $env:GIT_CONFIG_GLOBAL -Value ''; function Invoke-Git { & ${literal(git)} @args; if($LASTEXITCODE -ne 0){throw 'Git failed'} }; Invoke-Git init --quiet; Set-Content -LiteralPath './source.txt' -Value 'native-git'; Invoke-Git add -- source.txt; Invoke-Git -c user.name=NativeFixture -c user.email=native@example.invalid commit --quiet -m initial; if(Invoke-Git status --porcelain --untracked-files=no){throw 'Unexpected tracked changes'}; $worktree=Join-Path $PWD.Path 'linked-worktree'; Invoke-Git worktree add --quiet --detach $worktree HEAD; if(!(Test-Path (Join-Path $worktree 'source.txt'))){throw 'Worktree missing source'}; Invoke-Git worktree remove --force $worktree; Invoke-Git worktree list --porcelain; [Console]::WriteLine('GIT-OK')`);
      assert.match(output, /GIT-OK/); assert.equal(existsSync(path.join(f.project, "linked-worktree")), false);
    });
    const localPython = process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, "Python");
    const managedPython = localPython && existsSync(localPython) ? readdirSync(localPython).filter((name) => /^pythoncore-\d+\.\d+-64$/.test(name)).map((name) => path.join(localPython, name)) : [];
    const pythonRoot = [path.join(scoop, "apps", "python", "current"), ...managedPython, process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, "Programs", "Python", "Python313"), "C:\\Python313"].find((root) => root && existsSync(path.join(root, "python.exe")));
    await t.test("native Python reads and writes relative to the project", { skip: pythonRoot ? false : "No supported native Python installation found" }, async () => {
      toolchain(pythonRoot!); const python = realpathSync(path.join(pythonRoot!, "python.exe"));
      const script = "from pathlib import Path; p=Path('python-output.txt'); p.write_text('native-python'); print(p.read_text())";
      assert.match(await execute(`$env:PYTHONNOUSERSITE='1'; & ${literal(python)} -c ${literal(script)}; if($LASTEXITCODE -ne 0){throw 'Python failed'}`), /native-python/);
      assert.equal(readFileSync(path.join(f.project, "python-output.txt"), "utf8"), "native-python");
    });
  } finally { await f.close(); }
});

test("required native Git Bash compatibility gate retains project I/O, cwd and readonly protections", native, async () => {
  const f = await fixture();
  try {
    const bash = discoverWindowsShell("bash", f.binding); let output = "";
    const result = await f.runtime.operations(f.snapshot, bash, () => false, () => {}).exec("printf 'bash-value\\n' > bash.txt; read -r value < bash.txt; printf 'DATA:%s\\nPWD:%s\\n' \"$value\" \"$PWD\"; if printf 'bad' > readonly/protected.txt; then printf 'ESCAPED'; else printf 'DENIED'; fi", f.project, { onData: (chunk) => { output += chunk; }, timeout: 30 });
    assert.equal(result.exitCode, 0, output || "Git Bash could not initialize under MXC; see the documented compatibility gate"); assert.match(output, /DATA:bash-value/); assert.match(output, /PWD:.*spaced Кириллица project/); assert.match(output, /DENIED/); assert.doesNotMatch(output, /ESCAPED/);
    assert.equal(readFileSync(f.protectedFile, "utf8"), "unchanged");
    assert.ok(![...f.runtime.bootstrapResources.values()].flat().some((resource) => resource.binding.canonical === path.dirname(bash.executable.canonical)));
  } finally { await f.close(); }
});
