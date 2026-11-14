import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { type ThinkingLevel, thinkingLevels } from "./store.ts";

export interface ModelAlias {
  name: string;
  provider: string;
  modelId: string;
  thinkingLevel?: ThinkingLevel;
}

const reservedCommands = new Set([
  "models",
  "settings",
  "model",
  "tree",
  "thinking",
  "scoped-models",
  "export",
  "import",
  "share",
  "bug",
  "copy",
  "name",
  "session",
  "changelog",
  "hotkeys",
  "fork",
  "clone",
  "trust",
  "login",
  "logout",
  "new",
  "compact",
  "resume",
  "reload",
  "quit",
]);

interface AliasConfig {
  aliases: ModelAlias[];
  errors: string[];
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function parseAliases(value: unknown): AliasConfig {
  const result: AliasConfig = { aliases: [], errors: [] };
  if (!isObject(value) || !isObject(value.aliases)) {
    result.errors.push('Expected an "aliases" object');
    return result;
  }
  for (const [name, target] of Object.entries(value.aliases)) {
    if (!/^[a-z][a-z0-9_-]*$/.test(name) || reservedCommands.has(name)) {
      result.errors.push(`Invalid or reserved alias name: ${name}`);
      continue;
    }
    if (!isObject(target) || typeof target.model !== "string") {
      result.errors.push(`Alias /${name}: expected a model in provider/model-id form`);
      continue;
    }
    const separator = target.model.indexOf("/");
    if (separator <= 0 || separator === target.model.length - 1 || /\s/.test(target.model)) {
      result.errors.push(`Alias /${name}: expected a model in provider/model-id form`);
      continue;
    }
    if (
      target.thinkingLevel !== undefined &&
      (typeof target.thinkingLevel !== "string" ||
        !thinkingLevels.has(target.thinkingLevel as ThinkingLevel))
    ) {
      result.errors.push(`Alias /${name}: invalid thinkingLevel`);
      continue;
    }
    result.aliases.push({
      name,
      provider: target.model.slice(0, separator),
      modelId: target.model.slice(separator + 1),
      thinkingLevel: target.thinkingLevel as ThinkingLevel | undefined,
    });
  }
  return result;
}

export function loadAliases(file = join(getAgentDir(), "pi-models.json")): AliasConfig {
  try {
    return parseAliases(JSON.parse(readFileSync(file, "utf8")));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { aliases: [], errors: [] };
    return { aliases: [], errors: [`Could not read ${file}: ${String(error)}`] };
  }
}
