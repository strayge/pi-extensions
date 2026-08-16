/**
 * pi-ai.ts — compatibility helpers plus the minimal model-runtime adapter used
 * by real-session faux tests on Pi 0.84+.
 */
import type { Model } from "@earendil-works/pi-ai";
import { getModel, registerFauxProvider, streamSimple } from "@earendil-works/pi-ai/compat";

export { getModel, registerFauxProvider };

/**
 * `createAgentSession` now requires the canonical runtime for auth and dispatch;
 * the old structural `modelRegistry` option is no longer consulted.
 */
export function fauxModelRuntime(model: Model<any>) {
  return {
    getModel: (provider: string, id: string) => provider === model.provider && id === model.id ? model : undefined,
    getModels: () => [model],
    getAvailable: async () => [model],
    getAvailableSnapshot: () => [model],
    hasConfiguredAuth: () => true,
    checkAuth: async () => undefined,
    isUsingOAuth: () => false,
    isUsingSubscription: () => false,
    streamSimple,
  };
}
