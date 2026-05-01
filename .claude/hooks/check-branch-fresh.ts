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
  /**
   * The default-branch ref that the comparison was computed against
   * (e.g. `"origin/main"` or `"origin/master"`). Set whenever the check
   * actually ran a comparison (blocked or up-to-date); undefined when the
   * check returned early (detached HEAD, fresh branch, undetectable default).
   *
   * Returned so the hook entrypoint can render the denial message against
   * the SAME ref the comparison used, preventing the round-2 inconsistency
   * where re-detection could disagree with the original detection.
   */
  mainRef?: string;
  /**
   * True for paths that are explicitly silent per the Behavioral Contract
   * (branch-even-with-main, fresh branch). The entrypoint must NOT emit any
   * stdout or hookSpecificOutput for these paths beyond what `warnings`
   * carries — round-3 BLOCKING fix to make silence structural rather than
   * a reason-string heuristic.
   */
  silent?: boolean;
}

// ---------------------------------------------------------------------------
// Core check
// ---------------------------------------------------------------------------

/**
 * Per-call timeout for fast local git operations. Realistic git invocations
 * complete in <100ms; 1.5s is generous for degraded conditions.
 */
const GIT_TIMEOUT_MS = 1_500;

/**
 * Per-call timeout for the network-bound `git fetch`. Higher than other calls
 * because it's the only one going over the wire.
 */
const FETCH_TIMEOUT_MS = 5_000;

/**
 * Overall wall-clock budget for the hook from `hookStart` (which is captured
 * BEFORE the fetch — so fetch IS counted in this budget). Lowered to 10s so
 * fetch (worst case 5s) + remaining git probes stay well under the 15s
 * PreToolUse cap with margin for process startup / shutdown / write.
 *
 * Worst-case math: hookStart → ... → exit ≤ 10s + slack ≈ 11s, fits 15s.
 */
const OVERALL_BUDGET_MS = 10_000;

/**
 * Budget guard. Returns true if there's enough remaining wall-clock time to
 * safely run another call of the given duration. Used to short-circuit
 * before further git operations when the budget is nearly exhausted.
 */
function budgetAllows(start: number, callBudgetMs: number): boolean {
  return Date.now() - start + callBudgetMs <= OVERALL_BUDGET_MS;
}

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
  // Probe 1: symbolic ref (fastest, exact answer when set)
  const symbolic = execWithPath(
    ["git", "-C", repoDir, "symbolic-ref", "refs/remotes/origin/HEAD"],
    { timeout: GIT_TIMEOUT_MS }
  );
  if (symbolic.exitCode === 0 && symbolic.stdout.trim()) {
    return symbolic.stdout.trim().replace(/^refs\/remotes\//, "");
  }

  // Probe 2: `git remote show origin` — parses "HEAD branch: <name>".
  // Matches parallel-work-guard.detectDefaultBranch so repos lacking the
  // symbolic ref but with a queryable origin still detect the right default.
  const remoteShow = execWithPath(["git", "-C", repoDir, "remote", "show", "origin"], {
    timeout: GIT_TIMEOUT_MS,
  });
  if (remoteShow.exitCode === 0) {
    const headMatch = remoteShow.stdout.match(/^\s*HEAD branch:\s*(\S+)\s*$/m);
    if (headMatch && headMatch[1] !== "(unknown)") {
      return `origin/${headMatch[1]}`;
    }
  }

  // Probes 3 and 4: try common defaults explicitly
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
 * Refresh local remote-tracking refs from `origin` so the freshness comparison
 * runs against current state. Without this step, `origin/main` and
 * `origin/<branch>` are point-in-time copies that can lag the actual remote
 * by hours or days, producing false allow/deny decisions.
 *
 * Bounded by `FETCH_TIMEOUT_MS`; on failure (network down, auth issue, etc.)
 * the function returns `false` so the caller can warn but continue rather
 * than blocking the entire hook.
 */
export function refreshRemoteRefs(repoDir: string): { ok: boolean; reason?: string } {
  const result = execWithPath(
    ["git", "-C", repoDir, "fetch", "origin", "--prune", "--no-tags", "--quiet"],
    { timeout: FETCH_TIMEOUT_MS }
  );
  if (result.exitCode !== 0) {
    return {
      ok: false,
      reason: `git fetch exited ${result.exitCode}: ${(result.stderr || result.stdout).trim()}`,
    };
  }
  return { ok: true };
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
 * `hookStart`: optional timestamp marking when the hook began. When provided,
 * the check enforces the overall wall-clock budget and short-circuits with a
 * "skipped" reason if any further git call would risk exceeding it. When
 * omitted (e.g., from unit tests), no budget enforcement occurs.
 *
 * Returns a BranchFreshnessResult.
 */
export function checkBranchFreshness(
  repoDir: string,
  branch?: string | null,
  hookStart?: number
): BranchFreshnessResult {
  const startMs = typeof hookStart === "number" ? hookStart : null;
  const overBudget = (callBudgetMs: number): boolean =>
    startMs !== null && !budgetAllows(startMs, callBudgetMs);

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

  if (overBudget(GIT_TIMEOUT_MS)) {
    return {
      blocked: false,
      aheadCount: 0,
      aheadSubjects: [],
      reason: "Overall budget exhausted before remote-branch check — freshness check skipped",
    };
  }

  // Check if the remote branch exists; if not, it's a fresh branch — allow silently
  if (!remoteBranchExists(repoDir, currentBranch)) {
    return {
      blocked: false,
      aheadCount: 0,
      aheadSubjects: [],
      reason: `Fresh branch: origin/${currentBranch} does not exist yet — no divergence to check`,
      silent: true,
    };
  }

  // detectDefaultRemoteBranch may run up to 4 sub-probes — guard with budget
  if (overBudget(GIT_TIMEOUT_MS * 4)) {
    return {
      blocked: false,
      aheadCount: 0,
      aheadSubjects: [],
      reason: "Overall budget exhausted before default-branch detect — freshness check skipped",
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

  if (overBudget(GIT_TIMEOUT_MS * 2)) {
    return {
      blocked: false,
      aheadCount: 0,
      aheadSubjects: [],
      reason: "Overall budget exhausted before commits-ahead probe — freshness check skipped",
      mainRef,
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
      mainRef,
      silent: true,
    };
  }

  return {
    blocked: true,
    aheadCount: count,
    aheadSubjects: subjects,
    reason: `${mainRef} is ${count} commit(s) ahead of origin/${currentBranch}`,
    mainRef,
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
  // Derive the branch name from the ref so guidance reflects the actual default
  // branch (e.g. "origin/master" → "master") rather than hardcoding "main".
  const mainBranch = mainRef.replace(/^origin\//, "");
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
    `Review the new commits on ${mainBranch} before continuing — they may subsume or conflict with this PR.`
  );
  lines.push("");
  lines.push("Recommended actions:");
  lines.push(`  1. RUN session_update to rebase this branch on current ${mainBranch}.`);
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
  // Capture hookStart BEFORE fetch so the OVERALL_BUDGET_MS guard inside
  // checkBranchFreshness counts fetch time toward the budget. This prevents
  // worst-case wall-time = fetch + budget exceeding the 15s PreToolUse cap.
  const hookStart = Date.now();

  // Refresh remote-tracking refs so the comparison runs against current state.
  // Failure is non-fatal (warn + continue): a slow / unreachable origin should
  // not block the agent's commit. The decision then runs against possibly-stale
  // refs, which is no worse than the pre-hook baseline.
  const warnings: string[] = [];
  const fetchResult = refreshRemoteRefs(repoDir);
  const fetchFailed = !fetchResult.ok;
  if (fetchFailed) {
    warnings.push(
      `git fetch failed — comparison may be against STALE refs (${fetchResult.reason ?? "unknown"})`
    );
  }

  // Detect current branch
  const currentBranch = detectCurrentBranch(repoDir);
  const result = checkBranchFreshness(repoDir, currentBranch, hookStart);

  if (!result.blocked) {
    // Behavioral Contract: silent paths (fresh branch, branch-even-with-main)
    // emit nothing. Skipped paths (detached HEAD, undetectable default,
    // budget exhausted) emit their reason for auditability. Warnings are
    // always surfaced regardless. Round-3 BLOCKING fix: silence is now
    // gated by `result.silent` (structural) rather than by reason-string
    // pattern matching, so future reason-text changes can't accidentally
    // leak silent paths via additionalContext.
    const isSilent = result.silent === true;
    const lines: string[] = [];
    if (!isSilent) {
      lines.push(`[check-branch-fresh] ${result.reason}`);
    }
    for (const w of warnings) {
      lines.push(`[check-branch-fresh] ${w}`);
    }
    if (lines.length > 0) {
      for (const line of lines) {
        process.stdout.write(`${line}\n`);
      }
      writeOutput({
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          additionalContext: lines.join("\n"),
        },
      });
    }
    process.exit(0);
  }

  // Blocked: format and emit denial. Reuse `result.mainRef` (the ref the
  // comparison was actually computed against) instead of re-detecting —
  // re-detection could yield a different ref under flaky probes, producing
  // a denial message that mentions origin/master while the diff was computed
  // against origin/main.
  const mainRef = result.mainRef ?? "origin/main";
  const message = formatBlockMessage(
    currentBranch ?? "unknown",
    mainRef,
    result.aheadCount,
    result.aheadSubjects
  );

  // Round-3 BLOCKING fix: when fetch failed, the comparison ran against
  // possibly-stale refs. Always surface that prominently in the deny message
  // so operators don't act on a block whose evidence may be hours old.
  // Warnings (which include the fetch failure when it occurred) are
  // appended to the body in a dedicated section.
  const fullMessage =
    warnings.length > 0
      ? `${message}\n\nWarnings:\n${warnings.map((w) => `  [check-branch-fresh] ${w}`).join("\n")}`
      : message;

  writeOutput({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: fullMessage,
    },
  });
  process.exit(0);
}
