export function isStaleExtensionContextError(error: unknown): boolean {
  return (
    error instanceof Error &&
    error.message.includes("This extension ctx is stale after session replacement or reload")
  );
}

export function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

export function sanitizeDisplayText(value: string, maxChars = 160): string {
  let result = "";
  for (let index = 0; index < value.length; ) {
    const codePoint = value.codePointAt(index) ?? 0;
    const character = String.fromCodePoint(codePoint);
    if (codePoint === 0x1b || codePoint === 0x9b || codePoint === 0x9d) {
      index = skipTerminalEscape(value, index, codePoint);
      continue;
    }
    if (codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f)) {
      if (codePoint === 0x09 || codePoint === 0x0a || codePoint === 0x0d) result += " ";
      index += character.length;
      continue;
    }
    result += character;
    index += character.length;
  }
  return truncate(result.replace(/\s+/gu, " ").trim(), maxChars);
}

function skipTerminalEscape(value: string, start: number, codePoint: number): number {
  let index = start + 1;
  const next = value.charCodeAt(index);
  const isOsc = codePoint === 0x9d || (codePoint === 0x1b && next === 0x5d);
  if (isOsc) {
    if (codePoint === 0x1b) index += 1;
    while (index < value.length) {
      const current = value.charCodeAt(index);
      if (current === 0x07) return index + 1;
      if (current === 0x1b && value.charCodeAt(index + 1) === 0x5c) return index + 2;
      index += 1;
    }
    return index;
  }
  const isCsi = codePoint === 0x9b || (codePoint === 0x1b && next === 0x5b);
  if (isCsi) {
    if (codePoint === 0x1b) index += 1;
    while (index < value.length) {
      const current = value.charCodeAt(index);
      index += 1;
      if (current >= 0x40 && current <= 0x7e) break;
    }
    return index;
  }
  return Math.min(value.length, start + (codePoint === 0x1b ? 2 : 1));
}

function truncate(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, maxChars - 1)}…`;
}
