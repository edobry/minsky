/**
 * Regression tests for mt#1334: session_pr_create inner update must merge from
 * current origin/main, not skip when session files appear to already be in base.
 *
 * Background: sibling PRs merging compile artifacts (e.g., .claude/skills/X/SKILL.md)
 * can produce identical file content on origin/main. The old `skipIfAlreadyMerged: true`
 * flag caused smartSessionUpdate to return { updated: false, skipped: true } because it
 * detected "session changes appear in base". The branch then ended up merged with a stale
 * origin/main snapshot, and GitHub's actual merge attempt saw phantom conflicts.
 *
 * Fix: session-pr-operations.ts STEP 6 now passes `skipIfAlreadyMerged: false`.
 *
 * These tests mirror the structural pattern of session-pr-workflow-bug.test.ts (mt#1281).
 */

import { describe, it, expect } from "bun:test";
import { ConflictDetectionService } from "../git/conflict-detection";
import type { ConflictDetectionDeps } from "../git/conflict-detection";
import type { GitExecResult } from "../../utils/git-exec";

// ---------------------------------------------------------------------------
// Shared mock deps factory
// ---------------------------------------------------------------------------

/**
 * Build a ConflictDetectionDeps stub where all execAsync calls return
 * configurable stdout.  The simplest approach: a map from command-substring
 * to response.
 */
function makeMockDeps(
  commandResponses: Record<string, string> = {},
  fetchShouldFail = false
): ConflictDetectionDeps {
  return {
    execAsync: async (command: string) => {
      for (const [pattern, response] of Object.entries(commandResponses)) {
        if (command.includes(pattern)) {
          return { stdout: response, stderr: "" };
        }
      }
      return { stdout: "", stderr: "" };
    },
    gitFetchWithTimeout: async (
      _remote?: string,
      _branch?: string,
      _opts?: unknown
    ): Promise<GitExecResult> => {
      if (fetchShouldFail) {
        throw new Error("Simulated fetch failure");
      }
      return { stdout: "", stderr: "", command: "git fetch", executionTimeMs: 0 };
    },
    log: {
      debug: () => {},
      warn: () => {},
      error: () => {},
    },
  };
}

// ---------------------------------------------------------------------------
// Shared command-pattern constants (avoid magic-string duplication)
// ---------------------------------------------------------------------------

const CMD_REV_LIST_LEFT_RIGHT = "rev-list --left-right --count";
const CMD_REV_LIST_ORIGIN_MAIN = "rev-list origin/main..";
const CMD_MERGE_BASE = "merge-base";
const CMD_REV_PARSE = "rev-parse";
const CMD_MERGE_FF_ONLY = "merge --ff-only";
const CMD_MERGE_ORIGIN_MAIN = "merge origin/main";

// ---------------------------------------------------------------------------
// Case B: skipIfAlreadyMerged: false must NOT skip when sessionChangesInBase is true
// ---------------------------------------------------------------------------

/**
 * Case B (regression for the sibling-artifact scenario): when the branch divergence
 * analysis reports sessionChangesInBase: true AND skipIfAlreadyMerged is false,
 * smartSessionUpdate must NOT return { skipped: true }.
 *
 * Prior to the fix: skipIfAlreadyMerged was true, so this scenario returned
 * { updated: false, skipped: true } instead of proceeding to merge from current
 * origin/main — leaving the branch merged with a stale base.
 */
describe("smartSessionUpdate — skipIfAlreadyMerged: false does not skip on sessionChangesInBase (mt#1334)", () => {
  it("proceeds past the sessionChangesInBase gate when skipIfAlreadyMerged is false", async () => {
    // Arrange: simulate a diverged branch where session files match origin/main trees
    // (this is the sibling-compile-artifact scenario)
    // rev-list --left-right returns "2\t1" = 2 behind, 1 ahead (diverged)
    // rev-list baseBranch..sessionBranch returns a commit SHA (has session commits)
    // Tree hashes equal (session files same content as base) => sessionChangesInBase: true
    const equalTree = "abc123deadbeef";
    const deps = makeMockDeps({
      [CMD_REV_LIST_LEFT_RIGHT]: "2\t1",
      [CMD_MERGE_BASE]: "deadbeef",
      [CMD_REV_LIST_ORIGIN_MAIN]: "sessioncommit1",
      [CMD_REV_PARSE]: equalTree, // Both sessionBranch^{tree} and baseBranch^{tree} return same hash
      [CMD_MERGE_FF_ONLY]: "", // If reached, ff-only succeeds
      [CMD_MERGE_ORIGIN_MAIN]: "", // If reached, merge succeeds
    });

    const service = new ConflictDetectionService(deps);

    // Act: skipIfAlreadyMerged: false — must NOT skip
    const result = await service.smartSessionUpdate("/fake/repo", "task/mt-9999", "main", {
      skipIfAlreadyMerged: false,
    });

    // Assert: the result must not indicate a "skip due to already merged" condition
    // (it may skip for other reasons like "no update needed", but not because of
    // the sessionChangesInBase heuristic)
    expect(result.reason).not.toContain("already in base");
    expect(result.reason).not.toContain("Session changes already in base");
  });

  it("would skip when skipIfAlreadyMerged is true and sessionChangesInBase is true (control case)", async () => {
    // Arrange: same diverged scenario with equal trees
    const equalTree = "abc123deadbeef";
    const deps = makeMockDeps({
      [CMD_REV_LIST_LEFT_RIGHT]: "2\t1",
      [CMD_MERGE_BASE]: "deadbeef",
      [CMD_REV_LIST_ORIGIN_MAIN]: "sessioncommit1",
      [CMD_REV_PARSE]: equalTree,
    });

    const service = new ConflictDetectionService(deps);

    // Act: skipIfAlreadyMerged: true — must skip
    const result = await service.smartSessionUpdate("/fake/repo", "task/mt-9999", "main", {
      skipIfAlreadyMerged: true,
    });

    // Assert: with the OLD behavior (true), this would return skipped
    expect(result.skipped).toBe(true);
    expect(result.updated).toBe(false);
    expect(result.reason).toContain("already in base");
  });
});

// ---------------------------------------------------------------------------
// Case C: the update-completed path does not block PR creation
// ---------------------------------------------------------------------------

/**
 * Case C: when smartSessionUpdate reports { updated: true }, the caller
 * (updateSessionImpl → sessionPrImpl) must continue to PR creation, not throw.
 *
 * This test verifies that ConflictDetectionService.smartSessionUpdate returns
 * { updated: true } for a behind-only branch where fast-forward is possible
 * (the common case after sibling PRs merge to main).
 */
describe("smartSessionUpdate — behind-only branch fast-forwards and returns updated:true (mt#1334)", () => {
  it("returns updated: true when branch is behind and fast-forward is available", async () => {
    // Arrange: branch is 3 commits behind, 0 ahead (pure fast-forward case)
    const deps = makeMockDeps({
      [CMD_REV_LIST_LEFT_RIGHT]: "3\t0",
      [CMD_MERGE_BASE]: "deadbeef",
      [CMD_REV_LIST_ORIGIN_MAIN]: "", // No session commits not in base (empty = sessionChangesInBase: true)
      [CMD_REV_PARSE]: "aaa111", // Different trees (no, wait — for behind-only we don't reach rev-parse)
      [CMD_MERGE_FF_ONLY]: "", // Fast-forward succeeds
    });

    const service = new ConflictDetectionService(deps);

    const result = await service.smartSessionUpdate("/fake/repo", "task/mt-9999", "main", {
      skipIfAlreadyMerged: false,
    });

    // A behind-only branch fast-forwards
    expect(result.updated).toBe(true);
    expect(result.skipped).toBe(false);
    expect(result.reason).toContain("Fast-forward");
  });
});
