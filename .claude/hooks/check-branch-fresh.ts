#!/usr/bin/env bun
// PreToolUse hook: block session_commit / session_pr_create / session_pr_edit when branch is behind main.
//
// Rationale: When a session's branch is behind origin/main, subsequent commits
// pile iteration on top of a stale base. Sibling PRs that merged while the
// agent was mid-iteration may have already fixed the same bug from a different
// angle, making the current work redundant or conflicting. This hook surfaces
// the diverging commits so the agent can review them before adding more work.
//
// Behaviour:
//   - Compares origin/<branch> vs origin/main via `git log --oneline`.
//   - If main has commits not reachable from the branch: BLOCK with a structured
//     message listing the first 10 diverging commit subjects.
//   - Fresh branches (no upstream / no remote branch yet): ALLOW silently.
//   - Override: MINSKY_SKIP_FRESHNESS=1 bypasses with an audit log entry.
//
// @see mt#1483 — structural hook for the branch-behind-main pattern
// @see feedback_check_branch_behind_main_during_iteration — originating memory
// @see parallel-work-guard.ts — structural template

import { readInput, writeOutput, execWithPath } from "./types";
import type { ToolHookInput } from "./types";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface BranchFreshnessResult {
  blocked: boolean;
  /** Number of commits origin/main is ahead of origin/<branch> */
  aheadCount: number;
  /** First 10 commit subjects on main not reachable from branch */
  aheadSubjects: string[];
  /** Human-readable reason for allow/block decision */
  reason: string;
}

// ---------------------------------------------------------------------------
// Core check
// ---------------------------------------------------------------------------

const GIT_TIMEOUT_MS = 8_000;

/**
 * Detect the current HEAD branch name in the given working directory.
 * Returns null if HEAD is detached or the command fails.
 */
export function detectCurrentBranch(repoDir: string): string | null {
  const result = execWithPath(["git", "-C", repoDir, "rev-parse", "--abbrev-ref", "HEAD"], {
    timeout: GIT_TIMEOUT_MS,
  });
  if (result.exitCode !== 0 || !result.stdout.trim() || result.stdout.trim() === "HEAD") {
    return null;
  }
  return result.stdout.trim();
}

/**
 * Check whether origin/<branch> exists as a remote ref.
 * Returns false if the probe fails (e.g. branch not pushed yet — fresh branch).
 */
export function remoteBranchExists(repoDir: string, branch: string): boolean {
  const result = execWithPath(["git", "-C", repoDir, "rev-parse", "--verify", `origin/${branch}`], {
    timeout: GIT_TIMEOUT_MS,
  });
  return result.exitCode === 0;
}

/**
 * Check whether origin/main (or a detected default branch) exists.
 * Returns the default remote ref name, or null if undetectable.
 */
export function detectDefaultRemoteBranch(repoDir: string): string | null {
  // Try symbolic ref first
  const symbolic = execWithPath(
    ["git", "-C", repoDir, "symbolic-ref", "refs/remotes/origin/HEAD"],
    { timeout: GIT_TIMEOUT_MS }
  );
  if (symbolic.exitCode === 0 && symbolic.stdout.trim()) {
    return symbolic.stdout.trim().replace(/^refs\/remotes\//, "");
  }

  // Fall back to probing common defaults
  for (const candidate of ["main", "master"]) {
    const probe = execWithPath(
      ["git", "-C", repoDir, "rev-parse", "--verify", `origin/${candidate}`],
      { timeout: GIT_TIMEOUT_MS }
    );
    if (probe.exitCode === 0) {
      return `origin/${candidate}`;
    }
  }

  return null;
}

/**
 * List commits on `mainRef` that are NOT reachable from `branchRef`.
 * Returns up to `limit` subjects (oneline format).
 *
 * The range `branchRef..mainRef` means "commits reachable from mainRef
 * but not from branchRef" — i.e., commits main has that the branch lacks.
 */
export function listCommitsAhead(
  repoDir: string,
  branchRef: string,
  mainRef: string,
  limit: number = 10
): { count: number; subjects: string[] } {
  // First get the count (no limit)
  const countResult = execWithPath(
    ["git", "-C", repoDir, "rev-list", "--count", `${branchRef}..${mainRef}`],
    { timeout: GIT_TIMEOUT_MS }
  );
  if (countResult.exitCode !== 0) {
    return { count: 0, subjects: [] };
  }
  const count = parseInt(countResult.stdout.trim(), 10);
  if (isNaN(count) || count === 0) {
    return { count: 0, subjects: [] };
  }

  // Get the first N subjects
  const subjectsResult = execWithPath(
    ["git", "-C", repoDir, "log", "--oneline", `--max-count=${limit}`, `${branchRef}..${mainRef}`],
    { timeout: GIT_TIMEOUT_MS }
  );
  if (subjectsResult.exitCode !== 0) {
    return { count, subjects: [] };
  }

  const subjects = subjectsResult.stdout
    .trim()
    .split("\n")
    .filter((line) => line.length > 0);

  return { count, subjects };
}

/**
 * Run the branch-freshness check.
 *
 * `repoDir`: the working directory to run git in (from `input.cwd`)
 * `branch`: optional override for the current branch name (defaults to HEAD)
 *
 * Returns a BranchFreshnessResult.
 */
export function checkBranchFreshness(
  repoDir: string,
  branch?: string | null
): BranchFreshnessResult {
  // Resolve current branch
  const currentBranch = branch ?? detectCurrentBranch(repoDir);
  if (!currentBranch) {
    return {
      blocked: false,
      aheadCount: 0,
      aheadSubjects: [],
      reason: "Could not detect current branch (detached HEAD?) — freshness check skipped",
    };
  }

  // Check if the remote branch exists; if not, it's a fresh branch — allow
  if (!remoteBranchExists(repoDir, currentBranch)) {
    return {
      blocked: false,
      aheadCount: 0,
      aheadSubjects: [],
      reason: `Fresh branch: origin/${currentBranch} does not exist yet — no divergence to check`,
    };
  }

  // Detect the default remote branch (origin/main or origin/master)
  const mainRef = detectDefaultRemoteBranch(repoDir);
  if (!mainRef) {
    return {
      blocked: false,
      aheadCount: 0,
      aheadSubjects: [],
      reason: "Could not detect origin/main or origin/master — freshness check skipped",
    };
  }

  // Compare origin/<branch> vs origin/main (not local HEAD, to avoid local-only commits skewing the check)
  const branchRef = `origin/${currentBranch}`;
  const { count, subjects } = listCommitsAhead(repoDir, branchRef, mainRef);

  if (count === 0) {
    return {
      blocked: false,
      aheadCount: 0,
      aheadSubjects: [],
      reason: `Branch ${currentBranch} is up to date with ${mainRef}`,
    };
  }

  return {
    blocked: true,
    aheadCount: count,
    aheadSubjects: subjects,
    reason: `${mainRef} is ${count} commit(s) ahead of origin/${currentBranch}`,
  };
}

// ---------------------------------------------------------------------------
// Message formatting
// ---------------------------------------------------------------------------

export function formatBlockMessage(
  branch: string,
  mainRef: string,
  aheadCount: number,
  subjects: string[]
): string {
  const lines: string[] = [
    `Branch-freshness guard: blocked — ${mainRef} is ${aheadCount} commit(s) ahead of origin/${branch}.`,
    "",
    `New commits on ${mainRef} not in this branch (first ${Math.min(subjects.length, 10)} of ${aheadCount}):`,
  ];

  for (const subject of subjects.slice(0, 10)) {
    lines.push(`  ${subject}`);
  }

  lines.push("");
  lines.push(
    "Review the new commits on main before continuing — they may subsume or conflict with this PR."
  );
  lines.push("");
  lines.push("Recommended actions:");
  lines.push("  1. RUN session_update to rebase this branch on current main.");
  lines.push("  2. REVIEW the new commits for overlap with the current diff.");
  lines.push("  3. If a sibling PR already fixed the same issue, consider closing this one.");
  lines.push("");
  lines.push("Emergency override: set MINSKY_SKIP_FRESHNESS=1 in your environment and retry.");
  lines.push("  (The override is audit-logged.)");

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Hook entry point
// ---------------------------------------------------------------------------

const GUARDED_TOOLS = new Set([
  "mcp__minsky__session_commit",
  "mcp__minsky__session_pr_create",
  "mcp__minsky__session_pr_edit",
]);

if (import.meta.main) {
  const input = await readInput<ToolHookInput>();

  // Only act on the guarded tools
  if (!GUARDED_TOOLS.has(input.tool_name)) {
    process.exit(0);
  }

  // Check for override env var
  const skipFreshness = process.env["MINSKY_SKIP_FRESHNESS"];
  if (skipFreshness === "1") {
    const ts = new Date().toISOString();
    process.stdout.write(
      `[check-branch-fresh] OVERRIDE active (MINSKY_SKIP_FRESHNESS=1) — tool=${input.tool_name} ts=${ts}\n`
    );
    process.exit(0);
  }

  const repoDir = input.cwd;

  // Detect current branch
  const currentBranch = detectCurrentBranch(repoDir);
  const result = checkBranchFreshness(repoDir, currentBranch);

  if (!result.blocked) {
    // Silently allow — no output unless there's a skip reason worth logging
    if (result.reason.includes("skipped")) {
      process.stdout.write(`[check-branch-fresh] ${result.reason}\n`);
    }
    process.exit(0);
  }

  // Blocked: format and emit denial
  const mainRef = detectDefaultRemoteBranch(repoDir) ?? "origin/main";
  const message = formatBlockMessage(
    currentBranch ?? "unknown",
    mainRef,
    result.aheadCount,
    result.aheadSubjects
  );

  writeOutput({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: message,
    },
  });
  process.exit(0);
}
