import { describe, expect, test, mock } from "bun:test";
import {
  classifyFindingResolution,
  classifyOutstandingFindings,
  isFileTouched,
  type ChangedFileEntry,
  type ChangedFilesFetcherFn,
} from "./resolution-classifier";
import type { ReviewerDb } from "./db/client";
import type { FindingDisposition } from "./db/schemas/findings-schema";

// Shared disposition-value constants (avoids custom/no-magic-string-duplication
// across the several assertions below that check for the same two values).
const FIXED_BY_CODE_CHANGE: FindingDisposition = "fixed-by-code-change";
const RESOLVED_WITHOUT_CODE_CHANGE: FindingDisposition = "resolved-without-code-change";
const UNKNOWN: FindingDisposition = "unknown";

// ---------------------------------------------------------------------------
// Pure functions
// ---------------------------------------------------------------------------

describe("isFileTouched", () => {
  test("true when the file appears in the changed-files list", () => {
    const changed: ChangedFileEntry[] = [{ filename: "src/a.ts" }, { filename: "src/b.ts" }];
    expect(isFileTouched(changed, "src/b.ts")).toBe(true);
  });

  test("false when the file is absent", () => {
    const changed: ChangedFileEntry[] = [{ filename: "src/a.ts" }];
    expect(isFileTouched(changed, "src/b.ts")).toBe(false);
  });

  test("false on an empty changed-files list", () => {
    expect(isFileTouched([], "src/a.ts")).toBe(false);
  });
});

describe("classifyFindingResolution", () => {
  test("fixed-by-code-change when the file was touched", () => {
    expect(classifyFindingResolution(true)).toBe(FIXED_BY_CODE_CHANGE);
  });

  test("resolved-without-code-change when the file was NOT touched", () => {
    expect(classifyFindingResolution(false)).toBe(RESOLVED_WITHOUT_CODE_CHANGE);
  });
});

// ---------------------------------------------------------------------------
// classifyOutstandingFindings — db double (mirrors review-finalize.test.ts's
// makeFindingsTrackingDb pattern)
// ---------------------------------------------------------------------------

interface FindingRow {
  id: string;
  file: string;
  headSha: string;
}

function makeDb(rows: FindingRow[]) {
  const updateSets: Array<{ disposition: string; ids: string[] }> = [];
  const db = {
    select: mock(() => ({
      from: mock(() => ({
        where: mock(() => Promise.resolve(rows)),
      })),
    })),
    update: mock(() => ({
      set: mock((values: { disposition: string; dispositionSetAt: Date }) => ({
        where: mock((whereClause: { queryChunks?: unknown[] }) => {
          // The `inArray` where-clause shape isn't introspected here — instead
          // each distinct `update().set()` call is recorded once, and the test
          // assertions below key off `values.disposition` plus row counts from
          // the fixture, not the where-clause internals.
          updateSets.push({ disposition: values.disposition, ids: [] });
          void whereClause;
          return Promise.resolve();
        }),
      })),
    })),
  } as unknown as ReviewerDb;
  return { db, updateSets };
}

const PARAMS = {
  prOwner: "edobry",
  prRepo: "minsky",
  prNumber: 2235,
  approvingRound: 3,
  approvingHeadSha: "approve-sha",
};

describe("classifyOutstandingFindings", () => {
  test("no-ops when there are no outstanding rows", async () => {
    const { db, updateSets } = makeDb([]);
    const fetcher: ChangedFilesFetcherFn = mock(async () => []);
    await classifyOutstandingFindings(db, PARAMS, fetcher);
    expect(fetcher).not.toHaveBeenCalled();
    expect(updateSets).toHaveLength(0);
  });

  test("AT1 replay — PR #2235's 'not wired into CI' finding classifies resolved-without-code-change", async () => {
    // Fixture modeled on the mt#3295 corpus sample's PR #2235 incident: a
    // BLOCKING finding citing a CI workflow file that was never touched
    // between the finding's round and the APPROVE round — the reviewer
    // accepted a script-robustness argument instead of a CI-wiring commit.
    const rows: FindingRow[] = [
      {
        id: "f-2235",
        file: ".github/workflows/reviewer-ci.yml",
        headSha: "round1-sha",
      },
    ];
    const { db, updateSets } = makeDb(rows);
    const fetcher: ChangedFilesFetcherFn = mock(async () => [
      // The approving round's diff touched the script itself, but NOT the
      // CI workflow file the finding actually cited.
      { filename: "scripts/verify-something.ts" },
    ]);

    await classifyOutstandingFindings(db, PARAMS, fetcher);

    expect(fetcher).toHaveBeenCalledWith("round1-sha", "approve-sha");
    expect(updateSets).toHaveLength(1);
    expect(updateSets[0]?.disposition).toBe(RESOLVED_WITHOUT_CODE_CHANGE);
  });

  test("AT2 — a normal fixed-by-commit finding classifies fixed-by-code-change", async () => {
    const rows: FindingRow[] = [{ id: "f-fixed", file: "src/foo.ts", headSha: "round1-sha" }];
    const { db, updateSets } = makeDb(rows);
    const fetcher: ChangedFilesFetcherFn = mock(async () => [{ filename: "src/foo.ts" }]);

    await classifyOutstandingFindings(db, PARAMS, fetcher);

    expect(updateSets).toHaveLength(1);
    expect(updateSets[0]?.disposition).toBe(FIXED_BY_CODE_CHANGE);
  });

  test("falls back to unknown when the diff fetch fails", async () => {
    const rows: FindingRow[] = [{ id: "f-1", file: "src/foo.ts", headSha: "round1-sha" }];
    const { db, updateSets } = makeDb(rows);
    const fetcher: ChangedFilesFetcherFn = mock(async () => undefined);

    await classifyOutstandingFindings(db, PARAMS, fetcher);

    expect(updateSets).toHaveLength(1);
    expect(updateSets[0]?.disposition).toBe(UNKNOWN);
  });

  test("falls back to unknown when the diff fetch throws", async () => {
    const rows: FindingRow[] = [{ id: "f-1", file: "src/foo.ts", headSha: "round1-sha" }];
    const { db, updateSets } = makeDb(rows);
    const fetcher: ChangedFilesFetcherFn = mock(async () => {
      throw new Error("network error");
    });

    await classifyOutstandingFindings(db, PARAMS, fetcher);

    expect(updateSets).toHaveLength(1);
    expect(updateSets[0]?.disposition).toBe(UNKNOWN);
  });

  test("groups findings from the same round headSha into a single diff fetch", async () => {
    const rows: FindingRow[] = [
      { id: "f-a", file: "src/a.ts", headSha: "round1-sha" },
      { id: "f-b", file: "src/b.ts", headSha: "round1-sha" },
    ];
    const { db, updateSets } = makeDb(rows);
    const fetcher: ChangedFilesFetcherFn = mock(async () => [{ filename: "src/a.ts" }]);

    await classifyOutstandingFindings(db, PARAMS, fetcher);

    expect(fetcher).toHaveBeenCalledTimes(1);
    const dispositions = updateSets.map((s) => s.disposition);
    expect(dispositions).toContain(FIXED_BY_CODE_CHANGE);
    expect(dispositions).toContain(RESOLVED_WITHOUT_CODE_CHANGE);
  });

  test("makes one diff fetch per distinct headSha across rounds", async () => {
    const rows: FindingRow[] = [
      { id: "f-r1", file: "src/a.ts", headSha: "round1-sha" },
      { id: "f-r2", file: "src/b.ts", headSha: "round2-sha" },
    ];
    const { db, updateSets } = makeDb(rows);
    const fetcher: ChangedFilesFetcherFn = mock(async () => [{ filename: "src/a.ts" }]);

    await classifyOutstandingFindings(db, PARAMS, fetcher);

    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(updateSets).toHaveLength(2);
  });

  test("swallows a query error rather than throwing", async () => {
    const db = {
      select: mock(() => {
        throw new Error("connection refused");
      }),
    } as unknown as ReviewerDb;
    const fetcher: ChangedFilesFetcherFn = mock(async () => []);

    await expect(classifyOutstandingFindings(db, PARAMS, fetcher)).resolves.toBeUndefined();
  });
});
