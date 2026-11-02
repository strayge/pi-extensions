export type CorrectionDictionary = Record<string, string>;

/** Reject ambiguous rules before saving, rather than silently overwriting a correction. */
function normalizeEntries(entries: readonly (readonly [string, string])[]): CorrectionDictionary {
  const normalized = new Map<string, string>();
  for (const [source, replacement] of entries) {
    const from = source.trim().toLowerCase();
    const to = replacement.trim();
    if (!from || !to || /[\r\n=]/.test(from) || /[\r\n]/.test(to)) {
      throw new Error("Each correction needs non-empty source = replacement text on one line.");
    }
    if (normalized.has(from)) throw new Error(`Duplicate correction source: ${from}`);
    normalized.set(from, to);
  }
  return Object.fromEntries(normalized);
}

/** Stored rules and editor input share the same validation and canonical source spelling. */
export function normalizeCorrections(
  dictionary: Readonly<CorrectionDictionary>,
): CorrectionDictionary {
  return normalizeEntries(Object.entries(dictionary));
}

/** Empty text disables corrections; a malformed line must never erase the saved dictionary. */
export function parseCorrectionDictionary(text: string): CorrectionDictionary {
  const entries: [string, string][] = [];
  for (const [index, line] of text.split(/\r?\n/).entries()) {
    if (!line.trim()) continue;
    const separator = line.indexOf("=");
    if (separator < 0) {
      throw new Error(`Correction on line ${index + 1} must use source = replacement.`);
    }
    entries.push([line.slice(0, separator), line.slice(separator + 1)]);
  }
  return normalizeEntries(entries);
}

/** A single longest-first pass prevents replacements from triggering other dictionary rules. */
export function applyCorrections(
  text: string,
  dictionary: Readonly<CorrectionDictionary> = {},
): string {
  const entries = Object.entries(normalizeCorrections(dictionary)).sort(
    ([left], [right]) => right.length - left.length,
  );
  if (entries.length === 0) return text;
  const alternatives = entries.map(
    ([source]) => `(${source.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})`,
  );
  const pattern = new RegExp(
    String.raw`(?<![\p{L}\p{M}\p{N}_$])(?:${alternatives.join("|")})(?![\p{L}\p{M}\p{N}_$])`,
    "giu",
  );
  return text.replace(pattern, (match: string, ...captures: unknown[]) => {
    // Captures identify the rule even for Unicode case folds unlike toLowerCase().
    const index = entries.findIndex((_, candidate) => captures[candidate] !== undefined);
    return entries[index]?.[1] ?? match;
  });
}
