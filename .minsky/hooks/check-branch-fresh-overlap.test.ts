// mt#3484 — diff-overlap predicate + the two-state remedy message.
//
// Split out of `check-branch-fresh.test.ts`, which reached the 1500-line
// max-lines ceiling. This file owns the predicate that decides whether the
// guard blocks at all; the sibling file owns branch/ref detection, budgets,
// mid-merge carve-outs, and the mt#2815 auto-merge.

import { describe, test, expect } from "bun:test";
import {
  formatBlockMessage,
  computeDiffOverlap,
  shouldAttemptAutoMerge,
  MAX_SHARED_FILES_SHOWN,
  type OverlapDeps,
  type BranchFreshnessResult,
} from "./check-branch-fresh";

const SHARED_FILE = "packages/domain/src/shared.ts";
const BRANCH_ONLY_FILE = "packages/domain/src/notify/telegram.ts";
const MAIN_ONLY_FILE = "src/cockpit/web/rail.tsx";
const OVERLAP_REPO = "/mock/overlap-repo";
const OVERLAP_BRANCH_REF = "origin/task/mt-3484";
const OVERLAP_MAIN_REF = "origin/main";
const OVERLAP_TIMEOUT_MS = 1500;

const MAIN_DIFF_PROBE_FAILED = "main-diff probe failed";
const SESSION_UPDATE_WONT_HELP = "session_update will NOT help here";
const GENERIC_UPDATE_REMEDY = "RUN session_update to merge current main into this branch";

const FIXTURE_COMMITS = [
  "abc1234 feat: add something",
  "def5678 fix: repair something",
  "ghi9012 chore: update deps",
];

/**
 * Build OverlapDeps from explicit per-side file lists. Ranges are matched by
 * which ref appears LAST, mirroring the production three-dot convention:
 * `A...B` is "what B changed relative to the merge base".
 */
function makeOverlapDeps(opts: {
  branchFiles?: string[] | null;
  mainFiles?: string[] | null;
  workingFiles?: string[] | null;
}): OverlapDeps {
  // `in` rather than `??`: an explicit `null` MUST survive to the production
  // code, because null-vs-empty is the whole distinction the fail-closed tests
  // below exercise. `opts.x ?? []` would silently turn every injected failure
  // into "ran, found nothing" and make those three tests vacuous — which is
  // exactly the bug the first draft of this helper had, caught by these tests.
  return {
    filesChangedInRange: (_repoDir, range) => {
      if (range.endsWith(OVERLAP_BRANCH_REF)) {
        return "branchFiles" in opts ? (opts.branchFiles as string[] | null) : [];
      }
      return "mainFiles" in opts ? (opts.mainFiles as string[] | null) : [];
    },
    workingTreeFiles: () => ("workingFiles" in opts ? (opts.workingFiles as string[] | null) : []),
  };
}

function runOverlap(deps: OverlapDeps) {
  return computeDiffOverlap(
    OVERLAP_REPO,
    OVERLAP_BRANCH_REF,
    OVERLAP_MAIN_REF,
    OVERLAP_TIMEOUT_MS,
    deps
  );
}

describe("computeDiffOverlap (mt#3484)", () => {
  test("disjoint files: no overlap — the 2026-07-31 incident's shape", () => {
    const result = runOverlap(
      makeOverlapDeps({ branchFiles: [BRANCH_ONLY_FILE], mainFiles: [MAIN_ONLY_FILE] })
    );

    expect(result).toEqual({ overlaps: false, sharedFiles: [] });
  });

  test("a file changed by both sides overlaps, and is named", () => {
    const result = runOverlap(
      makeOverlapDeps({
        branchFiles: [BRANCH_ONLY_FILE, SHARED_FILE],
        mainFiles: [MAIN_ONLY_FILE, SHARED_FILE],
      })
    );

    expect(result.overlaps).toBe(true);
    expect(result.sharedFiles).toEqual([SHARED_FILE]);
    expect(result.undetermined).toBeUndefined();
  });

  test("an UNCOMMITTED working-tree file overlapping main still blocks", () => {
    // The session_commit case: the edit about to be committed is not in the
    // branch's committed diff yet, but it is exactly the content at risk.
    const result = runOverlap(
      makeOverlapDeps({
        branchFiles: [BRANCH_ONLY_FILE],
        mainFiles: [SHARED_FILE],
        workingFiles: [SHARED_FILE],
      })
    );

    expect(result.overlaps).toBe(true);
    expect(result.sharedFiles).toEqual([SHARED_FILE]);
  });

  test("shared files are deduped and sorted", () => {
    const result = runOverlap(
      makeOverlapDeps({
        branchFiles: [SHARED_FILE, BRANCH_ONLY_FILE],
        mainFiles: [SHARED_FILE, BRANCH_ONLY_FILE],
        // Same paths again via the working tree — must not duplicate.
        workingFiles: [SHARED_FILE, BRANCH_ONLY_FILE],
      })
    );

    expect(result.sharedFiles).toEqual([BRANCH_ONLY_FILE, SHARED_FILE]);
  });

  describe("fails CLOSED when a probe cannot run", () => {
    test("branch-diff probe failure blocks rather than allowing", () => {
      const result = runOverlap(makeOverlapDeps({ branchFiles: null }));

      expect(result.overlaps).toBe(true);
      expect(result.undetermined).toBe("branch-diff probe failed");
      expect(result.sharedFiles).toEqual([]);
    });

    test("main-diff probe failure blocks rather than allowing", () => {
      const result = runOverlap(makeOverlapDeps({ mainFiles: null }));

      expect(result.overlaps).toBe(true);
      expect(result.undetermined).toBe(MAIN_DIFF_PROBE_FAILED);
    });

    test("working-tree probe failure blocks rather than allowing", () => {
      const result = runOverlap(
        makeOverlapDeps({
          branchFiles: [BRANCH_ONLY_FILE],
          mainFiles: [MAIN_ONLY_FILE],
          workingFiles: null,
        })
      );

      // Both committed sides are disjoint, so a naive implementation would
      // allow here. It must not: an unreadable working tree could contain the
      // overlapping edit.
      expect(result.overlaps).toBe(true);
      expect(result.undetermined).toBe("working-tree probe failed");
    });

    test("an EMPTY probe result is not treated as a failed one", () => {
      // [] means "ran, nothing changed"; null means "could not establish".
      // Conflating them would make every no-op diff fail closed.
      const result = runOverlap(
        makeOverlapDeps({ branchFiles: [], mainFiles: [], workingFiles: [] })
      );

      expect(result.overlaps).toBe(false);
      expect(result.undetermined).toBeUndefined();
    });
  });
});

describe("formatBlockMessage — overlap + two-state remedy (mt#3484)", () => {
  const OVERLAP_BLOCK = { overlaps: true, sharedFiles: [SHARED_FILE] };

  test("overlap path names the overlapping files, not the ahead-count, as the reason", () => {
    const msg = formatBlockMessage("task/mt-3484", OVERLAP_MAIN_REF, 9, FIXTURE_COMMITS, {
      overlaps: true,
      sharedFiles: [SHARED_FILE, BRANCH_ONLY_FILE],
    });

    expect(msg).toContain("2 file(s) changed by origin/main are also changed by this branch");
    expect(msg).toContain(SHARED_FILE);
    expect(msg).toContain(BRANCH_ONLY_FILE);
  });

  test("overlapping-file list is capped", () => {
    const many = Array.from({ length: MAX_SHARED_FILES_SHOWN + 5 }, (_, i) => `src/file-${i}.ts`);
    const msg = formatBlockMessage("task/mt-3484", OVERLAP_MAIN_REF, 3, FIXTURE_COMMITS, {
      overlaps: true,
      sharedFiles: many,
    });

    expect(msg).toContain(`first ${MAX_SHARED_FILES_SHOWN} of ${many.length}`);
    expect(msg).toContain(`src/file-${MAX_SHARED_FILES_SHOWN - 1}.ts`);
    expect(msg).not.toContain(`src/file-${MAX_SHARED_FILES_SHOWN}.ts`);
  });

  test("undetermined path says so explicitly and names the failed probe", () => {
    const msg = formatBlockMessage("task/mt-3484", OVERLAP_MAIN_REF, 4, FIXTURE_COMMITS, {
      overlaps: true,
      sharedFiles: [],
      undetermined: MAIN_DIFF_PROBE_FAILED,
    });

    expect(msg).toContain("could not determine whether");
    expect(msg).toContain(MAIN_DIFF_PROBE_FAILED);
    expect(msg).toContain("fail-closed path");
  });

  test("localHasMain=true tells the agent to PUSH, and warns session_update will not help", () => {
    const msg = formatBlockMessage(
      "task/mt-3484",
      OVERLAP_MAIN_REF,
      2,
      FIXTURE_COMMITS,
      OVERLAP_BLOCK,
      true
    );

    expect(msg).toContain("PUSH");
    expect(msg).toContain(SESSION_UPDATE_WONT_HELP);
    expect(msg).toContain("git_push");
    expect(msg).not.toContain(GENERIC_UPDATE_REMEDY);
  });

  test("localHasMain=false gives the ordinary session_update remedy", () => {
    const msg = formatBlockMessage(
      "task/mt-3484",
      OVERLAP_MAIN_REF,
      2,
      FIXTURE_COMMITS,
      OVERLAP_BLOCK,
      false
    );

    expect(msg).toContain(GENERIC_UPDATE_REMEDY);
    expect(msg).not.toContain(SESSION_UPDATE_WONT_HELP);
  });

  test("localHasMain=null (probe failed) does not assert either remedy's precondition", () => {
    const msg = formatBlockMessage(
      "task/mt-3484",
      OVERLAP_MAIN_REF,
      2,
      FIXTURE_COMMITS,
      OVERLAP_BLOCK,
      null
    );

    // Falls back to the generic guidance rather than claiming the local branch
    // does or does not already contain main.
    expect(msg).toContain(GENERIC_UPDATE_REMEDY);
    expect(msg).not.toContain(SESSION_UPDATE_WONT_HELP);
  });
});

describe("shouldAttemptAutoMerge (mt#3484, PR #2536 R1)", () => {
  function makeResult(over: Partial<BranchFreshnessResult>): BranchFreshnessResult {
    return {
      blocked: true,
      aheadCount: 3,
      aheadSubjects: FIXTURE_COMMITS,
      reason: "test",
      mainRef: OVERLAP_MAIN_REF,
      branchRef: OVERLAP_BRANCH_REF,
      comparisonRan: true,
      ...over,
    };
  }

  test("attempts when a real overlap was found — the merge would resolve it", () => {
    const result = makeResult({ overlap: { overlaps: true, sharedFiles: [SHARED_FILE] } });

    expect(shouldAttemptAutoMerge(result)).toBe(true);
  });

  test("attempts on the undetermined path — the merge also resolves the uncertainty", () => {
    const result = makeResult({
      overlap: { overlaps: true, sharedFiles: [], undetermined: MAIN_DIFF_PROBE_FAILED },
    });

    expect(shouldAttemptAutoMerge(result)).toBe(true);
  });

  test("does NOT attempt on the budget-exhausted deny — nothing was established about the branch", () => {
    // The mutation guard: auto-merge WRITES. With no overlap verdict we have no
    // basis for writing, and running it here would falsify this task's claim
    // that the auto-merge is scoped to the overlap path.
    const result = makeResult({ overlap: undefined, overlapSkipped: "budget-exhausted" });

    expect(shouldAttemptAutoMerge(result)).toBe(false);
  });

  test("does NOT attempt when the branch was allowed despite being behind", () => {
    const result = makeResult({ blocked: false, overlap: { overlaps: false, sharedFiles: [] } });

    expect(shouldAttemptAutoMerge(result)).toBe(false);
  });

  test("does NOT attempt on an early-return result that never reached the probe", () => {
    const result = makeResult({ blocked: false, overlap: undefined, silent: true });

    expect(shouldAttemptAutoMerge(result)).toBe(false);
  });
});

describe("formatBlockMessage — budget-exhausted block (mt#3484, PR #2536 R1)", () => {
  test("says the overlap check did not run, and that this is not an overlap finding", () => {
    // Omitting `overlap` entirely is the budget-exhausted shape. The message
    // must not let a reader mistake a count-only block for a found overlap.
    const msg = formatBlockMessage("task/mt-3484", OVERLAP_MAIN_REF, 5, FIXTURE_COMMITS);

    expect(msg).toContain("The overlap check did NOT run");
    expect(msg).toContain("does NOT mean an overlap was found");
    expect(msg).toContain("5 commit(s) ahead of origin/task/mt-3484");
    expect(msg).not.toContain("are also changed by this branch");
  });
});
