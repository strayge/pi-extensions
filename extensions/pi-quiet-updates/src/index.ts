/**
 * Collapses pi's bordered "Update Available" and "Package Updates Available"
 * startup banners into a single muted status line.
 *
 * pi offers no setting for these banners, and `PI_OFFLINE` would also freeze
 * the model catalog. Instead this replaces the two notification methods on
 * `InteractiveMode.prototype`. Extensions resolve `@earendil-works/pi-coding-agent`
 * to the running pi's own module, so the class patched here is the one driving
 * the TUI. The banners are emitted after async checks that finish well after
 * extensions load, so patching from the factory is early enough.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  DefaultPackageManager,
  type ExtensionAPI,
  InteractiveMode,
  VERSION,
} from "@earendil-works/pi-coding-agent";
import {
  formatUpdateLine,
  npmSpecName,
  type PendingUpdates,
  type VersionChange,
  versionLabel,
} from "./format.ts";

/** `showStatus` and `lastStatusText` are private in pi's published types, hence the structural view. */
interface PatchableMode {
  showStatus(message: string): void;
  lastStatusText?: { setPaddingX?(paddingX: number): void };
  showNewVersionNotification(release: { version: string }): void;
  showPackageUpdateNotification(packages: string[]): void;
}

type AsyncMethod = ((this: unknown, ...args: unknown[]) => Promise<unknown>) & {
  original?: AsyncMethod;
};

/**
 * Observes a private async method of pi without changing it: pi gets the
 * original result or error untouched, and a throwing observer is ignored.
 */
function tapAsyncMethod(
  proto: object,
  name: string,
  observe: (self: unknown, args: unknown[], result: unknown) => void,
) {
  const methods = proto as Record<string, AsyncMethod | undefined>;
  const current = methods[name];
  if (typeof current !== "function") return;
  // On /reload, wrap pi's method again rather than the previous wrapper.
  const original = current.original ?? current;
  const wrapper: AsyncMethod = async function (this: unknown, ...args) {
    const result = await original.apply(this, args);
    try {
      observe(this, args, result);
    } catch {}
    return result;
  };
  wrapper.original = original;
  methods[name] = wrapper;
}

function installedNpmVersion(installedPath: string): string | undefined {
  const { version } = JSON.parse(readFileSync(join(installedPath, "package.json"), "utf-8"));
  return typeof version === "string" ? version : undefined;
}

/**
 * pi's package check discards both versions it compares, so the banner only
 * gets names. Recording them as they pass through lets the line show the change.
 */
function recordNpmVersions(versions: Map<string, VersionChange>) {
  const entry = (name: string) => {
    const existing = versions.get(name);
    if (existing) return existing;
    const created: VersionChange = {};
    versions.set(name, created);
    return created;
  };
  const proto = DefaultPackageManager.prototype;
  tapAsyncMethod(proto, "getLatestNpmVersion", (_self, [spec], latest) => {
    if (typeof spec === "string" && typeof latest === "string") {
      entry(npmSpecName(spec)).latest = latest;
    }
  });
  tapAsyncMethod(proto, "npmHasAvailableUpdate", (_self, [source, installedPath], hasUpdate) => {
    const name = (source as { name?: unknown } | undefined)?.name;
    if (hasUpdate === true && typeof name === "string" && typeof installedPath === "string") {
      entry(name).installed = installedNpmVersion(installedPath);
    }
  });
}

export default function quietUpdates(_pi: ExtensionAPI) {
  const proto = InteractiveMode.prototype as unknown as PatchableMode;
  // If pi renames these internals, leave the stock banners alone rather than break startup.
  if (
    typeof proto.showStatus !== "function" ||
    typeof proto.showNewVersionNotification !== "function" ||
    typeof proto.showPackageUpdateNotification !== "function"
  ) {
    return;
  }

  const versions = new Map<string, VersionChange>();
  try {
    recordNpmVersions(versions);
  } catch {}

  const pending = new WeakMap<object, PendingUpdates>();
  const show = (mode: PatchableMode, update: PendingUpdates) => {
    const next = { ...pending.get(mode), ...update };
    pending.set(mode, next);
    // showStatus rewrites its previous line in place while it is still the last
    // transcript entry, so the second check usually extends the first line.
    mode.showStatus(formatUpdateLine(next));
    // Status lines are indented one column; this one sits flush left.
    mode.lastStatusText?.setPaddingX?.(0);
  };

  proto.showNewVersionNotification = function (this: PatchableMode, release) {
    show(this, { pi: versionLabel("pi", { installed: VERSION, latest: release.version }) });
  };
  proto.showPackageUpdateNotification = function (this: PatchableMode, packages) {
    show(this, { packages: packages.map((name) => versionLabel(name, versions.get(name))) });
  };
}
