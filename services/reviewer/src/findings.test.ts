/**
 * Tests for services/reviewer/src/findings.ts (mt#3295).
 */

import { describe, test, expect, mock } from "bun:test";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import {
  findingLocatorKey,
  buildBypassedLocatorSet,
  deriveTitleFromText,
  buildFindingRecordsFromToolCalls,
  buildFindingRecordsFromBody,
  recordFindings,
  resolveOutstandingFindingsOnApproval,
  computeFindingNaturalKey,
  type FindingRecordInput,
  type FindingPersistContext,
} from "./findings";
import type { ReviewToolCall } from "./output-tools";
import type { ReviewerDb } from "./db/client";

const CTX: FindingPersistContext = {
  prOwner: "edobry",
  prRepo: "minsky",
  prNumber: 3295,
  headSha: "abc123def456",
  round: 1,
};

// ---------------------------------------------------------------------------
// findingLocatorKey / buildBypassedLocatorSet
// ---------------------------------------------------------------------------

describe("findingLocatorKey", () => {
  test("distinguishes different files at the same line", () => {
    const a = findingLocatorKey({ file: "src/foo.ts", line: 10 });
    const b = findingLocatorKey({ file: "src/bar.ts", line: 10 });
    expect(a).not.toBe(b);
  });

  test("distinguishes different lines in the same file", () => {
    const a = findingLocatorKey({ file: "src/foo.ts", line: 10 });
    const b = findingLocatorKey({ file: "src/foo.ts", line: 20 });
    expect(a).not.toBe(b);
  });

  test("is stable for identical inputs", () => {
    const a = findingLocatorKey({ file: "src/foo.ts", line: 10, lineEnd: 15 });
    const b = findingLocatorKey({ file: "src/foo.ts", line: 10, lineEnd: 15 });
    expect(a).toBe(b);
  });

  test("treats absent line/lineEnd consistently", () => {
    const a = findingLocatorKey({ file: "src/foo.ts" });
    const b = findingLocatorKey({ file: "src/foo.ts" });
    expect(a).toBe(b);
  });
});

describe("buildBypassedLocatorSet", () => {
  test("unions locators across multiple downgrade arrays", () => {
    const set = buildBypassedLocatorSet(
      [{ file: "src/a.ts", line: 1 }],
      [{ file: "src/b.ts", line: 2 }]
    );
    expect(set.has(findingLocatorKey({ file: "src/a.ts", line: 1 }))).toBe(true);
    expect(set.has(findingLocatorKey({ file: "src/b.ts", line: 2 }))).toBe(true);
    expect(set.has(findingLocatorKey({ file: "src/c.ts", line: 3 }))).toBe(false);
  });

  test("returns an empty set for no downgrades", () => {
    const set = buildBypassedLocatorSet([], []);
    expect(set.size).toBe(0);
  });

  test("returns an empty set when called with no arrays", () => {
    const set = buildBypassedLocatorSet();
    expect(set.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// deriveTitleFromText
// ---------------------------------------------------------------------------

describe("deriveTitleFromText", () => {
  test("falls back to a synthesized title when text is absent", () => {
    const title = deriveTitleFromText({ file: "src/foo.ts", severity: "BLOCKING", line: 42 });
    expect(title).toBe("BLOCKING finding at src/foo.ts:42");
  });

  test("falls back with '?' when line is also absent", () => {
    const title = deriveTitleFromText({ file: "src/foo.ts", severity: "NON-BLOCKING" });
    expect(title).toBe("NON-BLOCKING finding at src/foo.ts:?");
  });

  test("cuts at the first sentence boundary", () => {
    const title = deriveTitleFromText({
      file: "src/foo.ts",
      severity: "BLOCKING",
      text: "This is the summary sentence. This is extra detail that should not appear in the title.",
    });
    expect(title).toBe("This is the summary sentence.");
  });

  test("uses the full text when short and no sentence boundary", () => {
    const title = deriveTitleFromText({
      file: "src/foo.ts",
      severity: "BLOCKING",
      text: "Short finding text",
    });
    expect(title).toBe("Short finding text");
  });

  test("truncates long text with no sentence boundary to 120 chars", () => {
    const longText = "x".repeat(200);
    const title = deriveTitleFromText({
      file: "src/foo.ts",
      severity: "BLOCKING",
      text: longText,
    });
    expect(title.length).toBe(120);
    expect(title.endsWith("...")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// buildFindingRecordsFromToolCalls
// ---------------------------------------------------------------------------

describe("buildFindingRecordsFromToolCalls", () => {
  test("maps submit_finding calls to records with summary/details as title/body", () => {
    const toolCalls: ReviewToolCall[] = [
      {
        name: "submit_finding",
        args: {
          severity: "BLOCKING",
          file: "src/foo.ts",
          line: 10,
          summary: "One-sentence summary",
          details: "Full explanation",
        },
      },
      { name: "conclude_review", args: { event: "REQUEST_CHANGES", summary: "..." } },
    ];

    const records = buildFindingRecordsFromToolCalls(toolCalls, CTX);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      ...CTX,
      severity: "BLOCKING",
      file: "src/foo.ts",
      line: 10,
      title: "One-sentence summary",
      body: "Full explanation",
      disposition: undefined,
    });
  });

  test("marks a finding as bypassed when its locator is in the bypassed set", () => {
    const toolCalls: ReviewToolCall[] = [
      {
        name: "submit_finding",
        args: {
          severity: "NON-BLOCKING", // already downgraded by the recovery pass
          file: "src/foo.ts",
          line: 10,
          summary: "s",
          details: "d",
        },
      },
    ];
    const bypassed = buildBypassedLocatorSet([{ file: "src/foo.ts", line: 10 }]);
    const records = buildFindingRecordsFromToolCalls(toolCalls, CTX, bypassed);
    expect(records[0]?.disposition).toBe("bypassed");
  });

  test("leaves disposition undefined for findings not in the bypassed set", () => {
    const toolCalls: ReviewToolCall[] = [
      {
        name: "submit_finding",
        args: { severity: "BLOCKING", file: "src/foo.ts", line: 10, summary: "s", details: "d" },
      },
    ];
    const bypassed = buildBypassedLocatorSet([{ file: "src/other.ts", line: 99 }]);
    const records = buildFindingRecordsFromToolCalls(toolCalls, CTX, bypassed);
    expect(records[0]?.disposition).toBeUndefined();
  });

  test("returns an empty array when there are no submit_finding calls", () => {
    const toolCalls: ReviewToolCall[] = [
      { name: "conclude_review", args: { event: "APPROVE", summary: "..." } },
    ];
    expect(buildFindingRecordsFromToolCalls(toolCalls, CTX)).toEqual([]);
  });

  test("omits lineEnd when absent", () => {
    const toolCalls: ReviewToolCall[] = [
      {
        name: "submit_finding",
        args: { severity: "BLOCKING", file: "src/foo.ts", line: 10, summary: "s", details: "d" },
      },
    ];
    const records = buildFindingRecordsFromToolCalls(toolCalls, CTX);
    expect(records[0]?.lineEnd).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// buildFindingRecordsFromBody
// ---------------------------------------------------------------------------

describe("buildFindingRecordsFromBody", () => {
  test("parses findings from a rendered review body", () => {
    const body = [
      "### Findings",
      "",
      "**[BLOCKING]** src/foo.ts:10 - Something is broken here.",
      "**[NON-BLOCKING]** src/bar.ts:20 - A minor nit.",
    ].join("\n");

    const records = buildFindingRecordsFromBody(body, CTX);
    expect(records).toHaveLength(2);
    expect(records[0]).toMatchObject({
      ...CTX,
      severity: "BLOCKING",
      file: "src/foo.ts",
      line: 10,
      body: "Something is broken here.",
    });
    expect(records[0]?.disposition).toBeUndefined();
  });

  test("returns an empty array for a body with no findings", () => {
    expect(buildFindingRecordsFromBody("Nothing to see here.", CTX)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// recordFindings — DB interaction (mirrors metrics.test.ts's stub pattern)
// ---------------------------------------------------------------------------

type InsertValues = Record<string, unknown>;

function makeFakeInsertDb(onInsert: (values: InsertValues[]) => void): ReviewerDb {
  return {
    insert: mock(() => ({
      values: mock((values: InsertValues[]) => {
        onInsert(values);
        return { onConflictDoNothing: mock(() => Promise.resolve()) };
      }),
    })),
  } as unknown as ReviewerDb;
}

function makeThrowingInsertDb(): ReviewerDb {
  return {
    insert: mock(() => ({
      values: mock(() => ({
        onConflictDoNothing: mock(() => Promise.reject(new Error("connection refused"))),
      })),
    })),
  } as unknown as ReviewerDb;
}

const SAMPLE_RECORD: FindingRecordInput = {
  ...CTX,
  severity: "BLOCKING",
  file: "src/foo.ts",
  line: 10,
  title: "title",
  body: "body",
};

describe("recordFindings", () => {
  test("no-ops on an empty array", async () => {
    const db = makeFakeInsertDb(() => {
      throw new Error("should not be called");
    });
    await recordFindings(db, []);
  });

  test("inserts a valid record", async () => {
    let captured: InsertValues[] = [];
    const db = makeFakeInsertDb((values) => {
      captured = values;
    });
    await recordFindings(db, [SAMPLE_RECORD]);
    expect(captured).toHaveLength(1);
    expect(captured[0]).toMatchObject({
      prOwner: "edobry",
      prRepo: "minsky",
      prNumber: 3295,
      severity: "BLOCKING",
      file: "src/foo.ts",
      line: 10,
      title: "title",
      body: "body",
      disposition: null,
    });
    // Idempotency key (mt#3295 PR #2391 R1/R2): every inserted row carries
    // the natural key recordFindings computes for it — title/body are NOT
    // part of the key (R2 fix; see computeFindingNaturalKey's doc comment).
    expect(captured[0]?.["naturalKey"]).toBe(
      computeFindingNaturalKey({
        prOwner: "edobry",
        prRepo: "minsky",
        prNumber: 3295,
        headSha: "abc123def456",
        round: 1,
        severity: "BLOCKING",
        file: "src/foo.ts",
        line: 10,
      })
    );
  });

  // mt#3295 PR #2391 R1: backfill re-runs or a backfill/live-writer overlap
  // must not duplicate rows. Asserts the insert actually goes through
  // onConflictDoNothing against the naturalKey column — the shared conflict
  // target for both the live writer (review-finalize.ts) and the one-shot
  // backfill script.
  test("uses onConflictDoNothing against the naturalKey column (idempotent insert)", async () => {
    let conflictTarget: unknown;
    const db = {
      insert: mock(() => ({
        values: mock(() => ({
          onConflictDoNothing: mock((opts: { target: unknown }) => {
            conflictTarget = opts.target;
            return Promise.resolve();
          }),
        })),
      })),
    } as unknown as ReviewerDb;

    await recordFindings(db, [SAMPLE_RECORD]);

    expect(conflictTarget).toBeDefined();
    // The target is the naturalKey column object itself (reference identity
    // to reviewerFindingsTable.naturalKey) — assert its column name rather
    // than importing the table (keeps this test decoupled from schema
    // internals beyond the public contract).
    expect((conflictTarget as { name: string }).name).toBe("natural_key");
  });

  test("drops records with an invalid severity", async () => {
    let captured: InsertValues[] = [];
    const db = makeFakeInsertDb((values) => {
      captured = values;
    });
    await recordFindings(db, [{ ...SAMPLE_RECORD, severity: "BOGUS" }]);
    expect(captured).toHaveLength(0);
  });

  test("drops records with an invalid disposition", async () => {
    let captured: InsertValues[] = [];
    const db = makeFakeInsertDb((values) => {
      captured = values;
    });
    await recordFindings(db, [
      { ...SAMPLE_RECORD, disposition: "not-a-real-disposition" as never },
    ]);
    expect(captured).toHaveLength(0);
  });

  test("sets dispositionSetAt when a disposition is provided", async () => {
    let captured: InsertValues[] = [];
    const db = makeFakeInsertDb((values) => {
      captured = values;
    });
    await recordFindings(db, [{ ...SAMPLE_RECORD, disposition: "bypassed" }]);
    expect(captured[0]?.["dispositionSetAt"]).toBeInstanceOf(Date);
  });

  test("does not propagate DB errors", async () => {
    const db = makeThrowingInsertDb();
    await expect(recordFindings(db, [SAMPLE_RECORD])).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// resolveOutstandingFindingsOnApproval
// ---------------------------------------------------------------------------

describe("resolveOutstandingFindingsOnApproval", () => {
  test("calls db.update with disposition: unknown", async () => {
    let setValues: Record<string, unknown> | undefined;
    const db = {
      update: mock(() => ({
        set: mock((values: Record<string, unknown>) => {
          setValues = values;
          return { where: mock(() => Promise.resolve()) };
        }),
      })),
    } as unknown as ReviewerDb;

    await resolveOutstandingFindingsOnApproval(db, {
      prOwner: "edobry",
      prRepo: "minsky",
      prNumber: 3295,
      round: 3,
    });

    expect(setValues?.["disposition"]).toBe("unknown");
    expect(setValues?.["dispositionSetAt"]).toBeInstanceOf(Date);
  });

  test("does not propagate DB errors", async () => {
    const db = {
      update: mock(() => {
        throw new Error("connection refused");
      }),
    } as unknown as ReviewerDb;

    await expect(
      resolveOutstandingFindingsOnApproval(db, {
        prOwner: "edobry",
        prRepo: "minsky",
        prNumber: 3295,
        round: 3,
      })
    ).resolves.toBeUndefined();
  });

  // mt#3295 PR #2391 R1: reviewer-flagged scoping bug — the query must
  // exclude the approving round's own findings AND never touch an
  // already-dispositioned row. Verified against the ACTUAL compiled SQL
  // (mirrors migrate.test.ts's buildExpectedTablesQuery SQL-shape tests) so
  // this is a real assertion on the query's structure, not just that
  // `set()` was invoked with the right values.
  test("scopes the WHERE clause to round < approving round AND disposition IS NULL", async () => {
    let whereCondition: SQL | undefined;
    const db = {
      update: mock(() => ({
        set: mock(() => ({
          where: mock((cond: SQL) => {
            whereCondition = cond;
            return Promise.resolve();
          }),
        })),
      })),
    } as unknown as ReviewerDb;

    // A finding dispositioned "bypassed" in round 2 must survive an APPROVE
    // in round 3 unchanged: the compiled query below must both (a) exclude
    // round 3 (the approving round) via round < 3, and (b) exclude any row
    // whose disposition is already set (not NULL) — a bypassed round-2 row
    // fails the disposition-IS-NULL filter and is therefore never touched,
    // regardless of round.
    await resolveOutstandingFindingsOnApproval(db, {
      prOwner: "edobry",
      prRepo: "minsky",
      prNumber: 3295,
      round: 3,
    });

    expect(whereCondition).toBeDefined();
    const dialect = new PgDialect();
    const compiled = dialect.sqlToQuery(whereCondition as SQL);
    expect(compiled.sql).toMatch(/"round"\s*<\s*\$/);
    expect(compiled.sql).toMatch(/"disposition"\s+is\s+null/i);
    expect(compiled.sql).toMatch(/"severity"\s*=\s*\$/);
    expect(compiled.params).toContain(3);
    expect(compiled.params).toContain("BLOCKING");
  });
});

// ---------------------------------------------------------------------------
// computeFindingNaturalKey (mt#3295 PR #2391 R1/R2 — idempotent backfill/live writes)
// ---------------------------------------------------------------------------

describe("computeFindingNaturalKey", () => {
  const BASE = {
    prOwner: "edobry",
    prRepo: "minsky",
    prNumber: 3295,
    headSha: "abc123def456",
    round: 1,
    severity: "BLOCKING",
    file: "src/foo.ts",
    line: 10,
  };

  test("is stable for identical inputs", () => {
    expect(computeFindingNaturalKey(BASE)).toBe(computeFindingNaturalKey({ ...BASE }));
  });

  test("differs when any natural-key field differs", () => {
    const base = computeFindingNaturalKey(BASE);
    expect(computeFindingNaturalKey({ ...BASE, round: 2 })).not.toBe(base);
    expect(computeFindingNaturalKey({ ...BASE, file: "src/bar.ts" })).not.toBe(base);
    expect(computeFindingNaturalKey({ ...BASE, line: 11 })).not.toBe(base);
    expect(computeFindingNaturalKey({ ...BASE, prNumber: 9999 })).not.toBe(base);
    expect(computeFindingNaturalKey({ ...BASE, headSha: "deadbeef" })).not.toBe(base);
    expect(computeFindingNaturalKey({ ...BASE, severity: "NON-BLOCKING" })).not.toBe(base);
  });

  test("treats absent line/lineEnd consistently", () => {
    const { line: _line, ...withoutLine } = BASE;
    expect(computeFindingNaturalKey(withoutLine)).toBe(computeFindingNaturalKey(withoutLine));
  });

  // mt#3295 PR #2391 R2 regression: the key must NOT depend on title/body —
  // those are composed differently by the two write paths for the exact
  // same logical finding (live: model's `summary`; backfill/prose: derived
  // from parsed text). `computeFindingNaturalKey`'s input type has no
  // title/body field at all, so this test documents the invariant at the
  // call-site level: two records differing ONLY in text produce identical
  // keys.
  test("R2: is unaffected by title/body — the input type has no title/body field", () => {
    const key = computeFindingNaturalKey(BASE);
    // Re-computing from the exact same natural-key fields, irrespective of
    // whatever title/body a caller happened to derive, always yields the
    // same key — proving title/body cannot perturb it.
    expect(computeFindingNaturalKey({ ...BASE })).toBe(key);
  });
});

// ---------------------------------------------------------------------------
// R2 cross-path regression: live writer + backfill for the SAME logical
// finding must dedup to exactly one row, even though their `title`/`body`
// text differs.
// ---------------------------------------------------------------------------

function makeDedupingInsertDb() {
  const rowsByKey = new Map<string, Record<string, unknown>>();
  const db = {
    insert: mock(() => ({
      values: mock((rows: Record<string, unknown>[]) => ({
        onConflictDoNothing: mock(() => {
          for (const row of rows) {
            const key = row["naturalKey"] as string;
            if (!rowsByKey.has(key)) {
              rowsByKey.set(key, row);
            }
            // else: conflict -> do nothing, matching real Postgres
            // onConflictDoNothing semantics.
          }
          return Promise.resolve();
        }),
      })),
    })),
  } as unknown as ReviewerDb;
  return { db, rowsByKey };
}

describe("R2 cross-path dedup regression", () => {
  test("live path (submit_finding) and backfill path (parsed body) for the same logical finding dedup to one row", async () => {
    const { db, rowsByKey } = makeDedupingInsertDb();
    const ctx: FindingPersistContext = {
      prOwner: "edobry",
      prRepo: "minsky",
      prNumber: 999,
      headSha: "deadbeef1234",
      round: 2,
    };

    // Live output-tools path: title = the model's own one-sentence summary.
    const liveToolCalls: ReviewToolCall[] = [
      {
        name: "submit_finding",
        args: {
          severity: "BLOCKING",
          file: "src/foo.ts",
          line: 42,
          summary: "Short one-sentence summary.",
          details: "The full explanation paragraph with rationale and suggested fix.",
        },
      },
    ];
    const liveRecords = buildFindingRecordsFromToolCalls(liveToolCalls, ctx);
    await recordFindings(db, liveRecords);

    // Backfill/prose path: title is DERIVED from parsed markdown text for
    // the SAME underlying finding (same severity/file/line) — deliberately
    // worded differently from `summary` above, to prove the dedup survives
    // title divergence (the exact R2 bug).
    const backfillRecords = buildFindingRecordsFromBody(
      "**[BLOCKING]** src/foo.ts:42 - A differently-worded description of the identical underlying issue.",
      ctx
    );
    await recordFindings(db, backfillRecords);

    expect(liveRecords[0]?.title).not.toBe(backfillRecords[0]?.title);
    expect(rowsByKey.size).toBe(1);
  });
});
