import { parse } from "@babel/parser";
import type { ModelLike } from "./sort.ts";

export interface GoAllowance {
  id: string;
  name: string;
  allowance: number | null;
  requests: number | null;
  limitedTime?: boolean;
}

/** Null preserves the source's unlimited sentinel through the JSON cache. */
export function validateGoAllowances(value: unknown): GoAllowance[] {
  if (!Array.isArray(value) || !value.length) throw new Error("Empty OpenCode Go catalog");
  const ids = new Set<string>();
  return value.map((entry: unknown) => {
    if (!entry || typeof entry !== "object") throw new Error("Invalid OpenCode Go model");
    const model = entry as Record<string, unknown>;
    if (
      typeof model.id !== "string" ||
      !model.id.trim() ||
      ids.has(model.id) ||
      typeof model.name !== "string" ||
      !model.name.trim()
    ) {
      throw new Error("Invalid or duplicate OpenCode Go identity");
    }
    for (const key of ["allowance", "requests"] as const) {
      const number = model[key];
      if (
        number !== null &&
        (typeof number !== "number" || !Number.isFinite(number) || number <= 0)
      ) {
        throw new Error(`Invalid OpenCode Go ${key}`);
      }
    }
    if ((model.allowance === null) !== (model.requests === null)) {
      throw new Error("Inconsistent OpenCode Go unlimited allowance");
    }
    if (model.limitedTime !== undefined && typeof model.limitedTime !== "boolean") {
      throw new Error("Invalid OpenCode Go limited-time flag");
    }
    ids.add(model.id);
    return {
      id: model.id,
      name: model.name,
      allowance: model.allowance as number | null,
      requests: model.requests as number | null,
      ...(model.limitedTime === undefined ? {} : { limitedTime: model.limitedTime }),
    };
  });
}

/** Only literal catalog fields are trusted; downloaded TypeScript is never executed. */
export function parseGoAllowances(source: string): GoAllowance[] {
  if (source.length > 256 * 1024) throw new Error("OpenCode Go catalog is too large");
  const ast = parse(source, { sourceType: "module", plugins: ["typescript"] });
  const declarations = ast.program.body.flatMap((statement) => {
    const declaration =
      statement.type === "ExportNamedDeclaration" ? statement.declaration : statement;
    return declaration?.type === "VariableDeclaration" ? declaration.declarations : [];
  });
  const catalogs = declarations.filter(
    (declaration) => declaration.id.type === "Identifier" && declaration.id.name === "goModels",
  );
  if (catalogs.length !== 1) throw new Error("Missing OpenCode Go catalog");
  let array = catalogs[0]?.init;
  if (
    array?.type === "CallExpression" &&
    array.callee.type === "MemberExpression" &&
    !array.callee.computed &&
    array.callee.property.type === "Identifier" &&
    array.callee.property.name === "sort" &&
    array.callee.object.type === "ArrayExpression"
  ) {
    array = array.callee.object;
  }
  if (array?.type !== "ArrayExpression") throw new Error("Unsupported OpenCode Go catalog shape");
  const entries = array.elements.map((row) => {
    if (row?.type !== "ObjectExpression") throw new Error("Nonliteral OpenCode Go model");
    const fields = row.properties.map((property) => {
      if (
        property.type !== "ObjectProperty" ||
        property.computed ||
        property.shorthand ||
        (property.key.type !== "Identifier" && property.key.type !== "StringLiteral")
      ) {
        throw new Error("Nonliteral OpenCode Go property");
      }
      const key = property.key.type === "Identifier" ? property.key.name : property.key.value;
      return [key, property.value] as const;
    });
    const properties = new Map(fields);
    if (properties.size !== fields.length) throw new Error("Duplicate OpenCode Go property");
    const literal = (key: string) => {
      const node = properties.get(key);
      if (
        node?.type === "StringLiteral" ||
        node?.type === "NumericLiteral" ||
        node?.type === "BooleanLiteral"
      ) {
        return node.value;
      }
      if (node?.type === "Identifier" && node.name === "Infinity") return null;
      throw new Error(`Nonliteral OpenCode Go ${key}`);
    };
    return {
      id: literal("id"),
      name: literal("name"),
      allowance: literal("allowance"),
      requests: literal("requests"),
      ...(properties.has("limitedTime") ? { limitedTime: literal("limitedTime") } : {}),
    };
  });
  return validateGoAllowances(entries);
}

const normalizeName = (name: string) =>
  name
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\s_-]+/g, "");
const amounts = new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 });
const counts = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });

/** Aliases need an unambiguous name match; version dots and model qualifiers stay significant. */
export function goAnnotations(
  models: readonly ModelLike[],
  catalog: readonly GoAllowance[],
  stale = false,
): Record<string, string> {
  const annotations: Record<string, string> = {};
  const goModels = models.filter((model) => model.provider === "opencode-go");
  for (const model of goModels) {
    let entry = catalog.find((candidate) => candidate.id === model.id);
    if (!entry && model.name) {
      const name = normalizeName(model.name);
      const candidates = catalog.filter((candidate) => normalizeName(candidate.name) === name);
      const targets = goModels.filter(
        (candidate) => candidate.name && normalizeName(candidate.name) === name,
      );
      if (candidates.length === 1 && targets.length === 1) entry = candidates[0];
    }
    if (!entry) continue;
    // The provider's five-hour allowance is 20% of monthly usage, not five hours of calendar time.
    const text =
      entry.allowance === null
        ? `Unlimited${entry.limitedTime ? " (limited time)" : ""}`
        : `$${amounts.format(entry.allowance)}/mo · ~${counts.format((entry.requests ?? 0) * 5)} req/mo`;
    annotations[`${model.provider}/${model.id}`] = `${text}${stale ? " [stale]" : ""}`;
  }
  return annotations;
}
