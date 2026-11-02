import { readFileSync } from "node:fs";
import { defaultShortcut } from "./default-shortcut.ts";
import { normalizeShortcut } from "./shortcut-core.ts";
import { legacySettingsPath, settingsPath } from "./settings-path.ts";

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Read only the setting Pi needs while synchronously registering the extension. */
export function readShortcutForRegistration(): string {
  for (const path of [settingsPath(), legacySettingsPath()]) {
    try {
      const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
      if (!isObject(parsed) || parsed.version !== 1 || typeof parsed.shortcut !== "string") {
        return defaultShortcut();
      }
      return normalizeShortcut(parsed.shortcut) ?? defaultShortcut();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      return defaultShortcut();
    }
  }
  return defaultShortcut();
}
