/**
 * Tests for incremental diff-since-last-review scope resolution (mt#3471),
 * including the subset invariant that keeps the narrowed scope inside the PR's
 * own merge-base diff (mt#3663).
 *
 * The branch table these cover is the whole safety argument for the feature:
 * exactly one branch narrows the review, and every other branch — including
 * every failure — must hand back the full PR diff untouched. A bug that
 * narrowed on a wrong branch would silently shrink what the reviewer sees,
 * which no downstream check would catch. mt#3663 added the opposite failure to
 * the same argument: a branch that narrowed to a SUPERSET, showing base-branch
 * content as if the PR had introduced it.
 */

import { describe, test, expect, mock } from "bun:test";
import {
  resolveDiffScope,
  intersectWithPrFiles,
  selectDiffSectionsForFiles,
} from "./incremental-diff-scope";
import type { PrFileEntry, IncrementalDiffResult } from "./github-client";

/** Section headers, named so the same literal is not repeated across fixtures. */
const A_SECTION_HEADER = "diff --git a/src/a.ts b/src/a.ts";
const B_SECTION_HEADER = "diff --git a/src/b.ts b/src/b.ts";

const FULL_DIFF = [
  A_SECTION_HEADER,
  "--- a/src/a.ts",
  "+++ b/src/a.ts",
  "@@ -1,2 +1,3 @@",
  "+full-pr change",
  B_SECTION_HEADER,
  "--- a/src/b.ts",
  "+++ b/src/b.ts",
  "@@ -1,2 +1,3 @@",
  "+another full-pr change",
].join("\n");

const FULL_FILE_ENTRIES: PrFileEntry[] = [
  { filename: "src/a.ts", status: "modified", additions: 1, deletions: 0 },
  { filename: "src/b.ts", status: "modified", additions: 1, deletions: 0 },
];

const B_SECTION_OF_FULL_DIFF = [
  B_SECTION_HEADER,
  "--- a/src/b.ts",
  "+++ b/src/b.ts",
  "@@ -1,2 +1,3 @@",
  "+another full-pr change",
].join("\n");

const INCREMENTAL_DIFF = [
  B_SECTION_HEADER,
  "--- a/src/b.ts",
  "+++ b/src/b.ts",
  "@@ -1,2 +1,3 @@",
  "+only the newest commit",
].join("\n");

const INCREMENTAL_RESULT: IncrementalDiffResult = {
  diff: INCREMENTAL_DIFF,
  fileEntries: [{ filename: "src/b.ts", status: "modified", additions: 1, deletions: 0 }],
};

/** A file that landed on the base branch and reached the compare range via a merge commit. */
function mainSideFile(filename: string): PrFileEntry {
  return { filename, status: "modified", additions: 9, deletions: 3 };
}

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
  test("narrows to the files touched since the last review when the range resolves", async () => {
    const fetchIncremental = mock(async () => INCREMENTAL_RESULT);

    const result = await resolveDiffScope(baseInput({ fetchIncremental }));

    expect(result.source).toBe("incremental");
    expect(result.fileEntries).toHaveLength(1);
    expect(result.fileEntries[0]?.filename).toBe("src/b.ts");
    // The content is the PR's own section for that file — see the mt#3663
    // block below for why it is not the compare response's patch.
    expect(result.diff).toBe(B_SECTION_OF_FULL_DIFF);
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

describe("resolveDiffScope subset invariant (mt#3663)", () => {
  test("drops files the compare range carries but the PR does not touch", async () => {
    // AT1. The PR #2587 shape in miniature: a merge-from-main commit in range
    // drags the base branch's own files into the comparison.
    const fetchIncremental = mock(async () => ({
      diff: INCREMENTAL_DIFF,
      fileEntries: [
        { filename: "src/b.ts", status: "modified", additions: 1, deletions: 0 },
        mainSideFile("src/adapters/shared/commands/memory/index.ts"),
        mainSideFile("packages/domain/src/notify/principal-channel.ts"),
      ],
    }));

    const result = await resolveDiffScope(baseInput({ fetchIncremental }));

    expect(result.source).toBe("incremental");
    expect(result.fileEntries.map((f) => f.filename)).toEqual(["src/b.ts"]);
    expect(result.diff).not.toContain("memory/index.ts");
    expect(result.diff).not.toContain("principal-channel.ts");
  });

  test("shows the PR's patch for a file the PR and the base branch both touched", async () => {
    // AT3, and the reason a filename-only filter is not enough: a
    // conflict-resolution merge touches exactly the files the PR touches, so
    // `src/b.ts` survives the intersection while the compare's patch for it
    // carries content from the base branch.
    const fetchIncremental = mock(async () => INCREMENTAL_RESULT);

    const result = await resolveDiffScope(baseInput({ fetchIncremental }));

    expect(result.diff).toContain("another full-pr change");
    expect(result.diff).not.toContain("only the newest commit");
  });

  test("falls back to the full diff when every file in range is outside the PR", async () => {
    // AT2. Narrowing to nothing would hand the round an empty review surface.
    const fetchIncremental = mock(async () => ({
      diff: "diff --git a/src/main-only.ts b/src/main-only.ts\n+base branch change",
      fileEntries: [mainSideFile("src/main-only.ts")],
    }));

    const result = await resolveDiffScope(baseInput({ fetchIncremental }));

    expect(result.source).toBe("full");
    expect(result.diff).toBe(FULL_DIFF);
    expect(result.fileEntries).toEqual(FULL_FILE_ENTRIES);
  });

  test("reproduces the PR #2587 shape: 6 of 157 files survive", async () => {
    // AT5 at the unit level. The live compare for review 4850605423 returned
    // 157 files across 118 commits; the PR itself was 6 files.
    const prFiles: PrFileEntry[] = Array.from({ length: 6 }, (_, i) => ({
      filename: `src/in-pr-${i}.ts`,
      status: "modified",
      additions: 1,
      deletions: 0,
    }));
    const prDiff = prFiles
      .map((f) =>
        [`diff --git a/${f.filename} b/${f.filename}`, "@@ -1,1 +1,2 @@", "+pr change"].join("\n")
      )
      .join("\n");
    const inRange: PrFileEntry[] = [
      ...prFiles,
      ...Array.from({ length: 151 }, (_, i) => mainSideFile(`src/merged-from-main-${i}.ts`)),
    ];
    const fetchIncremental = mock(async () => ({ diff: "irrelevant", fileEntries: inRange }));

    const result = await resolveDiffScope(
      baseInput({ fetchIncremental, fullDiff: prDiff, fullFileEntries: prFiles })
    );

    expect(result.source).toBe("incremental");
    expect(result.fileEntries).toHaveLength(6);
    expect(result.diff).not.toContain("merged-from-main");
  });

  test("falls back to the full diff when survivors cannot be located in the PR diff", async () => {
    // The file list and the diff text disagree (a binary file, a truncated
    // diff). An empty narrowed diff is a worse review surface than the full one.
    const fetchIncremental = mock(async () => INCREMENTAL_RESULT);

    const result = await resolveDiffScope(
      baseInput({ fetchIncremental, fullDiff: "diff --git a/src/c.ts b/src/c.ts\n+unrelated" })
    );

    expect(result.source).toBe("full");
  });
});

describe("intersectWithPrFiles (mt#3663)", () => {
  test("returns the PR's entry, not the incremental one", () => {
    const prEntry: PrFileEntry = {
      filename: "src/b.ts",
      status: "modified",
      additions: 40,
      deletions: 2,
      patch: "@@ pr-relative @@",
    };
    const incrementalEntry: PrFileEntry = {
      filename: "src/b.ts",
      status: "modified",
      additions: 1,
      deletions: 0,
      patch: "@@ since-last-review @@",
    };

    const result = intersectWithPrFiles([incrementalEntry], [prEntry]);

    expect(result).toEqual([prEntry]);
  });

  test("matches a renamed file on either side of the rename", () => {
    const prEntry: PrFileEntry = {
      filename: "src/new-name.ts",
      status: "renamed",
      additions: 1,
      deletions: 0,
      previousFilename: "src/old-name.ts",
    };

    expect(intersectWithPrFiles([{ ...prEntry, filename: "src/old-name.ts" }], [prEntry])).toEqual([
      prEntry,
    ]);
    expect(intersectWithPrFiles([{ ...prEntry, previousFilename: undefined }], [prEntry])).toEqual([
      prEntry,
    ]);
  });

  test("deduplicates when several range entries map to one PR file", () => {
    const prEntry: PrFileEntry = {
      filename: "src/new-name.ts",
      status: "renamed",
      additions: 1,
      deletions: 0,
      previousFilename: "src/old-name.ts",
    };

    const result = intersectWithPrFiles(
      [
        { filename: "src/old-name.ts", status: "modified", additions: 1, deletions: 0 },
        { filename: "src/new-name.ts", status: "modified", additions: 1, deletions: 0 },
      ],
      [prEntry]
    );

    expect(result).toEqual([prEntry]);
  });

  test("returns empty when nothing in the range belongs to the PR", () => {
    expect(intersectWithPrFiles([mainSideFile("src/main-only.ts")], FULL_FILE_ENTRIES)).toEqual([]);
  });

  test("preserves the PR's file order regardless of the range's order", () => {
    const result = intersectWithPrFiles(
      [
        { filename: "src/b.ts", status: "modified", additions: 1, deletions: 0 },
        { filename: "src/a.ts", status: "modified", additions: 1, deletions: 0 },
      ],
      FULL_FILE_ENTRIES
    );

    expect(result.map((f) => f.filename)).toEqual(["src/a.ts", "src/b.ts"]);
  });
});

describe("selectDiffSectionsForFiles (mt#3663)", () => {
  test("keeps only the named file's section, verbatim", () => {
    expect(selectDiffSectionsForFiles(FULL_DIFF, new Set(["src/b.ts"]))).toBe(
      B_SECTION_OF_FULL_DIFF
    );
  });

  test("keeps several sections in the diff's own order", () => {
    expect(selectDiffSectionsForFiles(FULL_DIFF, new Set(["src/b.ts", "src/a.ts"]))).toBe(
      FULL_DIFF
    );
  });

  test("returns empty for an empty name set", () => {
    expect(selectDiffSectionsForFiles(FULL_DIFF, new Set())).toBe("");
  });

  test("returns empty when no section matches", () => {
    expect(selectDiffSectionsForFiles(FULL_DIFF, new Set(["src/absent.ts"]))).toBe("");
  });

  test("does not match a file whose name is a suffix of another file's", () => {
    // `b/src/b.ts` must not be matched by the name `b.ts` — the leading ` b/`
    // in the test anchors the whole path, not a trailing fragment of it.
    expect(selectDiffSectionsForFiles(FULL_DIFF, new Set(["b.ts"]))).toBe("");
  });

  test("selects the destination path of a rename", () => {
    const renameDiff = [
      "diff --git a/src/old.ts b/src/new.ts",
      "similarity index 90%",
      "rename from src/old.ts",
      "rename to src/new.ts",
    ].join("\n");

    expect(selectDiffSectionsForFiles(renameDiff, new Set(["src/new.ts"]))).toBe(renameDiff);
  });
});
