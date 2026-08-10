/**
 * Unit tests for the mt#3894 no-workspace backfill's pure decision functions.
 *
 * The DB-touching half is exercised live (dry-run + bounded `--execute`) and its output recorded
 * in the PR body; what is worth pinning here is the guard logic that decides whether the sweep
 * is allowed to run at all, since that is what stands between a scoped correction and an
 * unintended bulk mutation.
 */

import { describe, test, expect } from "bun:test";
import {
  checkScopeMatch,
  parseIntFlag,
  MEASURED_BASELINE,
  SCOPE_DIVERGENCE_FACTOR,
  WORKSPACE_DERIVED_OUTCOMES,
  REPLACEMENT_OUTCOME,
} from "./backfill-subagent-invocation-no-workspace";
import { SUBAGENT_INVOCATION_OUTCOME_VALUES } from "@minsky/domain/storage/schemas/subagent-invocations-schema";

describe("checkScopeMatch", () => {
  test("passes at the recorded baseline", () => {
    expect(checkScopeMatch(MEASURED_BASELINE).ok).toBe(true);
  });

  test("treats 0 matched rows as the idempotent re-run, not a divergence", () => {
    const verdict = checkScopeMatch(0);
    expect(verdict.ok).toBe(true);
    expect(verdict.message).toContain("0 rows matched");
  });

  test("aborts when the matched count exceeds the baseline by more than the factor", () => {
    const verdict = checkScopeMatch(MEASURED_BASELINE * SCOPE_DIVERGENCE_FACTOR + 1);
    expect(verdict.ok).toBe(false);
    expect(verdict.message).toContain("STOP");
  });

  test("aborts when the matched count falls far BELOW the baseline too", () => {
    // Under-matching is as much a signal that the population changed as over-matching — it means
    // the predicate no longer selects what the spec measured.
    const verdict = checkScopeMatch(1, 100);
    expect(verdict.ok).toBe(false);
  });

  test("an operator-stated re-measured baseline re-confirms rather than skips the check", () => {
    // `--baseline N` exists so a deliberate re-run states its own expectation; it must still be
    // checked against, not bypassed.
    expect(checkScopeMatch(2, 2).ok).toBe(true);
    expect(checkScopeMatch(50, 2).ok).toBe(false);
  });
});

describe("parseIntFlag", () => {
  test("returns null when the flag is absent", () => {
    expect(parseIntFlag(["--execute"], "--limit", 1)).toBeNull();
  });

  test("parses a well-formed value", () => {
    expect(parseIntFlag(["--limit", "3", "--execute"], "--limit", 1)).toBe(3);
  });

  test("throws on a malformed value rather than silently ignoring it", () => {
    // A typo'd `--limit` that quietly became "no limit" would turn a run intended to be bounded
    // into a full-population mutation — the failure this throw exists to prevent.
    expect(() => parseIntFlag(["--limit", "abc"], "--limit", 1)).toThrow();
    expect(() => parseIntFlag(["--limit"], "--limit", 1)).toThrow();
    expect(() => parseIntFlag(["--limit", "0"], "--limit", 1)).toThrow();
  });

  test("honours a per-flag minimum: --baseline 0 is legitimate", () => {
    expect(parseIntFlag(["--baseline", "0"], "--baseline", 0)).toBe(0);
  });
});

describe("the sweep's target outcomes", () => {
  test("are exactly the enum's values minus `pending` and the replacement", () => {
    // Asserted against the enum rather than a hand-copied list, so adding a member to the enum
    // without deciding whether the sweep covers it fails here instead of silently leaving rows
    // behind.
    const expected = SUBAGENT_INVOCATION_OUTCOME_VALUES.filter(
      (value) => value !== "pending" && value !== REPLACEMENT_OUTCOME
    ).sort();
    expect([...WORKSPACE_DERIVED_OUTCOMES].sort()).toEqual(expected);
  });

  test("does not include the value it writes — otherwise the sweep would not be idempotent", () => {
    expect([...WORKSPACE_DERIVED_OUTCOMES]).not.toContain(REPLACEMENT_OUTCOME);
  });
});
