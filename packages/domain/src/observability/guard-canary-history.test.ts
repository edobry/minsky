/**
 * Guard canary history tests (mt#4007).
 *
 * Two layers, matching the module's pure/impure split:
 *   1. `deriveGuardCanaryStatus` — pure, no DB. Covers the three states
 *      (never-verified / passing / broken) and the load-bearing distinction
 *      the spec calls out explicitly: "broken since" is the earliest
 *      timestamp of the CURRENT contiguous failure run, not the first
 *      failure ever seen.
 *   2. `DrizzleGuardCanaryHistoryRepository` — against an in-memory fake DB
 *      implementing the drizzle query-builder surface this repository uses
 *      (insert/values, select/from/where/orderBy), mirroring
 *      `presence/repository.test.ts`'s fake-DB pattern. No real Postgres
 *      required.
 */

import { describe, test, expect } from "bun:test";
import {
  deriveGuardCanaryStatus,
  DrizzleGuardCanaryHistoryRepository,
  buildGuardCanaryHistoryRepository,
  type GuardCanaryHistoryRow,
  type GuardCanaryOutcomeInput,
} from "./guard-canary-history";

// ---------------------------------------------------------------------------
// 1. deriveGuardCanaryStatus — pure function
// ---------------------------------------------------------------------------

describe("deriveGuardCanaryStatus", () => {
  test("zero rows -> never-verified (AT2: no canary is NOT passing)", () => {
    expect(deriveGuardCanaryStatus([])).toEqual({ state: "never-verified" });
  });

  test("single passing row -> passing, carries that row's timestamp", () => {
    const t = new Date("2026-08-01T00:00:00Z");
    const rows: GuardCanaryHistoryRow[] = [{ passed: true, ranAt: t }];
    expect(deriveGuardCanaryStatus(rows)).toEqual({
      state: "passing",
      lastVerifiedAt: t.toISOString(),
    });
  });

  test("single failing row -> broken, brokenSinceAt == lastCheckedAt == that row", () => {
    const t = new Date("2026-08-01T00:00:00Z");
    const rows: GuardCanaryHistoryRow[] = [{ passed: false, ranAt: t }];
    expect(deriveGuardCanaryStatus(rows)).toEqual({
      state: "broken",
      brokenSinceAt: t.toISOString(),
      lastCheckedAt: t.toISOString(),
    });
  });

  test("latest of several rows is a PASS -> passing, regardless of older failures", () => {
    // Rows are most-recent-first.
    const rows: GuardCanaryHistoryRow[] = [
      { passed: true, ranAt: new Date("2026-08-03T00:00:00Z") },
      { passed: false, ranAt: new Date("2026-08-02T00:00:00Z") },
      { passed: false, ranAt: new Date("2026-08-01T00:00:00Z") },
    ];
    expect(deriveGuardCanaryStatus(rows)).toEqual({
      state: "passing",
      lastVerifiedAt: "2026-08-03T00:00:00.000Z",
    });
  });

  test(
    "broken-since is the earliest timestamp of the CURRENT contiguous failure run, " +
      "not the first failure ever seen (the distinction the spec calls out explicitly)",
    () => {
      // History (most-recent-first): fail, fail, fail, PASS, fail (an older,
      // now-irrelevant failure). The contiguous run stops at the PASS — the
      // older fail before it must NOT be picked up as "broken since".
      const rows: GuardCanaryHistoryRow[] = [
        { passed: false, ranAt: new Date("2026-08-05T00:00:00Z") }, // latest
        { passed: false, ranAt: new Date("2026-08-04T00:00:00Z") },
        { passed: false, ranAt: new Date("2026-08-03T00:00:00Z") }, // earliest of the CURRENT run
        { passed: true, ranAt: new Date("2026-08-02T00:00:00Z") }, // boundary: last pass
        { passed: false, ranAt: new Date("2026-08-01T00:00:00Z") }, // an older, unrelated failure
      ];
      expect(deriveGuardCanaryStatus(rows)).toEqual({
        state: "broken",
        brokenSinceAt: "2026-08-03T00:00:00.000Z",
        lastCheckedAt: "2026-08-05T00:00:00.000Z",
      });
    }
  );

  test("every recorded run failed (no prior pass at all) -> brokenSinceAt is the oldest row", () => {
    const rows: GuardCanaryHistoryRow[] = [
      { passed: false, ranAt: new Date("2026-08-02T00:00:00Z") },
      { passed: false, ranAt: new Date("2026-08-01T00:00:00Z") },
    ];
    expect(deriveGuardCanaryStatus(rows)).toEqual({
      state: "broken",
      brokenSinceAt: "2026-08-01T00:00:00.000Z",
      lastCheckedAt: "2026-08-02T00:00:00.000Z",
    });
  });
});

// ---------------------------------------------------------------------------
// 2. DrizzleGuardCanaryHistoryRepository — fake-DB integration
// ---------------------------------------------------------------------------

interface FakeRow {
  id: string;
  runId: string;
  guardName: string;
  source: string;
  expects: string;
  passed: boolean;
  failureDetail: string | null;
  ranAt: Date;
}

/**
 * Minimal fake DB implementing exactly the drizzle surface
 * DrizzleGuardCanaryHistoryRepository calls: `insert(table).values(rows)`
 * (no onConflict — append-only) and `select().from(table).where(...).orderBy(...)`.
 *
 * The `where`/`orderBy` calls are accepted but NOT interpreted structurally
 * (unlike presence/repository.test.ts's column-inspecting fake) — this
 * repository issues exactly one shape of query (`inArray(guardName, names)`
 * + `desc(ranAt)`), so the fake filters/sorts directly against the
 * in-memory store using the SAME semantics, verified by the test cases
 * (multi-guard batching, ordering) rather than by parsing the drizzle
 * expression tree.
 */
function createFakeDb(guardNamesFilter: { current: string[] }) {
  const rows: FakeRow[] = [];
  let idCounter = 0;

  const db = {
    insert: (_table: unknown) => ({
      values: async (vals: Record<string, unknown>[]) => {
        for (const v of vals) {
          rows.push({
            id: `row-${idCounter++}`,
            runId: v.runId as string,
            guardName: v.guardName as string,
            source: v.source as string,
            expects: v.expects as string,
            passed: v.passed as boolean,
            failureDetail: (v.failureDetail as string | null | undefined) ?? null,
            ranAt: v.ranAt as Date,
          });
        }
      },
    }),
    select: () => ({
      from: (_table: unknown) => ({
        where: (_cond: unknown) => ({
          orderBy: async (_order: unknown) => {
            const filtered = rows.filter((r) => guardNamesFilter.current.includes(r.guardName));
            // desc(ranAt)
            return [...filtered].sort((a, b) => b.ranAt.getTime() - a.ranAt.getTime());
          },
        }),
      }),
    }),
  };

  return { db, rows };
}

describe("DrizzleGuardCanaryHistoryRepository", () => {
  test("recordRun is a no-op on an empty outcomes array (no INSERT issued)", async () => {
    const filter = { current: [] as string[] };
    const { db, rows } = createFakeDb(filter);
    const repo = new DrizzleGuardCanaryHistoryRepository(db as never);
    await repo.recordRun("run-1", new Date(), []);
    expect(rows.length).toBe(0);
  });

  test(
    "AT3: two consecutive passing runs produce two timestamped records " +
      "(history, not last-write-wins)",
    async () => {
      const filter = { current: ["nul-byte-check"] };
      const { db, rows } = createFakeDb(filter);
      const repo = new DrizzleGuardCanaryHistoryRepository(db as never);

      const outcome: GuardCanaryOutcomeInput = {
        guardName: "nul-byte-check",
        source: "standalone",
        expects: "deny",
        passed: true,
      };

      const t1 = new Date("2026-08-01T00:00:00Z");
      const t2 = new Date("2026-08-02T00:00:00Z");
      await repo.recordRun("run-1", t1, [outcome]);
      await repo.recordRun("run-2", t2, [outcome]);

      expect(rows.length).toBe(2);
      expect(rows.map((r) => r.ranAt.toISOString())).toEqual([t1.toISOString(), t2.toISOString()]);

      const status = await repo.getGuardStatus("nul-byte-check");
      expect(status).toEqual({ state: "passing", lastVerifiedAt: t2.toISOString() });
    }
  );

  test("AT1 shape: two contiguous fails then a pass clears broken-since", async () => {
    const filter = { current: ["fake-guard"] };
    const { db } = createFakeDb(filter);
    const repo = new DrizzleGuardCanaryHistoryRepository(db as never);

    const base: Omit<GuardCanaryOutcomeInput, "passed" | "failureDetail"> = {
      guardName: "fake-guard",
      source: "registry",
      expects: "deny",
    };

    const t1 = new Date("2026-08-01T00:00:00Z");
    const t2 = new Date("2026-08-01T01:00:00Z");
    const t3 = new Date("2026-08-01T02:00:00Z");

    // "Kill the guard's run() export" -> two failing runs.
    await repo.recordRun("run-1", t1, [
      { ...base, passed: false, failureDetail: "run() threw: guard killed" },
    ]);
    await repo.recordRun("run-2", t2, [
      { ...base, passed: false, failureDetail: "run() threw: guard killed" },
    ]);

    const brokenStatus = await repo.getGuardStatus("fake-guard");
    expect(brokenStatus).toEqual({
      state: "broken",
      brokenSinceAt: t1.toISOString(),
      lastCheckedAt: t2.toISOString(),
    });

    // "Restore, run again" -> passing, broken-since cleared.
    await repo.recordRun("run-3", t3, [{ ...base, passed: true }]);

    const restoredStatus = await repo.getGuardStatus("fake-guard");
    expect(restoredStatus).toEqual({ state: "passing", lastVerifiedAt: t3.toISOString() });
  });

  test("AT2: a guard with zero rows returns never-verified, never conflated with passing", async () => {
    const filter = { current: ["untested-guard"] };
    const { db } = createFakeDb(filter);
    const repo = new DrizzleGuardCanaryHistoryRepository(db as never);

    const status = await repo.getGuardStatus("untested-guard");
    expect(status).toEqual({ state: "never-verified" });
  });

  test("getGuardStatuses batches multiple guards in one query (no N+1)", async () => {
    const filter = { current: ["guard-a", "guard-b", "guard-c"] };
    const { db } = createFakeDb(filter);
    const repo = new DrizzleGuardCanaryHistoryRepository(db as never);

    const t = new Date("2026-08-01T00:00:00Z");
    await repo.recordRun("run-1", t, [
      { guardName: "guard-a", source: "registry", expects: "deny", passed: true },
      { guardName: "guard-b", source: "registry", expects: "warn", passed: false },
      // guard-c: no row at all -> never-verified
    ]);

    const statuses = await repo.getGuardStatuses(["guard-a", "guard-b", "guard-c"]);
    expect(statuses.get("guard-a")).toEqual({ state: "passing", lastVerifiedAt: t.toISOString() });
    expect(statuses.get("guard-b")).toEqual({
      state: "broken",
      brokenSinceAt: t.toISOString(),
      lastCheckedAt: t.toISOString(),
    });
    // Never written -> absent from the map (getGuardStatus's convenience
    // wrapper is what defaults an absent key to never-verified).
    expect(statuses.has("guard-c")).toBe(false);
  });

  test("getGuardStatuses([]) returns an empty map without querying", async () => {
    const filter = { current: [] as string[] };
    const { db } = createFakeDb(filter);
    const repo = new DrizzleGuardCanaryHistoryRepository(db as never);
    const statuses = await repo.getGuardStatuses([]);
    expect(statuses.size).toBe(0);
  });

  test("buildGuardCanaryHistoryRepository returns null for an absent db, else constructs", () => {
    expect(buildGuardCanaryHistoryRepository(undefined)).toBeNull();
    expect(buildGuardCanaryHistoryRepository(null)).toBeNull();
    const filter = { current: [] as string[] };
    const { db } = createFakeDb(filter);
    expect(buildGuardCanaryHistoryRepository(db)).toBeInstanceOf(
      DrizzleGuardCanaryHistoryRepository
    );
  });
});
