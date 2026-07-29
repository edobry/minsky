/**
 * Tests for services/reviewer/src/findings.ts (mt#3295).
 */

import { describe, test, expect, mock } from "bun:test";
import {
  findingLocatorKey,
  buildBypassedLocatorSet,
  deriveTitleFromText,
  buildFindingRecordsFromToolCalls,
  buildFindingRecordsFromBody,
  recordFindings,
  resolveOutstandingFindingsOnApproval,
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
        return Promise.resolve();
      }),
    })),
  } as unknown as ReviewerDb;
}

function makeThrowingInsertDb(): ReviewerDb {
  return {
    insert: mock(() => ({
      values: mock(() => Promise.reject(new Error("connection refused"))),
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
      })
    ).resolves.toBeUndefined();
  });
});
