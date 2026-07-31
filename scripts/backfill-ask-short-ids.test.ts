/**
 * Unit tests for `backfill-ask-short-ids.ts`'s pure planning logic (mt#2965).
 *
 * `planBackfillAssignments` is exercised directly — no DB, no I/O — covering:
 *   - sequential `ask#N` assignment ordered by createdAt ascending
 *   - idempotent skip of rows that already carry a short_id
 *   - continuing the sequence after the highest already-assigned number
 *     (so a backfill run never collides with ids minted by create() between
 *     migration-deploy and the backfill run)
 */

import { describe, it, expect } from "bun:test";
import { planBackfillAssignments, type BackfillCandidateRow } from "./backfill-ask-short-ids";

function row(id: string, createdAt: string, shortId: string | null = null): BackfillCandidateRow {
  return { id, shortId, createdAt };
}

describe("planBackfillAssignments (mt#2965)", () => {
  it("assigns ask#1, ask#2, ... in createdAt-ascending order", () => {
    const rows = [
      row("uuid-c", "2026-01-03T00:00:00.000Z"),
      row("uuid-a", "2026-01-01T00:00:00.000Z"),
      row("uuid-b", "2026-01-02T00:00:00.000Z"),
    ];

    const plan = planBackfillAssignments(rows);

    expect(plan.total).toBe(3);
    expect(plan.alreadyAssigned).toBe(0);
    expect(plan.assignments).toEqual([
      { id: "uuid-a", shortId: "ask#1" },
      { id: "uuid-b", shortId: "ask#2" },
      { id: "uuid-c", shortId: "ask#3" },
    ]);
  });

  it("is idempotent: rows that already have a short_id are skipped, not reassigned", () => {
    const rows = [
      row("uuid-a", "2026-01-01T00:00:00.000Z", "ask#1"),
      row("uuid-b", "2026-01-02T00:00:00.000Z", null),
    ];

    const plan = planBackfillAssignments(rows);

    expect(plan.total).toBe(2);
    expect(plan.alreadyAssigned).toBe(1);
    // Only the missing row is planned; the already-assigned row is untouched
    // and does not appear in `assignments` at all.
    expect(plan.assignments).toEqual([{ id: "uuid-b", shortId: "ask#2" }]);
  });

  it("continues the sequence after the highest already-assigned ask#N, not from 1", () => {
    // Simulates: asks created via mint-on-create (mt#2965) after migration
    // deploy but before this backfill ran — the backfill must not reissue
    // ask#1..ask#5.
    const rows = [
      row("uuid-old", "2026-01-01T00:00:00.000Z", null),
      row("uuid-new-1", "2026-02-01T00:00:00.000Z", "ask#5"),
      row("uuid-new-2", "2026-02-02T00:00:00.000Z", "ask#6"),
    ];

    const plan = planBackfillAssignments(rows);

    expect(plan.alreadyAssigned).toBe(2);
    expect(plan.assignments).toEqual([{ id: "uuid-old", shortId: "ask#7" }]);
  });

  it("returns an empty plan when every row already has a short_id", () => {
    const rows = [
      row("uuid-a", "2026-01-01T00:00:00.000Z", "ask#1"),
      row("uuid-b", "2026-01-02T00:00:00.000Z", "ask#2"),
    ];

    const plan = planBackfillAssignments(rows);

    expect(plan.assignments).toEqual([]);
    expect(plan.alreadyAssigned).toBe(2);
    expect(plan.total).toBe(2);
  });

  it("returns an empty plan for an empty table", () => {
    const plan = planBackfillAssignments([]);
    expect(plan).toEqual({ assignments: [], alreadyAssigned: 0, total: 0 });
  });

  it("handles a malformed createdAt by sorting it last rather than crashing", () => {
    const rows = [row("uuid-good", "2026-01-01T00:00:00.000Z"), row("uuid-bad", "not-a-date")];

    const plan = planBackfillAssignments(rows);

    expect(plan.assignments.map((a) => a.id)).toEqual(["uuid-good", "uuid-bad"]);
  });

  it("produces distinct, monotonically increasing short ids within one batch", () => {
    const rows = Array.from({ length: 10 }, (_, i) =>
      row(`uuid-${i}`, new Date(2026, 0, i + 1).toISOString())
    );

    const plan = planBackfillAssignments(rows);

    const shortIds = plan.assignments.map((a) => a.shortId);
    expect(new Set(shortIds).size).toBe(shortIds.length);
    expect(shortIds).toEqual(Array.from({ length: 10 }, (_, i) => `ask#${i + 1}`));
  });
});
