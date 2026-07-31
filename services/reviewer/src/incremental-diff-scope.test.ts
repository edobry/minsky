/**
 * Tests for incremental diff-since-last-review scope resolution (mt#3471).
 *
 * The branch table these cover is the whole safety argument for the feature:
 * exactly one branch narrows the review, and every other branch — including
 * every failure — must hand back the full PR diff untouched. A bug that
 * narrowed on a wrong branch would silently shrink what the reviewer sees,
 * which no downstream check would catch.
 */

import { describe, test, expect, mock } from "bun:test";
import { resolveDiffScope } from "./incremental-diff-scope";
import type { PrFileEntry, IncrementalDiffResult } from "./github-client";

const FULL_DIFF = [
  "diff --git a/src/a.ts b/src/a.ts",
  "--- a/src/a.ts",
  "+++ b/src/a.ts",
  "@@ -1,2 +1,3 @@",
  "+full-pr change",
  "diff --git a/src/b.ts b/src/b.ts",
  "--- a/src/b.ts",
  "+++ b/src/b.ts",
  "@@ -1,2 +1,3 @@",
  "+another full-pr change",
].join("\n");

const FULL_FILE_ENTRIES: PrFileEntry[] = [
  { filename: "src/a.ts", status: "modified", additions: 1, deletions: 0 },
  { filename: "src/b.ts", status: "modified", additions: 1, deletions: 0 },
];

const INCREMENTAL_DIFF = [
  "diff --git a/src/b.ts b/src/b.ts",
  "--- a/src/b.ts",
  "+++ b/src/b.ts",
  "@@ -1,2 +1,3 @@",
  "+only the newest commit",
].join("\n");

const INCREMENTAL_RESULT: IncrementalDiffResult = {
  diff: INCREMENTAL_DIFF,
  fileEntries: [{ filename: "src/b.ts", status: "modified", additions: 1, deletions: 0 }],
};

function baseInput(overrides: Partial<Parameters<typeof resolveDiffScope>[0]> = {}) {
  return {
    enabled: true,
    priorReviewCommitId: "base-sha",
    headSha: "head-sha",
    fullDiff: FULL_DIFF,
    fullFileEntries: FULL_FILE_ENTRIES,
    fetchIncremental: mock(async (): Promise<IncrementalDiffResult | undefined> => undefined),
    prNumber: 42,
    ...overrides,
  };
}

describe("resolveDiffScope (mt#3471)", () => {
  test("narrows to the incremental diff when the range resolves", async () => {
    const fetchIncremental = mock(async () => INCREMENTAL_RESULT);

    const result = await resolveDiffScope(baseInput({ fetchIncremental }));

    expect(result.source).toBe("incremental");
    expect(result.diff).toBe(INCREMENTAL_DIFF);
    expect(result.fileEntries).toHaveLength(1);
    expect(result.fileEntries[0]?.filename).toBe("src/b.ts");
  });

  test("narrowing actually reduces what the round is shown", async () => {
    // The point of the feature: the narrowed diff is materially smaller than the
    // full one. Asserting source alone would pass even if the branch returned
    // the full diff under an "incremental" label.
    const fetchIncremental = mock(async () => INCREMENTAL_RESULT);

    const result = await resolveDiffScope(baseInput({ fetchIncremental }));

    expect(result.diff.length).toBeLessThan(FULL_DIFF.length);
    expect(result.fileEntries.length).toBeLessThan(FULL_FILE_ENTRIES.length);
  });

  test("passes the prior review's commit_id as the compare base", async () => {
    const fetchIncremental = mock(async () => INCREMENTAL_RESULT);

    await resolveDiffScope(
      baseInput({ fetchIncremental, priorReviewCommitId: "abc123", headSha: "def456" })
    );

    expect(fetchIncremental).toHaveBeenCalledWith("abc123", "def456");
  });

  test("uses the full diff and does not call the API when the flag is off", async () => {
    const fetchIncremental = mock(async () => INCREMENTAL_RESULT);

    const result = await resolveDiffScope(baseInput({ enabled: false, fetchIncremental }));

    expect(result.source).toBe("full");
    expect(result.diff).toBe(FULL_DIFF);
    expect(result.fileEntries).toEqual(FULL_FILE_ENTRIES);
    expect(fetchIncremental).not.toHaveBeenCalled();
  });

  test("uses the full diff on R1, when there is no prior review to scope against", async () => {
    const fetchIncremental = mock(async () => INCREMENTAL_RESULT);

    const result = await resolveDiffScope(
      baseInput({ priorReviewCommitId: undefined, fetchIncremental })
    );

    expect(result.source).toBe("full");
    expect(result.diff).toBe(FULL_DIFF);
    expect(fetchIncremental).not.toHaveBeenCalled();
  });

  test("falls back to the full diff when the range is unresolvable (force-push)", async () => {
    const fetchIncremental = mock(async () => undefined);

    const result = await resolveDiffScope(baseInput({ fetchIncremental }));

    expect(result.source).toBe("full");
    expect(result.diff).toBe(FULL_DIFF);
    expect(result.fileEntries).toEqual(FULL_FILE_ENTRIES);
  });

  test("falls back to the full diff when the fetcher throws", async () => {
    const fetchIncremental = mock(async () => {
      throw new Error("network exploded");
    });

    const result = await resolveDiffScope(baseInput({ fetchIncremental }));

    expect(result.source).toBe("full");
    expect(result.diff).toBe(FULL_DIFF);
  });

  test("never throws — a throwing fetcher must not abort the review", async () => {
    const fetchIncremental = mock(async () => {
      throw new Error("boom");
    });

    // Not just "returns full": the whole review round must survive. An
    // uncaught throw here would take down a review that would otherwise post.
    const promise = resolveDiffScope(baseInput({ fetchIncremental }));

    await expect(promise).resolves.toBeDefined();
  });
});
