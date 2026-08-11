export function prioritizeModelsCommand<T extends { value: string }>(
  items: readonly T[],
  textBeforeCursor: string,
): T[] {
  const match = textBeforeCursor.match(/^\/(?<prefix>[^\s]*)$/);
  const prefix = match?.groups?.prefix ?? "";
  if (!prefix || prefix === "model" || !"models".startsWith(prefix)) return [...items];

  const index = items.findIndex((item) => item.value === "models");
  if (index <= 0) return [...items];
  return [items[index] as T, ...items.slice(0, index), ...items.slice(index + 1)];
}
