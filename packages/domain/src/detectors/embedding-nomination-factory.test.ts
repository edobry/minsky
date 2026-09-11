/**
 * Regression tests for `resolveNominationDeps`' return contract (mt#5051).
 *
 * Before the fix the resolver returned a bare `null` from one catch-all, with the caught error
 * discarded — so "no provider configured" (healthy) and "configured but could not be
 * constructed" / "configuration never initialized" (faults) were indistinguishable to every
 * consumer, which is the collapse ADR-035 §Decision rule 3 forbids. These tests pin the three
 * arms apart, and AT2 asserts the two non-resolved arms DIFFER rather than checking one alone.
 */

import { describe, test, expect, beforeEach } from "bun:test";
import { _resetConfigurationForTests } from "../configuration";
import {
  isEmbeddingProviderConfigured,
  resolveNominationDeps,
  type NominationDepsResolution,
} from "./embedding-nomination-factory";

const NO_PROVIDER_CONFIG = { ai: { providers: {} }, embeddings: {} };

beforeEach(() => {
  _resetConfigurationForTests();
});

describe("isEmbeddingProviderConfigured", () => {
  test("openai needs ai.providers.openai.apiKey", () => {
    expect(isEmbeddingProviderConfigured("openai", NO_PROVIDER_CONFIG)).toBe(false);
    expect(
      isEmbeddingProviderConfigured("openai", { ai: { providers: { openai: { apiKey: "k" } } } })
    ).toBe(true);
  });

  test("gemini reads the google provider block, which is where its service reads from", () => {
    expect(isEmbeddingProviderConfigured("gemini", NO_PROVIDER_CONFIG)).toBe(false);
    expect(
      isEmbeddingProviderConfigured("gemini", { ai: { providers: { google: { apiKey: "k" } } } })
    ).toBe(true);
  });

  test("local needs no key; an unknown name is treated as configured so construction reports it", () => {
    expect(isEmbeddingProviderConfigured("local", NO_PROVIDER_CONFIG)).toBe(true);
    expect(isEmbeddingProviderConfigured("nonexistent", NO_PROVIDER_CONFIG)).toBe(true);
  });
});

describe("resolveNominationDeps (mt#5051)", () => {
  test("AT1: configuration never initialized is `unavailable` carrying getConfiguration's message — through the REAL binding", async () => {
    // No injected deps: the default `readConfig` is the live `getConfiguration()`, which the
    // beforeEach reset leaves uninitialized. This is the mt#5000 shape every cold hook process hit.
    const result = (await resolveNominationDeps()) as unknown as NominationDepsResolution | null;

    expect(result).not.toBeNull();
    expect(result?.kind).toBe("unavailable");
    if (result?.kind !== "unavailable") throw new Error("expected the unavailable arm");
    expect(result.reason).toContain("Configuration not initialized");
    expect(result.provider).toBe("unknown");
  });

  test("AT2: no embedding provider configured is `unconfigured`, and it DIFFERS from the uninitialized case", async () => {
    const unconfigured = await resolveNominationDeps({ readConfig: () => NO_PROVIDER_CONFIG });
    const uninitialized = await resolveNominationDeps({
      readConfig: () => {
        throw new Error("Configuration not initialized. Call initializeConfiguration() first.");
      },
    });

    expect(unconfigured).toEqual({ kind: "unconfigured", provider: "openai" });
    expect(uninitialized.kind).toBe("unavailable");
    // The collapse this task removes: both used to be `null`. Asserting only one arm would let
    // an implementation that maps every failure to one kind pass.
    expect(unconfigured.kind).not.toBe(uninitialized.kind);
  });

  test("a configured provider whose construction throws is `unavailable` naming the provider", async () => {
    const result = await resolveNominationDeps({
      readConfig: () => ({ ai: { providers: { openai: { apiKey: "k" } } }, embeddings: {} }),
      createService: async () => {
        throw new Error("boom: model not found");
      },
    });

    expect(result.kind).toBe("unavailable");
    if (result.kind !== "unavailable") throw new Error("expected the unavailable arm");
    expect(result.provider).toBe("openai");
    expect(result.reason).toContain("boom: model not found");
  });

  test("the configured provider name follows embeddings.provider, then ai.defaultProvider, then openai", async () => {
    const viaEmbeddings = await resolveNominationDeps({
      readConfig: () => ({ ai: { providers: {} }, embeddings: { provider: "gemini" } }),
    });
    const viaDefault = await resolveNominationDeps({
      readConfig: () => ({ ai: { defaultProvider: "gemini", providers: {} }, embeddings: {} }),
    });

    expect(viaEmbeddings).toEqual({ kind: "unconfigured", provider: "gemini" });
    expect(viaDefault).toEqual({ kind: "unconfigured", provider: "gemini" });
  });

  test("AT3 (negative control on the scrub): a reason carrying a connection string with credentials is scrubbed on the RETURNED value", async () => {
    const result = await resolveNominationDeps({
      readConfig: () => ({ ai: { providers: { openai: { apiKey: "k" } } }, embeddings: {} }),
      createService: async () => {
        throw new Error("connect failed: postgresql://minsky:s3cretpw@db.example.com:5432/minsky");
      },
    });

    if (result.kind !== "unavailable") throw new Error("expected the unavailable arm");
    expect(result.reason).not.toContain("s3cretpw");
    expect(result.reason).toContain("connect failed");
  });

  test("a resolved provider returns the deps with the semantic flag", async () => {
    const service = { generateEmbedding: async () => [], generateEmbeddings: async () => [] };
    const semantic = await resolveNominationDeps({
      readConfig: () => ({ ai: { providers: { openai: { apiKey: "k" } } }, embeddings: {} }),
      createService: async () => service,
    });
    const hashStub = await resolveNominationDeps({
      readConfig: () => ({ ai: { providers: {} }, embeddings: { provider: "local" } }),
      createService: async () => service,
    });

    expect(semantic).toEqual({
      kind: "resolved",
      deps: { embeddingService: service, semantic: true },
    });
    expect(hashStub).toEqual({
      kind: "resolved",
      deps: { embeddingService: service, semantic: false },
    });
  });
});
