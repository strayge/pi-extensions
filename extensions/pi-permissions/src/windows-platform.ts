import { spawnSync } from "node:child_process";
import { fstatSync, lstatSync, realpathSync } from "node:fs";
import path from "node:path";

const ADMIN_SIDS = new Set(["S-1-5-18", "S-1-5-32-544"]);
const verifiedVolumes = new Map<string, string>();
let comparison: Uint16Array | undefined;

const COMPARISON_SCRIPT = `
  $cmp=[StringComparer]::OrdinalIgnoreCase;
  $buckets=[Collections.Generic.Dictionary[int,object]]::new(); $table=[byte[]]::new(131072);
  for($i=0;$i -lt 65536;$i++){
    $value=[string][char]$i; $hash=$cmp.GetHashCode($value); $representative=$i;
    if($buckets.ContainsKey($hash)){
      $found=$false;
      foreach($candidate in @($buckets[$hash])){
        if($cmp.Equals($value,[string][char]$candidate)){$representative=[int]$candidate;$found=$true;break}
      };
      if(-not $found){$buckets[$hash]=@($buckets[$hash])+$i}
    }else{$buckets[$hash]=$i};
    $table[2*$i]=[byte]($representative -band 255); $table[2*$i+1]=[byte]($representative -shr 8)
  };
  @{table=[Convert]::ToBase64String($table)} | ConvertTo-Json -Compress
`;

/** Win32 aliases must not turn a checked name into a device, stream, or different leaf. */
export function assertWindowsPath(input: string): void {
  if (!/^[a-z]:[\\/]/i.test(input) || input.includes("\0") || Buffer.from(input, "utf8").toString("utf8") !== input || input.slice(2).includes(":"))
    throw new Error(`Only local drive paths are supported on Windows: ${input}`);
  for (const part of input.slice(3).split(/[\\/]/)) {
    if (part === "." || part === ".." || !part) continue;
    if (/[ .]$/.test(part) || (/[<>"|?*]/.test(part) || [...part].some((character) => character.charCodeAt(0) < 32)) || /^(?:con|prn|aux|nul|conin\$|conout\$|clock\$|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(part))
      throw new Error(`Unsupported Windows path component: ${input}`);
  }
}

/** Only the OS installation is a bootstrap trust anchor, never PATH or a project helper. */
export function windowsSystemDirectory(): string {
  // KnownDLLs are selected by the Windows loader, unlike user-controlled SystemRoot or PATH.
  const report = process.report.getReport() as { sharedObjects?: unknown };
  const modules = Array.isArray(report.sharedObjects) ? report.sharedObjects.filter((file): file is string => typeof file === "string") : [];
  const kernel = modules.filter((file) => path.basename(file).toLowerCase() === "kernel32.dll");
  const ntdll = modules.filter((file) => path.basename(file).toLowerCase() === "ntdll.dll");
  if (kernel.length !== 1 || ntdll.length !== 1 || path.dirname(kernel[0]!).toLowerCase() !== path.dirname(ntdll[0]!).toLowerCase())
    throw new Error("Cannot locate the loaded Windows KnownDLL directory");
  const directory = path.dirname(kernel[0]!);
  const root = path.dirname(directory);
  assertWindowsPath(directory);
  if (path.basename(directory).toLowerCase() !== "system32") throw new Error("Unsupported Windows system directory");
  for (const file of [root, directory, path.join(directory, "WindowsPowerShell"), path.join(directory, "WindowsPowerShell", "v1.0")]) {
    const st = lstatSync(file);
    if (st.isSymbolicLink() || !st.isDirectory() || realpathSync.native(file).toLowerCase() !== file.toLowerCase())
      throw new Error(`Redirected Windows security helper ancestry: ${file}`);
  }
  return directory;
}

/** Baseline reads enumerate already loaded OS libraries, not the enclosing Windows installation. */
export function windowsSystemResources(): string[] {
  const system = realpathSync.native(windowsSystemDirectory());
  const report = process.report.getReport() as { sharedObjects?: unknown };
  if (!Array.isArray(report.sharedObjects)) throw new Error("Cannot enumerate loaded Windows libraries");
  return [...new Set(report.sharedObjects.filter((file): file is string => typeof file === "string").map((file) => realpathSync.native(file))
    .filter((file) => file.startsWith(system + path.sep)))];
}

/** Controlled input and module paths prevent PowerShell profiles or helper shadowing on the host. */
function securityHelper(body: string, input: unknown): unknown {
  if (process.platform !== "win32") throw new Error("Windows security helper is unavailable on this host");
  const system = windowsSystemDirectory();
  const executable = path.join(system, "WindowsPowerShell", "v1.0", "powershell.exe");
  if (!lstatSync(executable).isFile() || lstatSync(executable).isSymbolicLink()) throw new Error("Unsafe Windows security helper");
  const script = `$ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue'; [Console]::InputEncoding=New-Object Text.UTF8Encoding($false); [Console]::OutputEncoding=New-Object Text.UTF8Encoding($false); $inputData=ConvertFrom-Json ([Console]::In.ReadToEnd()); ${body}`;
  const result = spawnSync(executable, ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], {
    input: JSON.stringify(input), encoding: "utf8", timeout: 10000, maxBuffer: 1024 * 1024, windowsHide: true,
    cwd: system,
    env: { SystemRoot: path.dirname(system), WINDIR: path.dirname(system), PATH: system, PSModulePath: path.join(system, "WindowsPowerShell", "v1.0", "Modules") },
  });
  if (result.error || result.status !== 0) throw new Error(`Windows authority verification failed: ${result.error?.message ?? result.stderr.trim()}`);
  try { return JSON.parse(result.stdout.replace(/^\uFEFF/, "")); }
  catch { throw new Error("Windows security helper returned invalid data"); }
}

/** Hash buckets narrow comparisons; Equals, not hash equality or Unicode guesses, defines every class. */
export function prepareWindowsComparison(refresh = false): void {
  if (process.platform !== "win32" || (comparison && !refresh)) return;
  const result = securityHelper(COMPARISON_SCRIPT, {}) as { table?: unknown };
  if (typeof result?.table !== "string" || !/^[A-Za-z0-9+/]{174763}=$/.test(result.table))
    throw new Error("Invalid Windows comparison data");
  const bytes = Buffer.from(result.table, "base64");
  if (bytes.length !== 131072) throw new Error("Invalid Windows comparison size");
  const next = new Uint16Array(65536);
  for (let i = 0; i < next.length; i++) next[i] = bytes.readUInt16LE(2 * i);
  for (let i = 0; i < next.length; i++) {
    if (next[i]! > i || next[next[i]!] !== next[i] || (i >= 0xd800 && i <= 0xdfff && next[i] !== i))
      throw new Error("Invalid Windows comparison classes");
  }
  for (const value of "\\/:. \0")
    if (next[value.charCodeAt(0)] !== value.charCodeAt(0)) throw new Error("Windows comparison changed a path separator");
  if (comparison && next.some((value, i) => value !== comparison![i]))
    throw new Error("Windows comparison semantics changed; restart Pi before preparing another policy");
  comparison = next;
}

/** Only permission boundaries use these keys; native object identities and stored names never do. */
export function windowsPermissionKey(value: string): string {
  if (!comparison) throw new Error("Windows permission comparison is not prepared");
  let result = "";
  for (let i = 0; i < value.length; i++) result += String.fromCharCode(comparison[value.charCodeAt(i)]!);
  return result;
}

const SECURITY_SCRIPT = `
  $assembly=[AppDomain]::CurrentDomain.DefineDynamicAssembly([Reflection.AssemblyName]::new('PiAuthority'),[Reflection.Emit.AssemblyBuilderAccess]::Run);
  $module=$assembly.DefineDynamicModule('PiAuthority'); $type=$module.DefineType('Native','Public,Abstract,Sealed');
  function Declare($name,$dll,$result,[Type[]]$parameters){
    $method=$type.DefinePInvokeMethod($name,$dll,'Public,Static,PinvokeImpl',[Reflection.CallingConventions]::Standard,$result,$parameters,[Runtime.InteropServices.CallingConvention]::Winapi,[Runtime.InteropServices.CharSet]::Unicode);
    $method.SetImplementationFlags([Reflection.MethodImplAttributes]::PreserveSig)
  };
  Declare 'CreateFileW' 'kernel32.dll' ([IntPtr]) @([string],[uint32],[uint32],[IntPtr],[uint32],[uint32],[IntPtr]);
  Declare 'GetFileInformationByHandle' 'kernel32.dll' ([bool]) @([IntPtr],[IntPtr]);
  Declare 'GetSecurityInfo' 'advapi32.dll' ([uint32]) @([IntPtr],[uint32],[uint32],[IntPtr].MakeByRefType(),[IntPtr].MakeByRefType(),[IntPtr].MakeByRefType(),[IntPtr].MakeByRefType(),[IntPtr].MakeByRefType());
  Declare 'GetSecurityDescriptorLength' 'advapi32.dll' ([uint32]) @([IntPtr]);
  Declare 'LocalFree' 'kernel32.dll' ([IntPtr]) @([IntPtr]);
  Declare 'CloseHandle' 'kernel32.dll' ([bool]) @([IntPtr]);
  $native=$type.CreateType(); $user=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value;
  function OpenAuthority($p){
    $handle=$native::CreateFileW($p,0x20080,3,[IntPtr]::Zero,3,0x02200000,[IntPtr]::Zero);
    if($handle.ToInt64() -eq -1){throw ('Cannot open Windows authority metadata: '+$p)};
    return $handle
  };
  function InspectAuthority($handle){
    $info=[Runtime.InteropServices.Marshal]::AllocHGlobal(52); $sd=[IntPtr]::Zero;
    try{
      if(-not $native::GetFileInformationByHandle($handle,$info)){throw 'Cannot identify Windows authority handle'};
      $bytes=[byte[]]::new(52); [Runtime.InteropServices.Marshal]::Copy($info,$bytes,0,52);
      $owner=[IntPtr]::Zero;$group=[IntPtr]::Zero;$dacl=[IntPtr]::Zero;$sacl=[IntPtr]::Zero;
      $status=$native::GetSecurityInfo($handle,1,5,[ref]$owner,[ref]$group,[ref]$dacl,[ref]$sacl,[ref]$sd);
      if($status -ne 0 -or $sd -eq [IntPtr]::Zero){throw ('Cannot read Windows authority security: '+$status)};
      $size=$native::GetSecurityDescriptorLength($sd); if($size -lt 20 -or $size -gt 65536){throw 'Invalid authority security descriptor'};
      $security=[byte[]]::new($size); [Runtime.InteropServices.Marshal]::Copy($sd,$security,0,$size);
      $raw=[Security.AccessControl.RawSecurityDescriptor]::new($security,0);
      if($null -eq $raw.DiscretionaryAcl){throw 'Authority has an unrestricted DACL'};
      $attributes=[BitConverter]::ToUInt32($bytes,0); $directory=($attributes -band 16) -ne 0;
      $acl=if($directory){[Security.AccessControl.DirectorySecurity]::new()}else{[Security.AccessControl.FileSecurity]::new()};
      $acl.SetSecurityDescriptorBinaryForm($security);
      $rules=@($acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier]) | ForEach-Object {
        @{sid=$_.IdentityReference.Value;rights=[int]$_.FileSystemRights;allow=($_.AccessControlType -eq 'Allow');inheritOnly=(($_.PropagationFlags -band [Security.AccessControl.PropagationFlags]::InheritOnly) -ne 0)}
      });
      if($rules.Count -ne $raw.DiscretionaryAcl.Count){throw 'Unrecognized authority access rule'};
      $ino=([bigint][BitConverter]::ToUInt32($bytes,44)*4294967296)+[BitConverter]::ToUInt32($bytes,48);
      $birth=([bigint][BitConverter]::ToInt64($bytes,4)-116444736000000000)*100;
      return @{user=$user;owner=$raw.Owner.Value;rules=$rules;reparse=(($attributes -band 1024) -ne 0);directory=$directory;dev=([BitConverter]::ToUInt32($bytes,28)).ToString();ino=$ino.ToString();birthtimeNs=$birth.ToString()}
    }finally{[Runtime.InteropServices.Marshal]::FreeHGlobal($info);if($sd -ne [IntPtr]::Zero){[void]$native::LocalFree($sd)}}
  };
  $handles=[Collections.Generic.List[IntPtr]]::new();
  try{
    $p=[string]$inputData; $parents=[Collections.Generic.List[string]]::new();$current=[IO.Path]::GetDirectoryName($p);
    while($current){$parents.Insert(0,$current);$current=[IO.Path]::GetDirectoryName($current)};
    foreach($parent in $parents){
      $handle=OpenAuthority $parent;$handles.Add($handle);$ancestor=InspectAuthority $handle;
      $privileged=@($user,'S-1-5-18','S-1-5-32-544','S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464');
      if($ancestor.reparse -or -not $ancestor.directory -or $ancestor.owner -notin $privileged){throw ('Unsafe Windows authority ancestry: '+$parent)};
      foreach($rule in $ancestor.rules){
        if($rule.allow -and -not $rule.inheritOnly -and $rule.sid -notin $privileged -and ($rule.rights -band 0x500d0150) -ne 0){throw ('Unsafe Windows authority ancestor DACL: '+$parent)}
      }
    };
    $handle=OpenAuthority $p;$handles.Add($handle);InspectAuthority $handle | ConvertTo-Json -Depth 5 -Compress
  }finally{for($i=$handles.Count-1;$i -ge 0;$i--){[void]$native::CloseHandle($handles[$i])}}
`;

interface AccessRule { sid: string; rights: number; allow: boolean; inheritOnly: boolean }
export interface WindowsSecurity { user: string; owner: string; rules: AccessRule[]; reparse: boolean; directory: boolean; dev?: string; ino?: string; birthtimeNs?: string }

/** Reject extra readers as well as writers; saved authority contains private path and session data. */
export function validateWindowsSecurity(info: WindowsSecurity, directory: boolean): void {
  if (info.reparse || info.directory !== directory || (info.owner !== info.user && !ADMIN_SIDS.has(info.owner)))
    throw new Error("Windows authority must be user/administrator-owned and non-reparse");
  for (const rule of info.rules) {
    if (!rule.allow || rule.sid === info.user || ADMIN_SIDS.has(rule.sid)) continue;
    if (rule.rights !== 0)
      throw new Error(`Unsafe Windows authority DACL grants access to ${rule.sid}`);
  }
  if (!info.rules.some((rule) => rule.allow && !rule.inheritOnly && rule.sid === info.user))
    throw new Error("Windows authority has no explicit user access");
}

function windowsSecurity(file: string, directory: boolean, descriptor?: number): WindowsSecurity {
  assertWindowsPath(file);
  const entry = lstatSync(file, { bigint: true });
  const before = descriptor === undefined ? entry : fstatSync(descriptor, { bigint: true });
  if (entry.isSymbolicLink() || (directory ? !before.isDirectory() : !before.isFile())) throw new Error(`Unsafe Windows authority type: ${file}`);
  const info = securityHelper(SECURITY_SCRIPT, file) as WindowsSecurity;
  const after = lstatSync(file, { bigint: true });
  if (info.dev !== String(before.dev) || info.ino !== String(before.ino) || info.birthtimeNs !== String(before.birthtimeNs) ||
    before.dev !== after.dev || before.ino !== after.ino || before.birthtimeNs !== after.birthtimeNs)
    throw new Error(`Windows authority changed during verification: ${file}`);
  return info;
}

export function assertWindowsPrivate(file: string, directory: boolean, descriptor?: number): void {
  validateWindowsSecurity(windowsSecurity(file, directory, descriptor), directory);
}

/** Installed code may be publicly readable, but neither it nor its ancestry may be externally mutable. */
export function assertWindowsTrustedFile(file: string, descriptor?: number): void {
  const info = windowsSecurity(file, false, descriptor);
  const privileged = new Set([info.user, ...ADMIN_SIDS, "S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464"]);
  if (info.reparse || info.directory || !privileged.has(info.owner) || info.rules.some((rule) =>
    rule.allow && !rule.inheritOnly && !privileged.has(rule.sid) && (rule.rights & 0x500d0156) !== 0))
    throw new Error(`Installed runtime must be protected from unrelated-user mutation: ${file}`);
}

/** The ACL overload protects new directories without recursively changing an existing user tree. */
export function createWindowsPrivateDirectory(directory: string): void {
  assertWindowsPath(directory);
  securityHelper(`
    $p=[string]$inputData;
    if(-not [IO.Directory]::Exists([IO.Path]::GetDirectoryName($p))){throw 'Authority parent must already exist'};
    $user=[Security.Principal.WindowsIdentity]::GetCurrent().User;
    $acl=New-Object Security.AccessControl.DirectorySecurity;
    $acl.SetOwner($user); $acl.SetAccessRuleProtection($true,$false);
    foreach($sid in @($user.Value,'S-1-5-18','S-1-5-32-544')){
      $rule=New-Object Security.AccessControl.FileSystemAccessRule ([Security.Principal.SecurityIdentifier]$sid),'FullControl','ContainerInherit,ObjectInherit','None','Allow';
      $acl.AddAccessRule($rule)
    };
    [void][IO.Directory]::CreateDirectory($p,$acl); 'true'
  `, directory);
  assertWindowsPrivate(directory, true);
}

/** Volume identity may be reused; directory case flags are irrelevant to case-family authority. */
export function assertWindowsSemantics(directory: string): void {
  assertWindowsPath(directory);
  const root = path.parse(directory).root;
  const volume = lstatSync(root, { bigint: true });
  const target = lstatSync(directory, { bigint: true });
  if (!volume.dev || !volume.ino || volume.birthtimeNs <= 0n || target.dev !== volume.dev)
    throw new Error(`Unverified Windows volume or mount: ${directory}`);
  for (let current = directory; ; current = path.dirname(current)) {
    if (lstatSync(current).isSymbolicLink()) throw new Error(`Unresolved Windows volume alias: ${current}`);
    if (current === root) break;
  }
  const stamp = `${volume.dev}:${volume.ino}:${volume.birthtimeNs}`;
  if (verifiedVolumes.get(root) === stamp) return;
  const result = securityHelper(`
    $drive=[IO.DriveInfo]::new([string]$inputData);
    if($drive.DriveType -ne [IO.DriveType]::Fixed -or $drive.DriveFormat -ne 'NTFS'){throw 'Only validated local NTFS volumes are supported'};
    'true'
  `, root);
  const after = lstatSync(root, { bigint: true });
  if (result !== true || `${after.dev}:${after.ino}:${after.birthtimeNs}` !== stamp)
    throw new Error("Windows volume changed during verification");
  verifiedVolumes.set(root, stamp);
}
