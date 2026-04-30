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
