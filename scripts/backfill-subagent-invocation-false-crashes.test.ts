/**
 * Unit tests for `backfill-subagent-invocation-false-crashes.ts`'s pure logic (mt#3173).
 *
 * Scope note (PR #2745 R1). An earlier revision partitioned the candidate rows
 * around the mt#1770 cutover in TypeScript, and this file tested that partition
 * directly. The cutover bound now lives in SQL (`targetRowsWhere` /
 * `manualTriageRowsWhere`), so those tests were removed rather than retargeted:
 * with the decision made by Postgres, a TypeScript re-implementation of it would
 * assert nothing the shipped code does. The cutover's behaviour is verified
 * end-to-end against prod instead — see the PR body's live runs, including a
 * restore-one-row negative control.
 *
 * What remains here is the logic that still decides something in TypeScript, and
 * that can be exercised without a DB or a patched collaborator:
 *
 *   - `checkScopeMatch` — the dry-run scope-match guard: a matched count far
 *     from the recorded baseline aborts rather than proceeding.
 *   - `parseLimit` / `parseBaseline` — the integer-flag parsers, whose failure
 *     modes are a bounded run silently becoming an unbounded one, and a stale
 *     expectation being silently re-armed.
 */

import { describe, it, expect } from "bun:test";
import {
  checkScopeMatch,
  parseLimit,
  parseBaseline,
  MEASURED_BASELINE,
  FALSE_CRASH_OUTCOME,
  REPLACEMENT_OUTCOME,
} from "./backfill-subagent-invocation-false-crashes";

describe("checkScopeMatch (mt#3173)", () => {
  it("passes on the measured baseline", () => {
    expect(checkScopeMatch(MEASURED_BASELINE).ok).toBe(true);
  });

  it("passes on 0 matched — that is the idempotent re-run, not a divergence", () => {
    const verdict = checkScopeMatch(0);

    expect(verdict.ok).toBe(true);
    expect(verdict.message).toContain("0 rows matched");
  });

  it("aborts when the matched count exceeds the baseline beyond the divergence factor", () => {
    // The mem#622 shape: an operator approved ~15 changes and the dry-run
    // proposed 136. That divergence must stop the run, not be rationalized.
    const verdict = checkScopeMatch(MEASURED_BASELINE * 3);

    expect(verdict.ok).toBe(false);
    expect(verdict.message).toContain("STOP");
    expect(verdict.message).toContain(String(MEASURED_BASELINE * 3));
  });

  it("aborts when the matched count falls far BELOW the baseline", () => {
    // A large undershoot means the population is not what the spec measured —
    // e.g. a partially-applied prior run, or a predicate that stopped matching.
    const verdict = checkScopeMatch(3);

    expect(verdict.ok).toBe(false);
    expect(verdict.message).toContain("STOP");
  });

  it("passes at the edges of the allowed band", () => {
    expect(checkScopeMatch(MEASURED_BASELINE * 2).ok).toBe(true);
    expect(checkScopeMatch(MEASURED_BASELINE / 2).ok).toBe(true);
  });

  it("honours an explicitly supplied baseline and factor", () => {
    expect(checkScopeMatch(20, 10, 2).ok).toBe(true);
    expect(checkScopeMatch(21, 10, 2).ok).toBe(false);
  });
});

describe("parseLimit (mt#3173)", () => {
  it("returns null when --limit is absent (an unbounded run)", () => {
    expect(parseLimit(["--execute"])).toBeNull();
  });

  it("parses a positive integer", () => {
    expect(parseLimit(["--limit", "1", "--execute"])).toBe(1);
    expect(parseLimit(["--execute", "--limit", "25"])).toBe(25);
  });

  it("throws on a missing value rather than silently running unbounded", () => {
    // `--limit` as the last argument: the bounded run the operator asked for
    // must not quietly become a full-population mutation.
    expect(() => parseLimit(["--execute", "--limit"])).toThrow(/integer >= 1/);
  });

  it("throws on a non-numeric value", () => {
    expect(() => parseLimit(["--limit", "all", "--execute"])).toThrow(/integer >= 1/);
  });

  it("throws on zero and on a negative value — neither bounds anything", () => {
    expect(() => parseLimit(["--limit", "0"])).toThrow(/integer >= 1/);
    expect(() => parseLimit(["--limit", "-5"])).toThrow(/integer >= 1/);
  });
});

describe("parseBaseline (mt#3173)", () => {
  it("returns null when absent, so the recorded MEASURED_BASELINE stands", () => {
    expect(parseBaseline(["--execute"])).toBeNull();
  });

  it("parses an operator-stated re-measured count", () => {
    expect(parseBaseline(["--baseline", "3", "--execute"])).toBe(3);
  });

  it("accepts 0 — 'I re-measured and expect none' is a legitimate statement", () => {
    // Unlike --limit, whose 0 bounds nothing, a 0 baseline is meaningful: it is
    // how an operator re-confirms that the sweep is already complete.
    expect(parseBaseline(["--baseline", "0"])).toBe(0);
  });

  it("throws on a missing or non-numeric value rather than defaulting silently", () => {
    // Falling back to MEASURED_BASELINE on a typo would silently re-arm a stale
    // expectation — the opposite of the re-confirmation this flag exists for.
    expect(() => parseBaseline(["--baseline"])).toThrow(/integer >= 0/);
    expect(() => parseBaseline(["--baseline", "many"])).toThrow(/integer >= 0/);
    expect(() => parseBaseline(["--baseline", "-1"])).toThrow(/integer >= 0/);
  });
});

describe("outcome constants (mt#3173)", () => {
  it("retires the false verdict in favour of the mt#1770 pending class", () => {
    expect(FALSE_CRASH_OUTCOME).toBe("crashed-no-output");
    expect(REPLACEMENT_OUTCOME).toBe("pending");
  });
});
