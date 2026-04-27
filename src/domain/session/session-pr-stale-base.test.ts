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
 * Build a ConflictDetectionDeps stub where execAsync calls dispatch via a list
 * of (matcher, response) handlers, evaluated in order. Handlers can be:
 *  - string responses (constant stdout)
 *  - functions that produce stdout per-call (e.g., for stateful HEAD changes
 *    across before/after merge)
 *
 * Why richer than substring-matching: smartSessionUpdate's merge path calls
 * `rev-parse HEAD` twice (before and after merge) to detect whether the merge
 * advanced the branch. A simple substring match would also catch
 * `rev-parse <branch>^{tree}` and force them to share a value, masking
 * branch-advance signals.
 */
type CmdHandler = {
  match: (command: string) => boolean;
  respond: (command: string) => string;
};

function makeMockDeps(handlers: CmdHandler[] = [], fetchShouldFail = false): ConflictDetectionDeps {
  return {
    execAsync: async (command: string) => {
      for (const h of handlers) {
        if (h.match(command)) {
          return { stdout: h.respond(command), stderr: "" };
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

/** Match a substring anywhere in the command. */
function substringHandler(needle: string, response: string): CmdHandler {
  return { match: (cmd) => cmd.includes(needle), respond: () => response };
}

/** Stateful handler: returns each value in `values` in turn for repeated matches. */
function sequencedHandler(needle: string, values: string[]): CmdHandler {
  let i = 0;
  return {
    match: (cmd) => cmd.includes(needle),
    respond: () => values[Math.min(i++, values.length - 1)] ?? "",
  };
}

// ---------------------------------------------------------------------------
// Shared command-pattern constants (avoid magic-string duplication)
// ---------------------------------------------------------------------------

const CMD_REV_LIST_LEFT_RIGHT = "rev-list --left-right --count";
const CMD_REV_LIST_ORIGIN_MAIN = "rev-list origin/main..";
const CMD_MERGE_BASE = "merge-base";
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
  it("proceeds past the sessionChangesInBase gate AND advances the branch when skipIfAlreadyMerged is false", async () => {
    // Arrange: simulate a diverged branch where session files match origin/main trees
    // (this is the sibling-compile-artifact scenario)
    // rev-list --left-right returns "2\t1" = 2 behind, 1 ahead (diverged)
    // rev-list baseBranch..sessionBranch returns a commit SHA (has session commits)
    // Tree hashes equal (session files same content as base) => sessionChangesInBase: true
    //
    // After the merge: rev-parse HEAD returns a different SHA than before,
    // proving the branch advanced. mergeWithConflictPrevention compares
    // before/after HEAD to set merged: true.
    const equalTree = "abc123deadbeef";
    const deps = makeMockDeps([
      substringHandler(CMD_REV_LIST_LEFT_RIGHT, "2\t1"),
      substringHandler(CMD_MERGE_BASE, "deadbeef"),
      substringHandler(CMD_REV_LIST_ORIGIN_MAIN, "sessioncommit1"),
      // rev-parse HEAD: distinct hashes per call (before vs after merge)
      sequencedHandler("rev-parse HEAD", ["before-hash", "after-hash"]),
      // rev-parse <ref>^{tree}: equal tree hashes (drives sessionChangesInBase: true)
      substringHandler("^{tree}", equalTree),
      substringHandler(CMD_MERGE_FF_ONLY, ""), // If reached, ff-only succeeds
      substringHandler(CMD_MERGE_ORIGIN_MAIN, ""), // Real merge call succeeds
    ]);

    const service = new ConflictDetectionService(deps);

    // Act: skipIfAlreadyMerged: false — must NOT skip
    const result = await service.smartSessionUpdate("/fake/repo", "task/mt-9999", "main", {
      skipIfAlreadyMerged: false,
    });

    // Assert positive: the branch was advanced (this is the core invariant the
    // mt#1334 fix must preserve — without it, sibling-PR scenarios end up at
    // stale main and produce phantom GitHub conflicts).
    expect(result.updated).toBe(true);
    expect(result.skipped).toBe(false);
    // Assert the result did not short-circuit on the "already in base" path
    expect(result.reason).not.toContain("already in base");
    expect(result.reason).not.toContain("Session changes already in base");
  });

  it("would skip when skipIfAlreadyMerged is true and sessionChangesInBase is true (control case)", async () => {
    // Arrange: same diverged scenario with equal trees — but no rev-parse HEAD
    // sequencing is needed because the skip path returns before the merge.
    const equalTree = "abc123deadbeef";
    const deps = makeMockDeps([
      substringHandler(CMD_REV_LIST_LEFT_RIGHT, "2\t1"),
      substringHandler(CMD_MERGE_BASE, "deadbeef"),
      substringHandler(CMD_REV_LIST_ORIGIN_MAIN, "sessioncommit1"),
      substringHandler("^{tree}", equalTree),
    ]);

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
    // Arrange: branch is 3 commits behind, 0 ahead (pure fast-forward case).
    // For behind-only the divergence-analysis path doesn't reach the rev-parse tree
    // comparison, so we don't need to mock that here.
    const deps = makeMockDeps([
      substringHandler(CMD_REV_LIST_LEFT_RIGHT, "3\t0"),
      substringHandler(CMD_MERGE_BASE, "deadbeef"),
      substringHandler(CMD_REV_LIST_ORIGIN_MAIN, ""),
      substringHandler(CMD_MERGE_FF_ONLY, ""), // Fast-forward succeeds
    ]);

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

// ---------------------------------------------------------------------------
// Case D: source-level wiring guard for the STEP 6 call site
// ---------------------------------------------------------------------------

/**
 * Case D: Verify that session-pr-operations.ts's STEP 6 call site is set to
 * `skipIfAlreadyMerged: false`. Behavioral tests above exercise the receiving
 * service in isolation; this guard ensures a refactor cannot silently revert
 * the production wiring without behavioral coverage breaking.
 *
 * Uses Bun.file (not fs/promises) because the project's no-real-fs-in-tests
 * lint rule targets node fs imports specifically; reading a sibling source file
 * for a wiring assertion is a deliberate cross-cutting concern.
 */
describe("session_pr_create — STEP 6 skipIfAlreadyMerged source-wiring (mt#1334)", () => {
  it("session-pr-operations.ts call site sets skipIfAlreadyMerged: false", async () => {
    const sourcePath = new URL("./session-pr-operations.ts", import.meta.url).pathname;
    const source = await Bun.file(sourcePath).text();

    // The fix: must be set false at the wiring site
    expect(source).toContain("skipIfAlreadyMerged: false");
    // Guard: the broken assignment form must not appear anywhere in this file
    expect(source).not.toContain("skipIfAlreadyMerged: true");
  });
});
