/**
 * Model resolution: exact identities and unambiguous, provider-bound shorthand.
 */

export interface ModelEntry {
  id: string;
  name: string;
  provider: string;
}

export interface ModelRegistry {
  find(provider: string, modelId: string): any;
  getAll(): any[];
  getAvailable?(): any[];
}

/**
 * Both display forms of a model. The short one goes on tight rows (the widget,
 * the Agent tool result), the canonical one where there is room to disambiguate
 * two providers serving a similarly-named model (the conversation viewer).
 *
 * One function, because `index.ts` labels the model it resolved before the run
 * and `agent-manager.ts` relabels it from the live session afterwards — the two
 * must agree or the label would visibly change the moment the session starts.
 */
export function describeModel(
  model: { provider: string; id: string; name?: string },
): { modelName: string; modelId: string } {
  return {
    modelName: (model.name ?? model.id).replace(/^Claude\s+/i, "").toLowerCase(),
    modelId: `${model.provider}/${model.id}`,
  };
}

/**
 * Cosmetic spelling changes must not reorder version tokens or erase modifiers.
 */
function normalizeReference(reference: string): string {
  return reference.trim().toLowerCase().replace(/\./g, "-").replace(/\s+/g, "-");
}

/**
 * A shorthand must identify a model, not merely occur somewhere in its metadata.
 * Exact IDs win; explicit providers and date pins never fall back. Unpinned
 * references prefer an undated alias, and unresolved ambiguity is an error.
 */
export function resolveModel(
  input: string,
  registry: ModelRegistry,
): any | string {
  const all = (registry.getAvailable?.() ?? registry.getAll()) as ModelEntry[];
  const modelList = (models: ModelEntry[]) => models
    .map(m => `  ${m.provider}/${m.id}`)
    .sort()
    .join("\n");
  const notFound = () => `Model not found: "${input}".\n\nAvailable models:\n${modelList(all)}`;
  const reference = input.trim();
  if (!reference) return notFound();

  let queryInput = reference;
  let candidates = all;
  const slashIdx = reference.indexOf("/");
  if (slashIdx !== -1) {
    const provider = reference.slice(0, slashIdx).trim().toLowerCase();
    const knownProvider = (registry.getAll?.() ?? all).some(m => m.provider.toLowerCase() === provider);
    candidates = all.filter(m => m.provider.toLowerCase() === provider);
    if (knownProvider || candidates.length > 0) {
      queryInput = reference.slice(slashIdx + 1).trim();
    } else {
      // Unknown prefixes can be literal model IDs, but only an exact raw ID
      // establishes that interpretation. Never retry a provider query bare.
      candidates = all.filter(m => m.id.toLowerCase() === reference.toLowerCase());
      if (candidates.length === 0) {
        return `Model not found: "${input}". Unknown provider: "${provider}".\n\nAvailable models:\n${modelList(all)}`;
      }
    }
  }
  if (!queryInput) return notFound();

  let matches = candidates.filter(m => m.id.toLowerCase() === queryInput.toLowerCase());
  if (matches.length === 0) {
    const query = normalizeReference(queryInput);
    const dateSuffix = /-\d{8}$/;
    const pin = query.match(dateSuffix)?.[0];
    const identities = candidates
      .filter(m => !pin || normalizeReference(m.id).endsWith(pin))
      .map(model => {
        const id = normalizeReference(model.id);
        const references = [pin ? id : id.replace(dateSuffix, ""), normalizeReference(model.name ?? model.id)]
          .flatMap(value => [value, value.replace(/^claude-/, "")]);
        return { model, references };
      });

    matches = identities.filter(({ references }) => references.includes(query)).map(({ model }) => model);
    // A versioned query must name the complete identity. Family-only shorthand
    // may omit the version, but never match inside another model's name.
    if (matches.length === 0 && !/\d/.test(query)) {
      matches = identities
        .filter(({ references }) => references.some(value => value.startsWith(`${query}-`)))
        .map(({ model }) => model);
    }

    if (!pin) {
      const aliases = new Set(matches
        .filter(m => !dateSuffix.test(normalizeReference(m.id)))
        .map(m => `${m.provider.toLowerCase()}/${normalizeReference(m.id)}`));
      matches = matches.filter(m => !dateSuffix.test(normalizeReference(m.id))
        || !aliases.has(`${m.provider.toLowerCase()}/${normalizeReference(m.id).replace(dateSuffix, "")}`));
    }
  }

  if (matches.length > 1) {
    return `Model "${input}" is ambiguous. Use one of:\n${modelList(matches)}`;
  }
  if (matches.length === 1) {
    const found = registry.find(matches[0].provider, matches[0].id);
    if (found) return found;
  }
  return notFound();
}
