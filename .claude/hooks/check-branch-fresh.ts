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
//   - Allows silently (no stdout, no additionalContext): branch even with main,
//     fresh branch (no upstream), detached HEAD, undetectable default branch.
//     These are the four "nothing to report" paths in the Behavioral Contract.
//   - Warnings always surface even on silent paths: when the pre-check git fetch
//     failed (network down, auth issue, etc.), the resulting "comparison may be
//     against STALE refs" warning IS emitted regardless of silent. The carve-out
//     is intentional — silence means "nothing to report"; warnings mean
//     "something the operator should know," and operators should always learn
//     about staleness.
//   - Override: MINSKY_SKIP_FRESHNESS=1 bypasses with an audit log entry.
//
// @see mt#1483 — structural hook for the branch-behind-main pattern
// @see feedback_check_branch_behind_main_during_iteration — originating memory
// @see parallel-work-guard.ts — structural template

import {
  readInput,
  writeOutput,
  execWithPath,
  readHostCap,
  deriveBudgets,
  DEFAULT_HOST_CAP_SEC,
} from "./types";
import type { ToolHookInput, HostCapInfo } from "./types";

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
   * The current HEAD branch name as detected by `detectCurrentBranch`. Set
   * whenever a branch was detected (regardless of allow/block); undefined
   * for detached HEAD or when budget was exhausted before detection.
   *
   * Returned so the entrypoint does not need to call `detectCurrentBranch`
   * separately (which would run outside the budget guard) — the round-5
   * BLOCKING fix.
   */
  currentBranch?: string;
  /**
   * True for paths that are explicitly silent per the Behavioral Contract:
   * branch-even-with-main, fresh branch, detached HEAD, undetectable default.
   * The entrypoint emits no stdout or additionalContext for the result's
   * `reason` when `silent === true`. Warnings still emit regardless of silent
   * (see header comment for the carve-out rationale).
   */
  silent?: boolean;
}

// ---------------------------------------------------------------------------
// Budget derivation from host cap (mt#1546)
// ---------------------------------------------------------------------------
//
// Two-phase derivation — designed so module import has ZERO side effects:
//
//   Phase 1 (module load): seed module-level `let` bindings from
//     `deriveBudgets(DEFAULT_HOST_CAP_SEC)`. No fs read, no env read. These
//     are PROVISIONAL defaults so the helpers below have valid values to
//     close over even if the entrypoint never runs (e.g., test imports).
//
//   Phase 2 (entrypoint, authoritative): the `if (import.meta.main)` block
//     calls `readHostCap("check-branch-fresh.ts", undefined, { events:
//     ["PreToolUse"] })`, then `applyHostCap(hostCapInfo.hostCapSec)`. This
//     mutates the same `let` bindings to settings-derived values BEFORE
//     `hookStart` is captured and BEFORE any check runs.
//
// `getCurrentBudgets()` returns the post-mutation values for tests; do
// not rely on literals in this comment for current state.
//
// Three named ratios (defined in `./types.ts`) drive `deriveBudgets`:
//
//   OVERALL_BUDGET_RATIO (0.6)  — overall budget = 60% of host cap
//   FETCH_TIMEOUT_RATIO  (0.55) — fetch can use 55% of overall budget
//   GIT_TIMEOUT_RATIO    (0.17) — each local probe gets ~1/6 of overall budget
//
// Canonical derivation at the current DEFAULT_HOST_CAP_SEC (`./types.ts`):
//   OVERALL_BUDGET_MS = floor(DEFAULT_HOST_CAP_SEC * 1000 * 0.6)
//   FETCH_TIMEOUT_MS  = floor(OVERALL_BUDGET_MS * 0.55)
//   GIT_TIMEOUT_MS    = floor(OVERALL_BUDGET_MS * 0.17)
//
// At the current 15s default these resolve to 9000 / 4950 / 1530 ms; the
// pre-mt#1546 hardcoded values were 9000 / 5000 / 1500 ms. The ±1-2%
// shift is intentional — the cost of removing magic-number coupling
// between cap and constants. Tests pin the derived values at multiple
// caps; if `DEFAULT_HOST_CAP_SEC` changes, the resolved values above
// re-derive automatically. See `.minsky/rules/hook-files.mdc` "Budget
// derivation" section for the operator-facing contract.
//
// Each derived value is clamped to MIN_DERIVED_BUDGET_MS (100ms) inside
// `deriveBudgets` so pathologically small caps don't zero out a probe
// budget. The clamp never fires for realistic caps (>= 5s).

// ---------------------------------------------------------------------------
// Core check
// ---------------------------------------------------------------------------

// Initial budgets come from the default cap (DEFAULT_HOST_CAP_SEC = 15s).
// The hook entrypoint reassigns these from settings.json before the check
// runs. `let` (not `const`) so the entrypoint can override; the variables
// are module-scoped because the helpers below close over them via direct
// reference. Importing this module triggers no fs/env reads — only
// `applyHostCap` (called from the entrypoint) does.
const DEFAULT_BUDGETS = deriveBudgets(DEFAULT_HOST_CAP_SEC);
let GIT_TIMEOUT_MS = DEFAULT_BUDGETS.gitTimeoutMs;
let FETCH_TIMEOUT_MS = DEFAULT_BUDGETS.fetchTimeoutMs;
let OVERALL_BUDGET_MS = DEFAULT_BUDGETS.overallBudgetMs;

/**
 * Reassign the module-level budget constants from a host cap (in seconds).
 * Called once from the entrypoint after `readHostCap`. Exposed for tests
 * that need to exercise the entrypoint path with a non-default cap.
 */
export function applyHostCap(hostCapSec: number): void {
  const budgets = deriveBudgets(hostCapSec);
  GIT_TIMEOUT_MS = budgets.gitTimeoutMs;
  FETCH_TIMEOUT_MS = budgets.fetchTimeoutMs;
  OVERALL_BUDGET_MS = budgets.overallBudgetMs;
}

/** Test-only: read the current module-level budgets (post-`applyHostCap`). */
export function getCurrentBudgets() {
  return {
    overallBudgetMs: OVERALL_BUDGET_MS,
    fetchTimeoutMs: FETCH_TIMEOUT_MS,
    gitTimeoutMs: GIT_TIMEOUT_MS,
  };
}

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
 * Returns up to `limit` subjects (oneline format) plus the total count.
 *
 * The range `branchRef..mainRef` means "commits reachable from mainRef
 * but not from branchRef" — i.e., commits main has that the branch lacks.
 *
 * Atomicity note: this is a SINGLE `git log` invocation. The previous
 * implementation made TWO calls (rev-list --count, then git log) which
 * left a TOCTOU window: if `origin/main` advanced between the calls
 * (e.g., a parallel `git fetch` from a sibling agent), the count and
 * subjects could disagree. One call closes that window — count is just
 * the number of returned lines.
 */
export function listCommitsAhead(
  repoDir: string,
  branchRef: string,
  mainRef: string,
  limit: number = 10
): { count: number; subjects: string[] } {
  const result = execWithPath(
    ["git", "-C", repoDir, "log", "--oneline", `${branchRef}..${mainRef}`],
    { timeout: GIT_TIMEOUT_MS }
  );
  if (result.exitCode !== 0) {
    return { count: 0, subjects: [] };
  }

  const lines = result.stdout
    .trim()
    .split("\n")
    .filter((line) => line.length > 0);

  return { count: lines.length, subjects: lines.slice(0, limit) };
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

  // Budget-guard the branch detection itself (round-5 BLOCKING fix —
  // previously this ran in the entrypoint outside any guard).
  if (overBudget(GIT_TIMEOUT_MS)) {
    return {
      blocked: false,
      aheadCount: 0,
      aheadSubjects: [],
      reason: "Overall budget exhausted before current-branch detect — freshness check skipped",
    };
  }

  // Resolve current branch
  const currentBranch = branch ?? detectCurrentBranch(repoDir);
  if (!currentBranch) {
    // Detached HEAD — silent per Behavioral Contract.
    return {
      blocked: false,
      aheadCount: 0,
      aheadSubjects: [],
      reason: "Could not detect current branch (detached HEAD?) — freshness check skipped",
      silent: true,
    };
  }

  if (overBudget(GIT_TIMEOUT_MS)) {
    return {
      blocked: false,
      aheadCount: 0,
      aheadSubjects: [],
      reason: "Overall budget exhausted before remote-branch check — freshness check skipped",
      currentBranch,
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
      currentBranch,
    };
  }

  // detectDefaultRemoteBranch may run up to 4 sub-probes — guard with budget
  if (overBudget(GIT_TIMEOUT_MS * 4)) {
    return {
      blocked: false,
      aheadCount: 0,
      aheadSubjects: [],
      reason: "Overall budget exhausted before default-branch detect — freshness check skipped",
      currentBranch,
    };
  }

  // Detect the default remote branch (origin/main or origin/master)
  const mainRef = detectDefaultRemoteBranch(repoDir);
  if (!mainRef) {
    // Undetectable default — silent per Behavioral Contract.
    return {
      blocked: false,
      aheadCount: 0,
      aheadSubjects: [],
      reason: "Could not detect origin/main or origin/master — freshness check skipped",
      silent: true,
      currentBranch,
    };
  }

  if (overBudget(GIT_TIMEOUT_MS * 2)) {
    return {
      blocked: false,
      aheadCount: 0,
      aheadSubjects: [],
      reason: "Overall budget exhausted before commits-ahead probe — freshness check skipped",
      mainRef,
      currentBranch,
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
      currentBranch,
    };
  }

  return {
    blocked: true,
    aheadCount: count,
    aheadSubjects: subjects,
    reason: `${mainRef} is ${count} commit(s) ahead of origin/${currentBranch}`,
    mainRef,
    currentBranch,
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

  // Read host cap from settings.json and apply derived budgets BEFORE
  // hookStart capture so the OVERALL_BUDGET_MS guard inside
  // checkBranchFreshness counts fetch time toward the budget. The read is
  // deferred to entrypoint (vs module load) so importing this module has
  // zero side effects — see PR #958 R1 fix.
  const hostCapInfo: HostCapInfo = readHostCap("check-branch-fresh.ts", undefined, {
    events: ["PreToolUse"],
  });
  applyHostCap(hostCapInfo.hostCapSec);

  // Capture hookStart BEFORE fetch so the OVERALL_BUDGET_MS guard inside
  // checkBranchFreshness counts fetch time toward the budget. This prevents
  // worst-case wall-time = fetch + budget exceeding the 15s PreToolUse cap.
  const hookStart = Date.now();

  // Refresh remote-tracking refs so the comparison runs against current state.
  // Failure is non-fatal (warn + continue): a slow / unreachable origin should
  // not block the agent's commit. The decision then runs against possibly-stale
  // refs, which is no worse than the pre-hook baseline.
  const warnings: string[] = [];
  // Surface the host-cap-read warning (if any) so operators see when budgets
  // were derived from the default 15s rather than from settings.json.
  if (hostCapInfo.warning) {
    warnings.push(hostCapInfo.warning);
  }
  const fetchResult = refreshRemoteRefs(repoDir);
  if (!fetchResult.ok) {
    warnings.push(
      `git fetch failed — comparison may be against STALE refs (${fetchResult.reason ?? "unknown"})`
    );
  }

  // Branch detection moved INSIDE checkBranchFreshness (round-5 BLOCKING fix)
  // so it's covered by the budget guard. Pass undefined so checkBranchFreshness
  // performs its own detection.
  const result = checkBranchFreshness(repoDir, undefined, hookStart);

  if (!result.blocked) {
    // Behavioral Contract: silent paths emit no `reason` to stdout or
    // additionalContext. Non-silent paths (budget-exhausted) DO emit their
    // reason. Warnings (e.g., fetch failures) ALWAYS emit regardless of
    // silent — operators should know about staleness even on the silent
    // happy paths. This carve-out is documented in the header comment and
    // in the published Behavioral Contract (.minsky/rules/hook-files.mdc).
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

  // Blocked: format and emit denial. Reuse `result.mainRef` and
  // `result.currentBranch` (set by checkBranchFreshness) instead of
  // re-detecting — re-detection could yield different values under flaky
  // probes, AND re-detection would run outside the budget guard.
  const mainRef = result.mainRef ?? "origin/main";
  const message = formatBlockMessage(
    result.currentBranch ?? "unknown",
    mainRef,
    result.aheadCount,
    result.aheadSubjects
  );

  // When fetch failed, the comparison ran against possibly-stale refs.
  // Surface that prominently in the deny message so operators don't act on
  // a block whose evidence may be hours old.
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
