import { existsSync, lstatSync, readdirSync } from "node:fs";
import path from "node:path";
import { assertBinding, bindPath } from "./paths.ts";
import type { ResourceGrant } from "./schema.ts";
import { assertWindowsTrustedFile, windowsPermissionKey, windowsSystemResources } from "./windows-platform.ts";
import type { WindowsShell } from "./windows-runtime.ts";

/** Execution facilities are exact regular files, never a grant to their enclosing installation. */
export function windowsRuntimeResources(executable: string, additional: string[] = []): ResourceGrant[] {
  const selected = bindPath(executable); assertWindowsTrustedFile(selected.canonical); assertBinding(selected);
  const files = new Set([selected.canonical, ...windowsSystemResources(), ...additional]);
  const directory = path.dirname(selected.canonical);
  const executableName = path.basename(selected.canonical); const stem = path.basename(selected.canonical, path.extname(selected.canonical));
  const metadata = new Set([`${executableName}.config`, `${stem}.deps.json`, `${stem}.runtimeconfig.json`].map(windowsPermissionKey));
  for (const entry of readdirSync(directory, { withFileTypes: true }))
    if (entry.isFile() && (/\.(dll|ps1xml)$/i.test(entry.name) || metadata.has(windowsPermissionKey(entry.name)))) files.add(path.join(directory, entry.name));
  if (files.size > 2048) throw new Error("Too many Windows execution resources; narrow the selected installation");
  return [...files].map((file) => {
    const binding = bindPath(file);
    if (binding.missing.length || binding.identity.type !== "file" || binding.canonical !== binding.lexical || lstatSync(file).isSymbolicLink()) throw new Error(`Redirected or missing Windows execution resource: ${file}`);
    return { binding, scope: "file", access: "read", runtime: true };
  });
}

/** Stock provider manifests and MSYS path maps do not require reading user profiles or startup scripts. */
export function windowsShellResources(shell: WindowsShell): ResourceGrant[] {
  assertBinding(shell.executable);
  const directory = path.dirname(shell.executable.canonical); const files: string[] = [];
  if (shell.args.at(-1) === "-Command") {
    for (const module of ["Microsoft.PowerShell.Management", "Microsoft.PowerShell.Utility", "Microsoft.PowerShell.Security"]) {
      const root = path.join(directory, "Modules", module);
      if (!existsSync(root)) continue;
      const binding = bindPath(root);
      if (binding.canonical !== binding.lexical || binding.identity.type !== "directory") throw new Error(`Redirected PowerShell module: ${root}`);
      for (const entry of readdirSync(root, { withFileTypes: true }))
        if (entry.isFile() && /\.(psd1|psm1|dll|ps1xml)$/i.test(entry.name)) files.push(path.join(root, entry.name));
      assertBinding(binding);
    }
  } else {
    const prefix = path.dirname(path.dirname(directory));
    for (const name of ["fstab", "nsswitch.conf", "passwd", "group"]) {
      const file = path.join(prefix, "etc", name); if (existsSync(file)) files.push(file);
    }
  }
  return windowsRuntimeResources(shell.executable.canonical, files);
}
