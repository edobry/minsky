/**
 * Tests for harness-config-auth.ts's env-first credential resolution (mt#4620).
 *
 * Covers only the ENV branch of `resolveProviderApiKeyWithConfig` — the config-fallback branch
 * requires a live `setupConfiguration()` against Minsky's real configuration system, which these
 * tests deliberately do not stand up (that path is exercised live by mt#4620's actual runner
 * invocation, recorded in that task's spec). What IS unit-testable, and load-bearing: an env var
 * present must win over config and must never trigger configuration initialization at all.
 */

import { describe, test, expect, afterEach } from "bun:test";
import { resolveProviderApiKeyWithConfig, getGitHubTokenSource } from "./harness-config-auth";

const ENV_VAR = "MT4620_TEST_PROVIDER_KEY";

describe("resolveProviderApiKeyWithConfig", () => {
  afterEach(() => {
    delete process.env[ENV_VAR];
  });

  test("returns the env var when set, without touching configuration", async () => {
    process.env[ENV_VAR] = "env-value-123";
    const result = await resolveProviderApiKeyWithConfig("google", ENV_VAR);
    expect(result).toBe("env-value-123");
  });

  test("whitespace-only env var is treated as unset, not returned as a key (PR #3373 R1)", async () => {
    process.env[ENV_VAR] = "   ";
    // A whitespace-only env var must not mask a real config-stored credential: the presence
    // check trims before deciding, so this falls through to the config lookup (undefined here,
    // since no configuration is initialized in this test process) rather than returning "   ".
    const result = await resolveProviderApiKeyWithConfig("anthropic", ENV_VAR);
    expect(result).not.toBe("   ");
  });

  test("a real key with meaningful leading/trailing whitespace still round-trips raw", async () => {
    process.env[ENV_VAR] = "  real-key-with-padding  ";
    const result = await resolveProviderApiKeyWithConfig("google", ENV_VAR);
    expect(result).toBe("  real-key-with-padding  ");
  });

  test("empty-string env var is treated as unset (falls through, not returned as a key)", async () => {
    process.env[ENV_VAR] = "";
    // With no config initialized/available in this test process, the config fallback resolves to
    // undefined too — the observable contract this test protects is that an empty string is never
    // itself returned as though it were a real key.
    const result = await resolveProviderApiKeyWithConfig("openai", ENV_VAR);
    expect(result).not.toBe("");
  });
});

describe("getGitHubTokenSource — whitespace-only OCTOKIT_AUTH must not mask a real GITHUB_TOKEN (PR #3373 R2)", () => {
  afterEach(() => {
    delete process.env.OCTOKIT_AUTH;
    delete process.env.GITHUB_TOKEN;
  });

  test("whitespace-only OCTOKIT_AUTH falls through to a meaningful GITHUB_TOKEN", async () => {
    process.env.OCTOKIT_AUTH = "   ";
    process.env.GITHUB_TOKEN = "real-github-token";
    const source = await getGitHubTokenSource();
    // The regression this guards: `OCTOKIT_AUTH || GITHUB_TOKEN` combined BEFORE trimming would
    // short-circuit on the whitespace-only OCTOKIT_AUTH (a non-empty string is truthy) and never
    // even look at GITHUB_TOKEN. Each must be checked for meaningful content independently.
    expect(source).toBe("GITHUB_TOKEN");
  });

  test("a meaningful OCTOKIT_AUTH still wins over GITHUB_TOKEN when both are set", async () => {
    process.env.OCTOKIT_AUTH = "real-octokit-auth";
    process.env.GITHUB_TOKEN = "real-github-token";
    const source = await getGitHubTokenSource();
    expect(source).toBe("OCTOKIT_AUTH");
  });
});
