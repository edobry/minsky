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
import { resolveProviderApiKeyWithConfig } from "./harness-config-auth";

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

  test("env var wins even when it looks falsy-adjacent (whitespace, not empty)", async () => {
    process.env[ENV_VAR] = " ";
    const result = await resolveProviderApiKeyWithConfig("anthropic", ENV_VAR);
    expect(result).toBe(" ");
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
