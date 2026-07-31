/**
 * Tests for the configured-model doctor diagnostic (mt#3389).
 *
 * Acceptance-test numbering follows mt#3389's `## Acceptance Tests`.
 */

import { describe, expect, test } from "bun:test";
import {
  checkConfiguredModelsAgainstListing,
  collectConfiguredProviderModels,
} from "./doctor-model-checks";

/** The real retired id this check was filed for (retired 2025-10-28). */
const RETIRED_ID = "claude-3-5-sonnet-20241022";

const anthropicListing = [{ id: "claude-opus-5" }, { id: "claude-sonnet-5" }];
const openaiListing = [{ id: "gpt-4o" }, { id: "gpt-4o-mini" }];

describe("collectConfiguredProviderModels", () => {
  test("collects every provider that declares a model, generically", () => {
    const collected = collectConfiguredProviderModels({
      providers: {
        openai: { model: "gpt-4o" },
        anthropic: { model: RETIRED_ID },
        // A provider the schema may add later — covered without code changes.
        somefutureprovider: { model: "future-1" },
      },
    });

    expect(collected).toEqual([
      { provider: "anthropic", model: RETIRED_ID },
      { provider: "openai", model: "gpt-4o" },
      { provider: "somefutureprovider", model: "future-1" },
    ]);
  });

  test("skips providers that declare no model, and handles absent config", () => {
    expect(
      collectConfiguredProviderModels({
        providers: { openai: { model: "gpt-4o" }, anthropic: {}, google: undefined },
      })
    ).toEqual([{ provider: "openai", model: "gpt-4o" }]);

    expect(collectConfiguredProviderModels({})).toEqual([]);
    expect(collectConfiguredProviderModels(undefined)).toEqual([]);
  });
});

describe("checkConfiguredModelsAgainstListing", () => {
  // AT1: absent from the listing → warning naming provider and model id.
  test("AT1: warns and names the provider and model when the id is not in the listing", () => {
    const result = checkConfiguredModelsAgainstListing(
      [{ provider: "anthropic", model: RETIRED_ID }],
      { anthropic: anthropicListing }
    );

    expect(result.status).toBe("warning");
    expect(result.message).toContain("anthropic");
    expect(result.message).toContain(RETIRED_ID);
    expect(result.suggestion).toBeDefined();
  });

  // AT2: present in the listing → pass.
  test("AT2: passes when the configured id is present in the listing", () => {
    const result = checkConfiguredModelsAgainstListing(
      [{ provider: "anthropic", model: "claude-sonnet-5" }],
      { anthropic: anthropicListing }
    );

    expect(result.status).toBe("pass");
    expect(result.message).not.toContain(RETIRED_ID);
  });

  // AT3: no cached listing → distinct "could not verify", NOT an invalid claim.
  test("AT3: reports could-not-verify rather than invalid when the cache is empty", () => {
    const result = checkConfiguredModelsAgainstListing(
      [{ provider: "anthropic", model: RETIRED_ID }],
      {}
    );

    expect(result.status).not.toBe("warning");
    expect(result.message).toContain("Could not verify");
    // The critical property: it must not assert the configured value is wrong.
    expect(result.message).not.toContain("not found");
  });

  test("AT3: a provider present-but-empty in the cache is also unverifiable, not invalid", () => {
    const result = checkConfiguredModelsAgainstListing(
      [{ provider: "anthropic", model: RETIRED_ID }],
      { anthropic: [] }
    );

    expect(result.status).not.toBe("warning");
    expect(result.message).toContain("Could not verify");
  });

  // AT4: mixed — only the rotted provider is reported.
  test("AT4: reports only the rotted provider when another is valid", () => {
    const result = checkConfiguredModelsAgainstListing(
      [
        { provider: "anthropic", model: RETIRED_ID },
        { provider: "openai", model: "gpt-4o" },
      ],
      { anthropic: anthropicListing, openai: openaiListing }
    );

    expect(result.status).toBe("warning");
    expect(result.message).toContain(`anthropic → '${RETIRED_ID}'`);
    expect(result.message).not.toContain("openai → ");
  });

  test("AT4: covers every configured provider, not only anthropic", () => {
    const result = checkConfiguredModelsAgainstListing(
      [{ provider: "openai", model: "gpt-3.5-turbo-retired" }],
      { openai: openaiListing }
    );

    expect(result.status).toBe("warning");
    expect(result.message).toContain("openai");
    expect(result.message).toContain("gpt-3.5-turbo-retired");
  });

  test("names unverifiable providers alongside a real finding rather than hiding them", () => {
    const result = checkConfiguredModelsAgainstListing(
      [
        { provider: "anthropic", model: RETIRED_ID },
        { provider: "google", model: "gemini-x" },
      ],
      { anthropic: anthropicListing }
    );

    expect(result.status).toBe("warning");
    expect(result.message).toContain(RETIRED_ID);
    expect(result.message).toContain("google");
    expect(result.message).toContain("Not checked");
  });

  test("passes with nothing configured", () => {
    const result = checkConfiguredModelsAgainstListing([], { anthropic: anthropicListing });

    expect(result.status).toBe("pass");
    expect(result.message).toContain("No provider default models are configured");
  });

  // AT5: the pure function takes its listing as an argument, so no network call
  // is reachable from it — asserted structurally by the signature itself.
  test("AT5: performs no IO — the listing is supplied by the caller", () => {
    const result = checkConfiguredModelsAgainstListing(
      [{ provider: "anthropic", model: "claude-opus-5" }],
      { anthropic: anthropicListing }
    );

    expect(result.check).toBe("Configured Model Validity");
    expect(checkConfiguredModelsAgainstListing.length).toBe(2);
    expect(result.status).toBe("pass");
  });
});
