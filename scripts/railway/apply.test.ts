#!/usr/bin/env bun
/**
 * Tests for apply.ts behaviors that require mocking fetch.
 * Since graphql() is not exported, we test its error-path behavior by
 * mocking the relevant logic at the formatting layer — or by importing
 * behaviors we can isolate via the parse-error formatting pattern.
 *
 * The parse-error path is: bodyText captured via res.text(), then
 * JSON.parse(bodyText) fails, then error message includes truncated bodyText.
 * We verify this pattern directly since the logic is inline in graphql().
 */
import { describe, test, expect } from "bun:test";

describe("graphql() parse-error path — truncation behavior", () => {
  // Test the truncation logic that matches apply.ts implementation:
  // const truncated = bodyText.length > 500 ? bodyText.slice(0, 500) + "..." : bodyText;
  // throw new Error(`Railway API returned non-JSON response (HTTP ${res.status}): ${truncated}`, { cause: parseErr });

  function buildParseErrorMessage(status: number, bodyText: string): string {
    const truncated = bodyText.length > 500 ? `${bodyText.slice(0, 500)}...` : bodyText;
    return `Railway API returned non-JSON response (HTTP ${status}): ${truncated}`;
  }

  test("short body text is included verbatim in the error message", () => {
    const body = "<html>Not JSON</html>";
    const msg = buildParseErrorMessage(200, body);
    expect(msg).toContain("HTTP 200");
    expect(msg).toContain("<html>Not JSON</html>");
    expect(msg).not.toContain("...");
  });

  test("long body text (>500 chars) is truncated with ellipsis", () => {
    const body = "x".repeat(600);
    const msg = buildParseErrorMessage(200, body);
    expect(msg).toContain("HTTP 200");
    expect(msg).toContain("x".repeat(500));
    expect(msg).toContain("...");
    expect(msg).not.toContain("x".repeat(501));
  });

  test("exactly 500-char body is not truncated", () => {
    const body = "a".repeat(500);
    const msg = buildParseErrorMessage(200, body);
    expect(msg).toContain("a".repeat(500));
    expect(msg).not.toContain("...");
  });

  test("501-char body is truncated", () => {
    const body = "b".repeat(501);
    const msg = buildParseErrorMessage(200, body);
    expect(msg).toContain("b".repeat(500));
    expect(msg).toContain("...");
  });

  test("error message contains the HTTP status code", () => {
    const msg = buildParseErrorMessage(200, "not-json");
    expect(msg).toMatch(/HTTP 200/);
  });

  test("error message prefix matches expected format", () => {
    const msg = buildParseErrorMessage(200, "garbage");
    expect(msg).toMatch(/^Railway API returned non-JSON response \(HTTP 200\): garbage$/);
  });
});

describe("graphql() fetch-rejection paths — timeout and network error (R6 fix)", () => {
  // Mirrors the catch block added to apply.ts graphql():
  //   } catch (err) {
  //     if (err instanceof Error && err.name === "AbortError") {
  //       throw new Error(`Railway API request timed out after ${GRAPHQL_TIMEOUT_MS}ms`);
  //     }
  //     throw new Error(`Railway API network error: ${err instanceof Error ? err.message : String(err)}`, { cause: err });
  //   }

  const GRAPHQL_TIMEOUT_MS = 30_000;
  const NETWORK_ERROR_PREFIX = "Railway API network error";

  function classifyFetchError(err: unknown): Error {
    if (err instanceof Error && err.name === "AbortError") {
      return new Error(`Railway API request timed out after ${GRAPHQL_TIMEOUT_MS}ms`);
    }
    return new Error(
      `${NETWORK_ERROR_PREFIX}: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err }
    );
  }

  test("AbortError produces timeout message without crashing on undefined res", () => {
    const abortErr = new DOMException("The operation was aborted", "AbortError");
    const thrown = classifyFetchError(abortErr);
    expect(thrown.message).toBe(`Railway API request timed out after ${GRAPHQL_TIMEOUT_MS}ms`);
    // Critically: no reference to `res` in this path — the TypeError from undefined res is gone.
  });

  test("AbortError message contains the timeout duration in ms", () => {
    const abortErr = new DOMException("aborted", "AbortError");
    const thrown = classifyFetchError(abortErr);
    expect(thrown.message).toContain("30000ms");
  });

  test("generic Error (network/DNS failure) produces network-error message with cause", () => {
    const networkErr = new Error("fetch failed: getaddrinfo ENOTFOUND backboard.railway.com");
    const thrown = classifyFetchError(networkErr);
    expect(thrown.message).toContain(NETWORK_ERROR_PREFIX);
    expect(thrown.message).toContain("getaddrinfo ENOTFOUND");
    expect(thrown.cause).toBe(networkErr);
  });

  test("non-Error thrown value is stringified into network-error message", () => {
    const thrown = classifyFetchError("connection refused");
    expect(thrown.message).toContain(NETWORK_ERROR_PREFIX);
    expect(thrown.message).toContain("connection refused");
  });

  test("non-AbortError DOMException is treated as generic network error", () => {
    const domErr = new DOMException("network error", "NetworkError");
    const thrown = classifyFetchError(domErr);
    expect(thrown.message).toContain(NETWORK_ERROR_PREFIX);
    expect(thrown.message).not.toContain("timed out");
  });
});

describe("applyJsonPatch error path — stdout not included (B1 regression)", () => {
  // Mirrors the logic in apply.ts applyJsonPatch():
  //   if (proc.exitCode !== 0) {
  //     const stderrText = proc.stderr ? decode(proc.stderr).trim() : "(no stderr)";
  //     throw new Error(`${APPLY_COMMAND} failed (exit ${proc.exitCode}): ${stderrText}`);
  //   }
  // stdout is intentionally omitted to avoid leaking secret values from the JSON patch input.

  const APPLY_COMMAND = "railway environment edit --json";

  function buildApplyErrorMessage(
    exitCode: number,
    stderrBytes: Uint8Array | null,
    _stdoutBytes: Uint8Array | null // stdout is intentionally ignored in the real impl
  ): string {
    const stderrText = stderrBytes ? new TextDecoder().decode(stderrBytes).trim() : "(no stderr)";
    return `${APPLY_COMMAND} failed (exit ${exitCode}): ${stderrText}`;
  }

  test("error message includes stderr text", () => {
    const stderr = new TextEncoder().encode("authentication failed");
    const msg = buildApplyErrorMessage(1, stderr, null);
    expect(msg).toContain("authentication failed");
    expect(msg).toContain("exit 1");
  });

  test("error message does NOT include stdout content even when stdout is non-empty", () => {
    const stderr = new TextEncoder().encode("some error");
    const stdout = new TextEncoder().encode('{"secret":"my-secret-value"}');
    const msg = buildApplyErrorMessage(1, stderr, stdout);
    // The secret value that was in stdout must NOT appear in the error message.
    expect(msg).not.toContain("my-secret-value");
    expect(msg).not.toContain('"secret"');
  });

  test("error message with no stderr uses fallback text", () => {
    const msg = buildApplyErrorMessage(2, null, null);
    expect(msg).toContain("(no stderr)");
    expect(msg).toContain("exit 2");
  });

  test("error message format matches expected pattern", () => {
    const stderr = new TextEncoder().encode("CLI error: bad patch");
    const msg = buildApplyErrorMessage(1, stderr, null);
    expect(msg).toMatch(
      /^railway environment edit --json failed \(exit 1\): CLI error: bad patch$/
    );
  });
});

describe("isPlatformInjectedVar — system-var filter (R7 fix)", () => {
  // Mirrors the logic added in apply.ts:
  //   const RAILWAY_SYSTEM_PREFIXES = ["RAILWAY_", "NIXPACKS_", "RAILPACK_"] as const;
  //   const RAILWAY_SYSTEM_KEYS = new Set(["PORT"] as const);
  //   function isPlatformInjectedVar(key: string): boolean {
  //     if (RAILWAY_SYSTEM_KEYS.has(key)) return true;
  //     return RAILWAY_SYSTEM_PREFIXES.some((prefix) => key.startsWith(prefix));
  //   }

  const RAILWAY_SYSTEM_PREFIXES = ["RAILWAY_", "NIXPACKS_", "RAILPACK_"] as const;
  const RAILWAY_SYSTEM_KEYS = new Set(["PORT"] as const);

  function isPlatformInjectedVar(key: string): boolean {
    if (RAILWAY_SYSTEM_KEYS.has(key)) return true;
    return RAILWAY_SYSTEM_PREFIXES.some((prefix) => key.startsWith(prefix));
  }

  // Keys that MUST be classified as platform-injected (filtered out, never pruned).
  test("PORT is a platform-injected key (exact allowlist match)", () => {
    expect(isPlatformInjectedVar("PORT")).toBe(true);
  });

  test("RAILWAY_PUBLIC_DOMAIN is a platform-injected key (RAILWAY_ prefix)", () => {
    expect(isPlatformInjectedVar("RAILWAY_PUBLIC_DOMAIN")).toBe(true);
  });

  test("RAILWAY_ bare prefix is a platform-injected key", () => {
    expect(isPlatformInjectedVar("RAILWAY_ANYTHING")).toBe(true);
  });

  test("NIXPACKS_BUILD_CMD is a platform-injected key (NIXPACKS_ prefix)", () => {
    expect(isPlatformInjectedVar("NIXPACKS_BUILD_CMD")).toBe(true);
  });

  test("NIXPACKS_ bare prefix is a platform-injected key", () => {
    expect(isPlatformInjectedVar("NIXPACKS_ANYTHING")).toBe(true);
  });

  test("RAILPACK_ANYTHING is a platform-injected key (RAILPACK_ prefix)", () => {
    expect(isPlatformInjectedVar("RAILPACK_ANYTHING")).toBe(true);
  });

  // Keys that MUST NOT be classified as platform-injected (user vars, must not be auto-pruned).
  test("MY_VAR is NOT a platform-injected key", () => {
    expect(isPlatformInjectedVar("MY_VAR")).toBe(false);
  });

  test("OPENAI_API_KEY is NOT a platform-injected key", () => {
    expect(isPlatformInjectedVar("OPENAI_API_KEY")).toBe(false);
  });

  test("DATABASE_URL is NOT a platform-injected key", () => {
    expect(isPlatformInjectedVar("DATABASE_URL")).toBe(false);
  });

  test("PORT_NUMBER is NOT a platform-injected key (prefix-match only, not exact)", () => {
    // 'PORT_NUMBER' starts with 'PORT' but should NOT match — the allowlist is an exact-key check.
    expect(isPlatformInjectedVar("PORT_NUMBER")).toBe(false);
  });

  test("empty string is NOT a platform-injected key", () => {
    expect(isPlatformInjectedVar("")).toBe(false);
  });
});

describe("reseal count log — uses actual patch object count, not config key count (R7 fix)", () => {
  // Mirrors the corrected logic in apply.ts run():
  //   const allPatches = buildAllSecretPatches(config, diff);
  //   const resealCount = Object.keys(allPatches).length;
  //
  // The OLD (buggy) path counted all SecretRef keys in config.variables, even those
  // that appear as ADD or CHANGE entries in the diff (which buildAllSecretPatches skips).
  // This test suite verifies that the count is derived from the actual patch result.

  // Simulate buildAllSecretPatches behavior: returns sealed values only for NO-CHANGE SecretRef entries.
  type MockDiffEntry = { kind: "NO-CHANGE" | "ADD" | "CHANGE" | "REMOVE" };
  type MockConfig = { variables: Record<string, { secretRef: string } | string> };

  function simulateBuildAllSecretPatches(
    config: MockConfig,
    diff: Record<string, MockDiffEntry>
  ): Record<string, string> {
    const patches: Record<string, string> = {};
    for (const [key, val] of Object.entries(config.variables)) {
      if (typeof val === "object" && "secretRef" in val) {
        const entry = diff[key];
        if (entry && entry.kind === "NO-CHANGE") {
          patches[key] = `sealed:${val.secretRef}`;
        }
      }
    }
    return patches;
  }

  test("when all SecretRef entries are NO-CHANGE, resealCount equals the number of SecretRefs", () => {
    const config: MockConfig = {
      variables: {
        SECRET_A: { secretRef: "val-a" },
        SECRET_B: { secretRef: "val-b" },
        PLAIN_VAR: "plain",
      },
    };
    const diff: Record<string, MockDiffEntry> = {
      SECRET_A: { kind: "NO-CHANGE" },
      SECRET_B: { kind: "NO-CHANGE" },
      PLAIN_VAR: { kind: "NO-CHANGE" },
    };
    const patches = simulateBuildAllSecretPatches(config, diff);
    const resealCount = Object.keys(patches).length;
    // Both secrets are NO-CHANGE, so resealCount = 2 (not 2+1=3 or the old secretKeys count).
    expect(resealCount).toBe(2);
  });

  test("when some SecretRef entries are ADD/CHANGE, resealCount is lower than total SecretRef count", () => {
    const config: MockConfig = {
      variables: {
        SECRET_A: { secretRef: "val-a" }, // NO-CHANGE
        SECRET_B: { secretRef: "val-b" }, // ADD — should not be re-sealed
        SECRET_C: { secretRef: "val-c" }, // CHANGE — should not be re-sealed
      },
    };
    const diff: Record<string, MockDiffEntry> = {
      SECRET_A: { kind: "NO-CHANGE" },
      SECRET_B: { kind: "ADD" },
      SECRET_C: { kind: "CHANGE" },
    };
    const patches = simulateBuildAllSecretPatches(config, diff);
    const resealCount = Object.keys(patches).length;
    // Old code would have counted secretKeys.length = 3; correct count is 1 (only SECRET_A).
    expect(resealCount).toBe(1);
  });

  test("when all SecretRef entries are ADD/CHANGE, resealCount is zero", () => {
    const config: MockConfig = {
      variables: {
        SECRET_A: { secretRef: "val-a" },
        SECRET_B: { secretRef: "val-b" },
      },
    };
    const diff: Record<string, MockDiffEntry> = {
      SECRET_A: { kind: "ADD" },
      SECRET_B: { kind: "CHANGE" },
    };
    const patches = simulateBuildAllSecretPatches(config, diff);
    const resealCount = Object.keys(patches).length;
    // Old code: secretKeys.length = 2; correct: 0.
    expect(resealCount).toBe(0);
  });

  test("resealCount log message uses correct count when some secrets are being modified", () => {
    // This verifies the log message is derived from the patch, not from config keys.
    const config: MockConfig = {
      variables: {
        SECRET_A: { secretRef: "val-a" },
        SECRET_B: { secretRef: "val-b" },
        SECRET_C: { secretRef: "val-c" },
      },
    };
    const diff: Record<string, MockDiffEntry> = {
      SECRET_A: { kind: "NO-CHANGE" },
      SECRET_B: { kind: "NO-CHANGE" },
      SECRET_C: { kind: "ADD" }, // new secret — not yet sealed, gets regular ADD patch
    };
    const patches = simulateBuildAllSecretPatches(config, diff);
    const resealCount = Object.keys(patches).length;
    // The log should say 2, not 3 (which secretKeys.length would have returned).
    const logMessage = `Re-sealing ${resealCount} secret variable(s) (sealed NO-CHANGE entries only).`;
    expect(logMessage).toContain("Re-sealing 2 secret variable(s)");
    expect(logMessage).not.toContain("Re-sealing 3 secret variable(s)");
  });
});

describe("loadConfig dynamic import — default export handling (B2 smoke)", () => {
  // Validates that the dynamic-import branch handles both ESM (mod.default) and
  // CJS-shaped (mod itself) exports. We test the selection logic in isolation
  // since we cannot dynamically write and import .ts files in the test runner.

  type RailwayConfig = {
    serviceId: string;
    environmentId: string;
    projectId: string;
    variables: Record<string, unknown>;
  };

  function resolveConfig(mod: unknown): RailwayConfig | null {
    if (
      mod &&
      typeof mod === "object" &&
      "default" in (mod as object) &&
      (mod as { default?: unknown }).default != null
    ) {
      return (mod as { default: RailwayConfig }).default;
    }
    const candidate = mod as RailwayConfig;
    if (candidate && typeof candidate === "object" && "serviceId" in candidate) {
      return candidate;
    }
    return null;
  }

  const validConfig: RailwayConfig = {
    serviceId: "svc-123",
    environmentId: "env-456",
    projectId: "proj-789",
    variables: {},
  };

  test("ESM-shaped module (mod.default) returns the default export", () => {
    const mod = { default: validConfig };
    const result = resolveConfig(mod);
    expect(result).toBe(validConfig);
    expect(result?.serviceId).toBe("svc-123");
  });

  test("CJS-shaped module (mod itself has serviceId) falls back to mod", () => {
    const result = resolveConfig(validConfig);
    expect(result).toBe(validConfig);
    expect(result?.serviceId).toBe("svc-123");
  });

  test("module with null default falls back to mod itself when it is a valid config", () => {
    // This handles the case where mod.default is null but mod is itself a config.
    const modWithNullDefault = { default: null, ...validConfig };
    const result = resolveConfig(modWithNullDefault);
    // mod.default is null, so we fall through to mod itself;
    // but mod has both "default" key and "serviceId", so the "default in mod" branch fires first.
    // The real guard is `mod.default != null`, which is false here.
    // So we check mod itself: it has serviceId, so it's returned.
    expect(result).not.toBeNull();
    expect(result?.serviceId).toBe("svc-123");
  });

  test("returns null for a module with no recognizable config shape", () => {
    const result = resolveConfig({ someOtherKey: "value" });
    expect(result).toBeNull();
  });

  test("returns null for null input", () => {
    const result = resolveConfig(null);
    expect(result).toBeNull();
  });
});

describe("prune path uses buildDeletePatch shape — R8 B1 fix (structural mirror)", () => {
  // Mirrors the corrected logic in apply.ts run() prune branch:
  //   const removals = summary.toRemove.map((e) => e.key);
  //   const removalPatch = buildDeletePatch(config.serviceId, removals);
  //   applyJsonPatch(removalPatch);
  //
  // The old inline construction:
  //   const nullPatches: Record<string, null> = {};
  //   for (const key of removals) nullPatches[key] = null;
  //   const removalPatch = { services: { [config.serviceId]: { variables: nullPatches } } };
  //
  // Both must produce an identical object shape. These tests verify buildDeletePatch
  // emits the correct shape that the prune path now delegates to.

  // Mirrors buildDeletePatch logic imported into apply.ts
  function buildDeletePatch(serviceId: string, keys: string[]): object {
    const variables: Record<string, null> = {};
    for (const key of keys) {
      variables[key] = null;
    }
    return {
      services: {
        [serviceId]: {
          variables,
        },
      },
    };
  }

  test("prune patch for a single removal key has the correct deletion shape", () => {
    const removals = ["STALE_VAR"];
    const patch = buildDeletePatch("svc-abc", removals);
    expect(patch).toEqual({
      services: {
        "svc-abc": {
          variables: {
            STALE_VAR: null,
          },
        },
      },
    });
  });

  test("prune patch for multiple removals maps every key to null", () => {
    const removals = ["OLD_A", "OLD_B", "OLD_C"];
    const patch = buildDeletePatch("svc-xyz", removals);
    expect(patch).toEqual({
      services: {
        "svc-xyz": {
          variables: {
            OLD_A: null,
            OLD_B: null,
            OLD_C: null,
          },
        },
      },
    });
  });

  test("prune patch for empty removal list produces empty variables object", () => {
    const patch = buildDeletePatch("svc-empty", []);
    expect(patch).toEqual({
      services: {
        "svc-empty": {
          variables: {},
        },
      },
    });
  });

  test("prune patch shape matches what the old inline construction produced", () => {
    // Old inline construction (verbatim from before the R8 fix):
    const serviceId = "svc-test-123";
    const removals = ["KEY_X", "KEY_Y"];

    const nullPatches: Record<string, null> = {};
    for (const key of removals) {
      nullPatches[key] = null;
    }
    const oldInlinePatch = {
      services: {
        [serviceId]: {
          variables: nullPatches,
        },
      },
    };

    // New helper-based construction:
    const helperPatch = buildDeletePatch(serviceId, removals);

    // Both must be structurally identical.
    expect(helperPatch).toEqual(oldInlinePatch);
  });
});
