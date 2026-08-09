/**
 * Unit tests for `backfill-subagent-invocation-false-crashes.ts`'s pure logic (mt#3173).
 *
 * Both exercised functions are pure — no DB, no I/O, no patched collaborators:
 *
 *   - `planFalseCrashBackfill` decides which OPEN `crashed-no-output` rows are
 *     the pre-mt#1770 false verdicts (flip to `pending`) versus live
 *     dispatch-recover classifications at or after the cutover (leave alone).
 *   - `checkScopeMatch` is the dry-run scope-match guard: a matched count far
 *     from the recorded baseline aborts rather than proceeding.
 *
 * The row-shape cases the spec's acceptance tests name (closed rows, rows
 * already `pending`, rows carrying a terminal outcome) are excluded by the SQL
 * predicate itself — `outcome = 'crashed-no-output' AND ended_at IS NULL` — so
 * they never reach the planner and cannot be asserted here. Their exclusion is
 * verified against prod instead, by the per-outcome before/after counts recorded
 * in the PR body: only `crashed-no-output` and `pending` move.
 */

import { describe, it, expect } from "bun:test";
import {
  planFalseCrashBackfill,
  checkScopeMatch,
  MT1770_CUTOVER_ISO,
  MEASURED_BASELINE,
  FALSE_CRASH_OUTCOME,
  REPLACEMENT_OUTCOME,
  type FalseCrashCandidateRow,
} from "./backfill-subagent-invocation-false-crashes";

function row(id: string, startedAtIso: string): FalseCrashCandidateRow {
  return { id, startedAt: new Date(startedAtIso) };
}

describe("planFalseCrashBackfill (mt#3173)", () => {
  it("targets a pre-cutover open false-crash row", () => {
    // The real population: every measured target row started before
    // 2026-07-31T21:09:40Z, well under the cutover.
    const plan = planFalseCrashBackfill([row("pre-1", "2026-07-08T20:51:02.475Z")]);

    expect(plan.target.map((r) => r.id)).toEqual(["pre-1"]);
    expect(plan.manualTriage).toEqual([]);
  });

  it("does NOT target a post-cutover row — it may be a live dispatch-recover classification", () => {
    // dispatch-recover writes a real, live-probed `crashed-no-output` onto a
    // still-OPEN row at the 2-attempt-bound escalation path (mt#3149). Flipping
    // it to `pending` would erase a genuine classification.
    const plan = planFalseCrashBackfill([row("post-1", "2026-08-04T12:00:00.000Z")]);

    expect(plan.target).toEqual([]);
    expect(plan.manualTriage.map((r) => r.id)).toEqual(["post-1"]);
  });

  it("splits a mixed batch on the cutover, keeping every row accounted for", () => {
    const rows = [
      row("pre-1", "2026-07-08T20:51:02.475Z"),
      row("post-1", "2026-08-04T12:00:00.000Z"),
      row("pre-2", "2026-07-31T21:09:40.858Z"),
      row("post-2", "2026-08-09T01:00:00.000Z"),
    ];

    const plan = planFalseCrashBackfill(rows);

    expect(plan.target.map((r) => r.id)).toEqual(["pre-1", "pre-2"]);
    expect(plan.manualTriage.map((r) => r.id)).toEqual(["post-1", "post-2"]);
    expect(plan.target.length + plan.manualTriage.length).toBe(rows.length);
  });

  it("treats the cutover instant itself as post-cutover (strictly-before is the target test)", () => {
    const plan = planFalseCrashBackfill([row("boundary", MT1770_CUTOVER_ISO)]);

    expect(plan.target).toEqual([]);
    expect(plan.manualTriage.map((r) => r.id)).toEqual(["boundary"]);
  });

  it("plans nothing from an empty batch (the idempotent re-run case)", () => {
    const plan = planFalseCrashBackfill([]);

    expect(plan.target).toEqual([]);
    expect(plan.manualTriage).toEqual([]);
  });
});

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
});

describe("outcome constants (mt#3173)", () => {
  it("retires the false verdict in favour of the mt#1770 pending class", () => {
    expect(FALSE_CRASH_OUTCOME).toBe("crashed-no-output");
    expect(REPLACEMENT_OUTCOME).toBe("pending");
  });
});
