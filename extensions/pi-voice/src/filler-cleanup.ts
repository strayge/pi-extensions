export const DEFAULT_FILLER_WORDS: readonly string[] = ["uh", "um", "erm"];

/** Keep comma-separated edits and persisted lists consistent without mutating defaults. */
export function normalizeFillerWords(words: readonly string[]): string[] {
  return [...new Set(words.map((word) => word.trim().toLowerCase()).filter(Boolean))];
}

/**
 * Keep dictation readable without rewriting grammar or ambiguous words such as "like".
 * Quoted tokens, identifiers, compounds, and uppercase acronyms remain literal.
 */
export function cleanDictationFillers(
  text: string,
  fillerWords: readonly string[] = DEFAULT_FILLER_WORDS,
): string {
  const words = normalizeFillerWords(fillerWords);
  if (words.length === 0) return text;
  const alternatives = words
    .sort((left, right) => right.length - left.length)
    .flatMap((word) => {
      const [first = ""] = word;
      return [word, first.toUpperCase() + word.slice(first.length)];
    })
    .map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const fillers = new RegExp(
    String.raw`(?<![\p{L}\p{N}_$."'‘’“”«»\x60-])(?:${alternatives.join("|")})(?![\p{L}\p{N}_$"'‘’“”«»\x60-]|\.[\p{L}\p{N}_$])[ \t]*([,;.!?…]*)([ \t]*)`,
    "gu",
  );
  let prefix = "";
  let previousEnd = 0;
  const cleaned = text.replace(
    fillers,
    (match: string, punctuation: string, spacing: string, offset: number) => {
      prefix += text.slice(previousEnd, offset);
      previousEnd = offset + match.length;
      const preceding = prefix.slice(prefix.lastIndexOf("\n") + 1).trimEnd();
      // Judge boundaries against retained text, not earlier fillers in the same take.
      const boundary = punctuation.replace(/[,;]/g, "");
      const replacement =
        boundary && preceding && !/[.!?…]$/.test(preceding) ? boundary + spacing : "";
      prefix += replacement;
      return replacement;
    },
  );
  if (cleaned === text) return text;
  return cleaned
    .replace(/[ \t]+([,;:.!?…)\]])/g, "$1")
    .replace(/[ \t]+$/gm, "")
    .trim();
}
