/**
 * Tests for harness-config-auth.ts's env-first credential resolution (mt#4620).
 *
 * The whitespace/empty-vs-meaningful distinction is tested against the pure
 * `hasMeaningfulValue` helper directly (PR #3373 R3) rather than through the async
 * `resolveProviderApiKeyWithConfig`/`resolveGitHubTokenWithConfig` wrappers: a non-meaningful env
 * var falls through to the config-fallback branch, which calls `setupConfiguration()` — coupling
 * these tests to Minsky's real configuration system for a question the pure helper already
 * answers on its own. Only the "env var wins, config never touched" contract is exercised through
 * the async wrappers, using a definitely-meaningful value so the config branch is never reached.
 */

import { describe, test, expect, afterEach } from "bun:test";
import {
  hasMeaningfulValue,
  resolveProviderApiKeyWithConfig,
  getGitHubTokenSource,
} from "./harness-config-auth";

describe("hasMeaningfulValue", () => {
  test("undefined is not meaningful", () => {
    expect(hasMeaningfulValue(undefined)).toBe(false);
  });

  test("empty string is not meaningful", () => {
    expect(hasMeaningfulValue("")).toBe(false);
  });

  test("whitespace-only string is not meaningful (PR #3373 R1)", () => {
    expect(hasMeaningfulValue("   ")).toBe(false);
    expect(hasMeaningfulValue("\t\n")).toBe(false);
  });

  test("a real value, including one with padding, is meaningful", () => {
    expect(hasMeaningfulValue("real-key-123")).toBe(true);
    expect(hasMeaningfulValue(PADDED_KEY)).toBe(true);
  });
});

const ENV_VAR = "MT4620_TEST_PROVIDER_KEY";
const PADDED_KEY = "  real-key-with-padding  ";

describe("resolveProviderApiKeyWithConfig — env var wins over config, without touching it", () => {
  afterEach(() => {
    delete process.env[ENV_VAR];
  });

  test("returns the env var when set, without touching configuration", async () => {
    process.env[ENV_VAR] = "env-value-123";
    const result = await resolveProviderApiKeyWithConfig("google", ENV_VAR);
    expect(result).toBe("env-value-123");
  });

  test("a real key with meaningful leading/trailing whitespace still round-trips raw", async () => {
    process.env[ENV_VAR] = PADDED_KEY;
    const result = await resolveProviderApiKeyWithConfig("google", ENV_VAR);
    expect(result).toBe(PADDED_KEY);
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
    // Both env vars here are meaningful-or-whitespace, never empty/undefined, so this never
    // reaches the config-fallback branch.
    expect(source).toBe("GITHUB_TOKEN");
  });

  test("a meaningful OCTOKIT_AUTH still wins over GITHUB_TOKEN when both are set", async () => {
    process.env.OCTOKIT_AUTH = "real-octokit-auth";
    process.env.GITHUB_TOKEN = "real-github-token";
    const source = await getGitHubTokenSource();
    expect(source).toBe("OCTOKIT_AUTH");
  });
});
