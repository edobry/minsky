/**
 * Unit tests for the config.doctor reviewer-retrigger reachability check (mt#2660).
 *
 * checkReviewerRetriggerReachability is exported as a pure function (config
 * token in, diagnostic out) specifically so this behavior is testable without
 * mocking the config-provider module loader (getConfigurationProvider's
 * dynamic import inside config.doctor's execute handler).
 */
import { describe, test, expect } from "bun:test";
import { checkReviewerRetriggerReachability } from "./validate-doctor-commands";

describe("checkReviewerRetriggerReachability", () => {
  test("token absent → warning naming mcp.auth.token / MINSKY_MCP_AUTH_TOKEN", () => {
    const result = checkReviewerRetriggerReachability(undefined);

    expect(result.check).toBe("Reviewer Retrigger Reachability");
    expect(result.status).toBe("warning");
    expect(result.message).toContain("mcp.auth.token");
    expect(result.suggestion).toContain("MINSKY_MCP_AUTH_TOKEN");
  });

  test("token present → pass", () => {
    const result = checkReviewerRetriggerReachability("some-token-value");

    expect(result.check).toBe("Reviewer Retrigger Reachability");
    expect(result.status).toBe("pass");
    expect(result.message).toContain("reachable");
  });

  test("empty-string token is treated as absent (falsy) → warning", () => {
    const result = checkReviewerRetriggerReachability("");

    expect(result.status).toBe("warning");
  });
});
