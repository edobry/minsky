/**
 * Tests for services/reviewer/src/metrics.ts
 *
 * Verifies:
 * - Happy path: INSERT is called with the correct payload
 * - Error swallow: recorder errors do NOT propagate to callers
 * - Payload correctness: all 8 columns are passed to the insert
 */

import { describe, test, expect, mock } from "bun:test";
import { recordConvergenceMetric, type ConvergenceMetricInput } from "./metrics";
import type { ReviewerDb } from "./db/client";

// ---------------------------------------------------------------------------
// Column name constants — avoids magic-string duplication warnings.
// ---------------------------------------------------------------------------

const COL_PR_OWNER = "prOwner";
const COL_PR_REPO = "prRepo";
const COL_PR_NUMBER = "prNumber";
const COL_HEAD_SHA = "headSha";
const COL_ITERATION_INDEX = "iterationIndex";
const COL_PRIOR_BLOCKER_COUNT = "priorBlockerCount";
const COL_NEW_BLOCKER_COUNT = "newBlockerCount";
const COL_ACKNOWLEDGED_COUNT = "acknowledgedAddressedCount";

// ---------------------------------------------------------------------------
// Minimal fake DB that records insert calls.
// Uses a simple function tracker to avoid pulling in drizzle at test time.
// ---------------------------------------------------------------------------

type InsertValues = Record<string, unknown>;

function makeInsertChain(onInsert: (values: InsertValues) => void) {
  return {
    values: mock((values: InsertValues) => {
      onInsert(values);
      return Promise.resolve();
    }),
  };
}

function makeFakeDb(onInsert: (values: InsertValues) => void): ReviewerDb {
  return {
    insert: mock(() => makeInsertChain(onInsert)),
  } as unknown as ReviewerDb;
}

function makeThrowingDb(errorMessage: string): ReviewerDb {
  return {
    insert: mock(() => ({
      values: mock(() => Promise.reject(new Error(errorMessage))),
    })),
  } as unknown as ReviewerDb;
}

// ---------------------------------------------------------------------------
// Shared test input
// ---------------------------------------------------------------------------

const SAMPLE_INPUT: ConvergenceMetricInput = {
  prOwner: "edobry",
  prRepo: "minsky",
  prNumber: 769,
  headSha: "abc123def456",
  iterationIndex: 2,
  priorBlockerCount: 3,
  newBlockerCount: 1,
  acknowledgedAddressedCount: 2,
};

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

describe("recordConvergenceMetric - happy path", () => {
  test("calls db.insert and passes all 8 column values correctly", async () => {
    const captured: InsertValues[] = [];
    const db = makeFakeDb((values) => captured.push(values));

    await recordConvergenceMetric(db, SAMPLE_INPUT);

    expect(captured).toHaveLength(1);
    const row = captured[0];
    if (row === undefined) throw new Error("expected a captured row");
    expect(row[COL_PR_OWNER]).toBe("edobry");
    expect(row[COL_PR_REPO]).toBe("minsky");
    expect(row[COL_PR_NUMBER]).toBe(769);
    expect(row[COL_HEAD_SHA]).toBe("abc123def456");
    expect(row[COL_ITERATION_INDEX]).toBe(2);
    expect(row[COL_PRIOR_BLOCKER_COUNT]).toBe(3);
    expect(row[COL_NEW_BLOCKER_COUNT]).toBe(1);
    expect(row[COL_ACKNOWLEDGED_COUNT]).toBe(2);
  });

  test("resolves without returning a value (void)", async () => {
    const db = makeFakeDb(() => {});
    const result = await recordConvergenceMetric(db, SAMPLE_INPUT);
    expect(result).toBeUndefined();
  });

  test("passes zeroed counts correctly (first iteration with no prior reviews)", async () => {
    const captured: InsertValues[] = [];
    const db = makeFakeDb((values) => captured.push(values));

    const firstIterInput: ConvergenceMetricInput = {
      ...SAMPLE_INPUT,
      iterationIndex: 1,
      priorBlockerCount: 0,
      acknowledgedAddressedCount: 0,
    };

    await recordConvergenceMetric(db, firstIterInput);

    expect(captured).toHaveLength(1);
    const row = captured[0];
    if (row === undefined) throw new Error("expected a captured row");
    expect(row[COL_ITERATION_INDEX]).toBe(1);
    expect(row[COL_PRIOR_BLOCKER_COUNT]).toBe(0);
    expect(row[COL_ACKNOWLEDGED_COUNT]).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Error swallow
// ---------------------------------------------------------------------------

describe("recordConvergenceMetric - error swallow", () => {
  test("does NOT propagate DB errors to the caller", async () => {
    const db = makeThrowingDb("connection refused");

    // Must not throw — the metric write is best-effort
    await expect(recordConvergenceMetric(db, SAMPLE_INPUT)).resolves.toBeUndefined();
  });

  test("does NOT propagate non-Error DB rejections", async () => {
    const throwingDb = {
      insert: mock(() => ({
        values: mock(() => Promise.reject(new Error("string-rejection"))),
      })),
    } as unknown as ReviewerDb;

    await expect(recordConvergenceMetric(throwingDb, SAMPLE_INPUT)).resolves.toBeUndefined();
  });

  test("does NOT propagate synchronous insert() errors", async () => {
    const throwingDb = {
      insert: mock(() => {
        throw new Error("sync insert error");
      }),
    } as unknown as ReviewerDb;

    await expect(recordConvergenceMetric(throwingDb, SAMPLE_INPUT)).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Payload correctness — all column names match the schema
// ---------------------------------------------------------------------------

describe("recordConvergenceMetric - payload column names", () => {
  test("insert payload uses camelCase keys matching schema $inferInsert type", async () => {
    const captured: InsertValues[] = [];
    const db = makeFakeDb((values) => captured.push(values));

    await recordConvergenceMetric(db, SAMPLE_INPUT);

    const row = captured[0];
    if (row === undefined) throw new Error("expected a captured row");

    // Verify the exact keys passed to .values() — these must match the
    // ConvergenceMetricInsert type inferred from the Drizzle schema.
    const keys = Object.keys(row).sort();
    expect(keys).toEqual([
      COL_ACKNOWLEDGED_COUNT,
      COL_HEAD_SHA,
      COL_ITERATION_INDEX,
      COL_NEW_BLOCKER_COUNT,
      COL_PR_NUMBER,
      COL_PR_OWNER,
      COL_PR_REPO,
      COL_PRIOR_BLOCKER_COUNT,
    ]);
  });
});
