/**
 * The two PRE-MODEL SKIP timing shapes (mt#2088; config fingerprint mt#4556).
 *
 * Sibling of `unrecovered-timing.test.ts`, which covers the third shape. These
 * two write sites — routing-skip and concurrent-inflight — sat as inline
 * literals inside `runReview`, which the reviewer suite's no-`mock.module`
 * convention cannot drive end-to-end, so nothing observed what they wrote.
 * mt#4556 extracted them into `buildSkipPathTiming`; this is the test that
 * extraction exists for.
 *
 * Task acceptance test 5, for the two skip sites: each carries a non-null
 * fingerprint even though neither has model output to derive anything from.
 */

import { describe, test, expect } from "bun:test";
import { buildSkipPathTiming } from "./review-timing";
import { RECOVERY_FLAG_ENV_VARS } from "./config-fingerprint";

function envAllOff(overrides: Record<string, string | undefined> = {}) {
  const base: Record<string, string | undefined> = {};
  for (const [, envVar] of RECOVERY_FLAG_ENV_VARS) base[envVar] = "false";
  base.REVIEWER_TOOLLOOP_RETRY_ON_TIMEOUT = "true";
  return { ...base, ...overrides };
}

const CONFIG = {
  provider: "openai",
  providerModel: "gpt-5",
  tier2Enabled: false,
} as const;

function skipRow(overrides: Partial<Parameters<typeof buildSkipPathTiming>[0]> = {}) {
  return buildSkipPathTiming({
    prOwner: "edobry",
    prRepo: "minsky",
    prNumber: 4556,
    headSha: "abc1234",
    totalWallClockMs: 42,
    scopeClassification: "trivial",
    config: CONFIG,
    env: envAllOff(),
    ...overrides,
  });
}

describe("buildSkipPathTiming (mt#2088 / mt#4556)", () => {
  test("AT5: carries a non-null config fingerprint with no model output to derive from", () => {
    const row = skipRow();
    expect(row.configFingerprint).toBeTruthy();
    expect(row.configFingerprint).toContain("model=gpt-5");
    expect(row.configFingerprint).toContain("provider=openai");
  });

  test("records effort=none — the path returns before the model is reached", () => {
    expect(skipRow().configFingerprint).toContain("effort=none");
  });

  test("the configuration dimensions are recorded even though no review ran", () => {
    const row = skipRow({ config: { ...CONFIG, tier2Enabled: true } });
    expect(row.configFingerprint).toContain("tier2=on");
  });

  test("a flag flip is visible on a skipped review too", () => {
    const off = skipRow().configFingerprint;
    const on = skipRow({
      env: envAllOff({ REVIEWER_DIFF_SCOPE_BOUNDED_ENABLED: "on" }),
    }).configFingerprint;

    expect(on).not.toBe(off);
    expect(off).toContain("diff_scope_bounded=off");
    expect(on).toContain("diff_scope_bounded=on");
  });

  test("iteration index is 0 and token fields are absent, so they persist as NULL", () => {
    const row = skipRow();
    // mem#800: index-0 rows carry no token data and must be excluded from every
    // cost split. Zeroes would understate spend rather than being absent.
    expect(row.iterationIndex).toBe(0);
    expect(row.inputTokens).toBeUndefined();
    expect(row.outputTokens).toBeUndefined();
    expect(row.costUsd).toBeUndefined();
  });

  test("both skip sites produce the same shape — they were byte-identical literals", () => {
    // Routing-skip and concurrent-inflight differ only in their caller's
    // arguments; the extraction is only correct if the row is a pure function
    // of those. Same arguments, same row.
    expect(skipRow()).toEqual(skipRow());
  });

  test("carries the caller's identifying fields through unchanged", () => {
    const row = skipRow();
    expect(row.prOwner).toBe("edobry");
    expect(row.prRepo).toBe("minsky");
    expect(row.prNumber).toBe(4556);
    expect(row.headSha).toBe("abc1234");
    expect(row.totalWallClockMs).toBe(42);
    expect(row.scopeClassification).toBe("trivial");
    expect(row.toolUseActive).toBe(false);
  });
});
