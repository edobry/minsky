/**
 * Tests for the OAuth configuration schema — mt#1662
 *
 * Verifies:
 * 1. Valid config objects are accepted and defaults applied.
 * 2. Invalid values (bad provider, bad URL) are rejected.
 * 3. The optional block itself may be absent.
 */

import { describe, test, expect } from "bun:test";
import { oauthConfigSchema, oauthProviderSchema } from "./oauth";

describe("oauthProviderSchema", () => {
  test("accepts valid provider values", () => {
    for (const provider of ["in-process", "cloudflare-worker", "auth0", "clerk"] as const) {
      const result = oauthProviderSchema.safeParse(provider);
      expect(result.success).toBe(true);
    }
  });

  test("rejects unknown provider strings", () => {
    const result = oauthProviderSchema.safeParse("unknown-provider");
    expect(result.success).toBe(false);
  });

  test("rejects empty string", () => {
    const result = oauthProviderSchema.safeParse("");
    expect(result.success).toBe(false);
  });
});

describe("oauthConfigSchema", () => {
  test("accepts undefined (entire block is optional)", () => {
    const result = oauthConfigSchema.safeParse(undefined);
    expect(result.success).toBe(true);
    expect(result.data).toBeUndefined();
  });

  test("accepts an empty object and applies defaults", () => {
    const result = oauthConfigSchema.safeParse({});
    expect(result.success).toBe(true);
    // provider defaults to "in-process"
    expect(result.data?.provider).toBe("in-process");
  });

  test('accepts provider "in-process"', () => {
    const result = oauthConfigSchema.safeParse({ provider: "in-process" });
    expect(result.success).toBe(true);
    expect(result.data?.provider).toBe("in-process");
  });

  test('accepts provider "auth0"', () => {
    const result = oauthConfigSchema.safeParse({ provider: "auth0" });
    expect(result.success).toBe(true);
    expect(result.data?.provider).toBe("auth0");
  });

  test("accepts a valid issuer URL", () => {
    const result = oauthConfigSchema.safeParse({
      issuer: "https://minsky-mcp-production.up.railway.app",
    });
    expect(result.success).toBe(true);
    expect(result.data?.issuer).toBe("https://minsky-mcp-production.up.railway.app");
  });

  test("rejects an invalid issuer URL (not a URL)", () => {
    const result = oauthConfigSchema.safeParse({ issuer: "not-a-url" });
    expect(result.success).toBe(false);
  });

  test("accepts a signingKey string", () => {
    const result = oauthConfigSchema.safeParse({ signingKey: "env:OAUTH_SIGNING_KEY" });
    expect(result.success).toBe(true);
    expect(result.data?.signingKey).toBe("env:OAUTH_SIGNING_KEY");
  });

  test("accepts a full valid config object", () => {
    const result = oauthConfigSchema.safeParse({
      provider: "in-process",
      issuer: "https://example.com",
      signingKey: "env:MY_JWK",
    });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data?.provider).toBe("in-process");
    expect(result.data?.issuer).toBe("https://example.com");
    expect(result.data?.signingKey).toBe("env:MY_JWK");
  });

  test("rejects unknown provider", () => {
    const result = oauthConfigSchema.safeParse({ provider: "bogus" });
    expect(result.success).toBe(false);
  });

  test("issuer and signingKey are optional", () => {
    const result = oauthConfigSchema.safeParse({ provider: "in-process" });
    expect(result.success).toBe(true);
    expect(result.data?.issuer).toBeUndefined();
    expect(result.data?.signingKey).toBeUndefined();
  });
});
