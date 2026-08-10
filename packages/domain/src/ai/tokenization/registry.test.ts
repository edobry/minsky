/**
 * Tests for tokenizer resolution reporting (mt#3928).
 *
 * The defect these cover: only OpenAI-family tokenizers are registered, so every
 * Anthropic and Google model — and every model id that does not exist — reached
 * `getForModel`'s `defaultLibrary` fallback and came back indistinguishable from
 * a genuine match. The outcome was recorded in a `log.warn` no CLI surface
 * reads, so `context generate` reported an OpenAI encoding as an Anthropic
 * model's tokenizer and `--compare-models` reported identical counts for every
 * model as though it had measured them.
 */

import { describe, expect, test } from "bun:test";
import { DefaultTokenizerRegistry } from "./registry";
import { DefaultTokenizationService } from "./service";

/**
 * The registry registers its built-in tokenizers in the constructor, so these
 * exercise the real gpt-tokenizer/tiktoken registration rather than a stub —
 * which models are actually covered is the fact under test.
 */
function registry(): DefaultTokenizerRegistry {
  return new DefaultTokenizerRegistry();
}

describe("resolveForModel reports whether a tokenizer was matched or substituted", () => {
  test("an OpenAI model resolves from config", () => {
    const resolution = registry().resolveForModel("gpt-4o");

    expect(resolution).not.toBeNull();
    expect(resolution?.source).toBe("config");
  });

  // The headline case: an Anthropic model gets a real tokenizer object back, so
  // nothing downstream errors — the only thing distinguishing it is `source`.
  test("an Anthropic model resolves as a fallback, not a match", () => {
    const resolution = registry().resolveForModel("claude-opus-5");

    expect(resolution).not.toBeNull();
    expect(resolution?.tokenizer).toBeDefined();
    expect(resolution?.source).toBe("fallback");
  });

  test("a model id that does not exist is distinguishable from one that does", () => {
    const subject = registry();

    const real = subject.resolveForModel("gpt-4o");
    const invented = subject.resolveForModel("totally-unknown-model-xyz");

    // Both return a usable tokenizer — that is the point, a typo should not
    // crash the command — but they are no longer the same answer.
    expect(real?.tokenizer).toBeDefined();
    expect(invented?.tokenizer).toBeDefined();
    expect(real?.source).not.toBe(invented?.source);
    expect(invented?.source).toBe("fallback");
  });

  test("getForModel still returns the tokenizer alone, for callers that only need it", () => {
    const subject = registry();

    expect(subject.getForModel("claude-opus-5")).toBe(
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      subject.resolveForModel("claude-opus-5")!.tokenizer
    );
  });
});

describe("getTokenizerMetadata reports the resolution rather than a constant", () => {
  test("a fallback-resolved model is marked approximated", async () => {
    const metadata = await new DefaultTokenizationService().getTokenizerMetadata("claude-opus-5");

    expect(metadata).not.toBeNull();
    expect(metadata?.approximated).toBe(true);
    // `source` was the literal "config" for every model before mt#3928 — the
    // assertion that would have failed then.
    expect(metadata?.source).toBe("fallback");
  });

  test("a matched model is not marked approximated", async () => {
    const metadata = await new DefaultTokenizationService().getTokenizerMetadata("gpt-4o");

    expect(metadata).not.toBeNull();
    expect(metadata?.approximated).toBe(false);
    expect(metadata?.source).toBe("config");
  });

  /**
   * A flag that fires on everything carries no information. This is the
   * discriminating property, asserted directly rather than inferred from the
   * two cases above passing independently.
   */
  test("the approximation flag discriminates between the two", async () => {
    const service = new DefaultTokenizationService();

    const matched = await service.getTokenizerMetadata("gpt-4o");
    const substituted = await service.getTokenizerMetadata("claude-opus-5");

    expect(matched?.approximated).not.toBe(substituted?.approximated);
  });
});
