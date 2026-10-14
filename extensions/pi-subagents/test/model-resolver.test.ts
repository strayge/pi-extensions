import { describe, expect, it } from "vitest";
import { describeModel, type ModelEntry, type ModelRegistry, resolveModel } from "../src/model-resolver.js";

const OPUS_45 = { id: "claude-opus-4-5", name: "Claude Opus 4.5 (latest)", provider: "anthropic" };
const OPUS_45_DATED = { id: "claude-opus-4-5-20251101", name: "Claude Opus 4.5", provider: "anthropic" };
const OPUS_5 = { id: "claude-opus-5", name: "Claude Opus 5", provider: "anthropic" };
const OPUS_55 = { id: "claude-opus-5-5", name: "Claude Opus 5.5", provider: "anthropic" };
const HAIKU = { id: "claude-haiku-4-5-20251001", name: "Claude Haiku 4.5", provider: "anthropic" };
const GPT = { id: "gpt-4o", name: "GPT-4o", provider: "openai" };
const GEMINI = { id: "gemini-2.5-pro", name: "Gemini 2.5 Pro", provider: "google" };
const DISTILL = { id: "gemma4-31b-opus_distill-q6-kv51-160k", name: "Gemma4 31B Opus distill", provider: "llama.cpp" };
const MODELS = [OPUS_45, OPUS_45_DATED, OPUS_5, OPUS_55, HAIKU, GPT, GEMINI, DISTILL];

function makeRegistry(models: ModelEntry[] = MODELS, available?: ModelEntry[]): ModelRegistry {
  return {
    find: (provider, id) => models.find(m => m.provider === provider && m.id === id),
    getAll: () => models,
    getAvailable: available ? () => available : undefined,
  };
}

describe("resolveModel", () => {
  describe("exact identities and cosmetic normalization", () => {
    it.each<[string, ModelEntry]>([
      ["anthropic/claude-opus-5-5", OPUS_55],
      ["claude-opus-5-5", OPUS_55],
      ["Claude Opus 5.5", OPUS_55],
      [" ANTHROPIC / Claude-Opus-5-5 ", OPUS_55],
      ["anthropic/claude-opus-5.5", OPUS_55],
      ["anthropic/opus-5.5", OPUS_55],
      ["anthropic/opus-5-5", OPUS_55],
      ["Opus 5.5", OPUS_55],
      ["anthropic/opus-5", OPUS_5],
      ["gpt-4o", GPT],
      ["gemini-2-5-pro", GEMINI],
      ["haiku", HAIKU],
      ["anthropic/haiku", HAIKU],
    ])("resolves %s", (query, expected) => {
      expect(resolveModel(query, makeRegistry())).toEqual(expected);
    });

    it("uses an ID's version when the display name omits it", () => {
      const haiku = { id: "claude-haiku-4-5", name: "Claude Haiku", provider: "anthropic" };
      expect(resolveModel("haiku-4.5", makeRegistry([haiku]))).toEqual(haiku);
    });

    it("does not choose a version by catalog order", () => {
      for (const models of [MODELS, [...MODELS].reverse()]) {
        expect(resolveModel("anthropic/opus-5.5", makeRegistry(models))).toEqual(OPUS_55);
        expect(resolveModel("anthropic/opus-5", makeRegistry(models))).toEqual(OPUS_5);
      }
    });
  });

  describe("identity boundaries", () => {
    it.each(["anthropic/opus-5.4", "anthropic/opus-5.0", "anthropic/opus-5.6", "5.5", "google pro", "distill"])(
      "rejects scattered or incidental tokens in %s",
      query => {
        expect(resolveModel(query, makeRegistry())).toContain("Model not found");
      },
    );

    it("does not treat an incidental Opus word as Claude identity", () => {
      expect(resolveModel("opus", makeRegistry([DISTILL]))).toContain("Model not found");
    });

    it("does not match a partial numeric token", () => {
      const opus550 = { id: "claude-opus-5-50", name: "Claude Opus 5.50", provider: "anthropic" };
      expect(resolveModel("anthropic/opus-5.5", makeRegistry([opus550]))).toContain("Model not found");
    });

    it("does not complete a requested version with a different version or modifier", () => {
      const mini = { id: "gpt-4o-mini", name: "GPT-4o mini", provider: "openai" };
      expect(resolveModel("anthropic/opus-5", makeRegistry([OPUS_55]))).toContain("Model not found");
      expect(resolveModel("gpt-4o", makeRegistry([mini]))).toContain("Model not found");
      expect(resolveModel("gpt-4o-mini", makeRegistry([GPT]))).toContain("Model not found");
    });
  });

  describe("provider constraints", () => {
    const gatewayOpus = { ...OPUS_55, provider: "openrouter" };

    it("keeps an explicit provider binding even when only another provider is authenticated", () => {
      const registry = makeRegistry([OPUS_55, gatewayOpus], [gatewayOpus]);
      const result = resolveModel("anthropic/opus-5.5", registry);
      expect(result).toContain("Model not found");
      expect(result).toContain("openrouter/claude-opus-5-5");
    });

    it("rejects an unknown provider instead of retrying the bare shorthand", () => {
      expect(resolveModel("wrong-provider/opus-5.5", makeRegistry())).toContain('Unknown provider: "wrong-provider"');
    });

    it("rejects an ambiguous unqualified ID or display name across providers", () => {
      const registry = makeRegistry([OPUS_55, gatewayOpus]);
      for (const query of ["claude-opus-5-5", "Claude Opus 5.5", "opus-5.5"]) {
        const result = resolveModel(query, registry);
        expect(result).toContain("ambiguous");
        expect(result).toContain("anthropic/claude-opus-5-5");
        expect(result).toContain("openrouter/claude-opus-5-5");
      }
      expect(resolveModel("anthropic/opus-5.5", registry)).toEqual(OPUS_55);
    });

    it("preserves the full model ID after the provider separator", () => {
      const gateway = { id: "anthropic/claude-opus-5.5:exacto", name: "Claude Opus 5.5 Exacto", provider: "openrouter" };
      expect(resolveModel("openrouter/anthropic/claude-opus-5.5:exacto", makeRegistry([gateway]))).toEqual(gateway);
    });

    it("allows an exact raw slash-containing ID with no conflicting provider prefix", () => {
      const gateway = { id: "vendor/model:exacto", name: "Vendor Model", provider: "openrouter" };
      expect(resolveModel("vendor/model:exacto", makeRegistry([gateway]))).toEqual(gateway);
    });

    it("does not reinterpret a known but unavailable provider as a raw gateway ID", () => {
      const gateway = { id: "anthropic/claude-opus-5-5", name: OPUS_55.name, provider: "openrouter" };
      expect(resolveModel(gateway.id, makeRegistry([OPUS_55, gateway], [gateway]))).toContain("Model not found");
      expect(resolveModel(`openrouter/${gateway.id}`, makeRegistry([OPUS_55, gateway], [gateway]))).toEqual(gateway);
    });
  });

  describe("date pins and aliases", () => {
    it.each(["anthropic/claude-opus-4-5-20251101", "anthropic/opus-4.5-20251101"])(
      "honors the explicit pin in %s",
      query => {
        expect(resolveModel(query, makeRegistry())).toEqual(OPUS_45_DATED);
      },
    );

    it("rejects a missing pin even when an undated alias or other snapshot exists", () => {
      expect(resolveModel("anthropic/claude-opus-4.5-20251102", makeRegistry())).toContain("Model not found");
      expect(resolveModel("anthropic/claude-opus-4.5-20251101", makeRegistry([OPUS_45]))).toContain("Model not found");
    });

    it("prefers the undated alias for an unpinned version regardless of catalog order", () => {
      for (const models of [[OPUS_45_DATED, OPUS_45], [OPUS_45, OPUS_45_DATED]]) {
        expect(resolveModel("anthropic/opus-4.5", makeRegistry(models))).toEqual(OPUS_45);
        expect(resolveModel("Claude Opus 4.5", makeRegistry(models))).toEqual(OPUS_45);
      }
    });

    it("allows a unique dated snapshot when the request is unpinned", () => {
      expect(resolveModel("anthropic/opus-4.5", makeRegistry([OPUS_45_DATED]))).toEqual(OPUS_45_DATED);
    });

    it("does not guess the newest snapshot when no undated alias exists", () => {
      const other = { ...OPUS_45_DATED, id: "claude-opus-4-5-20251102" };
      expect(resolveModel("anthropic/opus-4.5", makeRegistry([OPUS_45_DATED, other]))).toContain("ambiguous");
    });
  });

  describe("ambiguity and availability", () => {
    it("lists distinct versions instead of choosing the shortest ID", () => {
      const result = resolveModel("anthropic/opus", makeRegistry());
      expect(result).toContain("ambiguous");
      for (const model of [OPUS_45, OPUS_5, OPUS_55]) expect(result).toContain(`anthropic/${model.id}`);
      expect(result).not.toContain(OPUS_45_DATED.id);
    });

    it("considers only authenticated models when availability can be enumerated", () => {
      const registry = makeRegistry(MODELS, [OPUS_55]);
      expect(resolveModel("opus", registry)).toEqual(OPUS_55);
      expect(resolveModel("haiku", registry)).toContain("Model not found");
      expect(resolveModel("anthropic/claude-haiku-4-5-20251001", registry)).toContain("Model not found");
    });

    it.each(["", "   ", "nonexistent-model", "anthropic/"])("rejects %j without selecting a default", query => {
      expect(resolveModel(query, makeRegistry())).toContain("Model not found");
    });

    it("lists available models on a failed lookup", () => {
      const result = resolveModel("nonexistent-model", makeRegistry());
      expect(result).toContain('Model not found: "nonexistent-model"');
      expect(result).toContain("Available models:");
      expect(result).toContain("anthropic/claude-opus-5-5");
      expect(result).toContain("openai/gpt-4o");
    });

    it("rejects an empty registry", () => {
      expect(resolveModel("haiku", makeRegistry([]))).toContain("Model not found");
    });
  });
});

describe("describeModel", () => {
  it("gives a short label and a canonical id", () => {
    expect(describeModel({ provider: "anthropic", id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6" }))
      .toEqual({ modelName: "sonnet 4.6", modelId: "anthropic/claude-sonnet-4-6" });
  });

  it("falls back to the id when the model has no display name", () => {
    expect(describeModel({ provider: "openai-codex", id: "gpt-5.6-sol" }))
      .toEqual({ modelName: "gpt-5.6-sol", modelId: "openai-codex/gpt-5.6-sol" });
  });
});
