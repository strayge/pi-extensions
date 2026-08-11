export interface ModelLike {
  provider: string;
  id: string;
  name?: string;
}
export interface ModelState {
  favorite?: boolean;
  lastUsedAt?: number;
}
export interface RankedModel<T extends ModelLike> {
  model: T;
  state: ModelState;
  score: number;
}

const identity = (model: ModelLike) => `${model.provider}/${model.id}`;
function fuzzyScore(text: string, query: string): number {
  let cursor = 0;
  let score = 0;
  const lower = text.toLocaleLowerCase();
  for (const char of query.toLocaleLowerCase()) {
    const found = lower.indexOf(char, cursor);
    if (found < 0) return -1;
    score += found === cursor ? 3 : 1;
    cursor = found + 1;
  }
  return score - (cursor - query.length) * 0.01;
}

export function rankModels<T extends ModelLike>(
  models: readonly T[],
  states: Record<string, ModelState>,
  query = "",
): T[] {
  const ranked: RankedModel<T>[] = [];
  for (const model of models) {
    const key = identity(model);
    const state = states[key] ?? {};
    const fields = [model.provider, model.id, key, model.name ?? ""];
    const score = query.trim()
      ? Math.max(...fields.map((field) => fuzzyScore(field, query.trim())))
      : 0;
    if (score >= 0) ranked.push({ model, state, score });
  }
  ranked.sort((a, b) => {
    const favorite = Number(Boolean(b.state.favorite)) - Number(Boolean(a.state.favorite));
    if (favorite) return favorite;
    if (query.trim() && b.score !== a.score) return b.score - a.score;
    const recency = (b.state.lastUsedAt ?? -1) - (a.state.lastUsedAt ?? -1);
    if (recency) return recency;
    return a.model.provider.localeCompare(b.model.provider) || a.model.id.localeCompare(b.model.id);
  });
  return ranked.map(({ model }) => model);
}

export const modelKey = identity;
