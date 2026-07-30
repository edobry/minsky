/**
 * Tests for listing-status classification (mt#3337).
 *
 * `modelCount: 0` reads identically whether a provider has no credentials, no
 * fetcher implementation, or a working key whose listing call is broken. The
 * originating incident turned on exactly that ambiguity: Anthropic reported 0
 * models with a "Failed to connect" error while completions worked fine, and
 * reading it at face value nearly pushed a task onto the wrong provider.
 */

import { describe, expect, test } from "bun:test";

import { deriveListingStatus } from "./provider-operations";
import { hasProviderFetcher, hasImplementedFetcher } from "./provider-registry";

describe("deriveListingStatus", () => {
  test("a broken listing on a configured provider is listing-failed, not unconfigured", () => {
    // The mt#3337 case: anthropic has a key and a fetcher, the fetch failed.
    expect(deriveListingStatus("anthropic", true, false)).toBe("listing-failed");
  });

  test("a provider with no fetcher is listing-unsupported, not failed", () => {
    // google is a known provider whose registry entry is a null placeholder.
    // Reporting it as a failure conflates unimplemented with broken.
    expect(deriveListingStatus("google", true, false)).toBe("listing-unsupported");
    expect(deriveListingStatus("google", true, undefined)).toBe("listing-unsupported");
  });

  test("missing credentials outrank everything else", () => {
    expect(deriveListingStatus("anthropic", false, false)).toBe("not-configured");
    expect(deriveListingStatus("cohere", false, undefined)).toBe("not-configured");
  });

  test("a successful fetch is ok", () => {
    expect(deriveListingStatus("anthropic", true, true)).toBe("ok");
  });

  test("configured with a fetcher but no attempt yet is never-attempted", () => {
    expect(deriveListingStatus("morph", true, undefined)).toBe("never-attempted");
  });

  test("the four states are mutually distinguishable for the same modelCount", () => {
    // All of these would render as `modelCount: 0` — the point of the field is
    // that they no longer collapse into one indistinguishable state.
    const states = new Set([
      deriveListingStatus("anthropic", true, false), // listing-failed
      deriveListingStatus("google", true, false), // listing-unsupported
      deriveListingStatus("anthropic", false, undefined), // not-configured
      deriveListingStatus("morph", true, undefined), // never-attempted
    ]);
    expect(states.size).toBe(4);
  });
});

describe("hasImplementedFetcher vs hasProviderFetcher", () => {
  test("hasProviderFetcher only validates the provider NAME", () => {
    // Documents the trap this fix had to route around: the name promises a
    // fetcher check, but google has a null registry entry and still passes.
    expect(hasProviderFetcher("google")).toBe(true);
    expect(hasProviderFetcher("not-a-provider")).toBe(false);
  });

  test("hasImplementedFetcher rejects the null placeholders", () => {
    expect(hasImplementedFetcher("anthropic")).toBe(true);
    expect(hasImplementedFetcher("openai")).toBe(true);
    expect(hasImplementedFetcher("google")).toBe(false);
    expect(hasImplementedFetcher("cohere")).toBe(false);
    expect(hasImplementedFetcher("not-a-provider")).toBe(false);
  });
});
