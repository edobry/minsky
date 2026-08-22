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
//   - Allows with audit-line on stdout: merge / rebase / cherry-pick in
//     progress (mt#1739). The operator is finalising a commit that resolves
//     staleness, so blocking would create a chicken-and-egg deadlock. Emits a
//     stdout audit line (`merge-in-progress (.git/<MARKER>) ...`) so operators
//     see that the hook recognised the merge state.
//   - Warnings always surface even on silent paths: when the pre-check git fetch
//     failed (network down, auth issue, etc.), the resulting "comparison may be
//     against STALE refs" warning IS emitted regardless of silent. The carve-out
//     is intentional — silence means "nothing to report"; warnings mean
//     "something the operator should know," and operators should always learn
//     about staleness.
//   - Override: MINSKY_SKIP_FRESHNESS=1 bypasses with an audit log entry.
//   - The repo ROOT is resolved from input.cwd by walking up to the first
//     `.git` entry (mt#2700): the shell cwd is routinely a repo SUBDIRECTORY,
//     which git subprocesses tolerate but the fs-only mid-merge probe and the
//     CAS-marker write do not.
//
// @see mt#1483 — structural hook for the branch-behind-main pattern
// @see feedback_check_branch_behind_main_during_iteration — originating memory
// @see parallel-work-guard.ts — structural template

import { join } from "node:path";
import {
  readInput,
  writeOutput,
  execWithPath,
  readHostCap,
  deriveBudgets,
  DEFAULT_HOST_CAP_SEC,
  // mt#2710: `MergeDetectFs`/`DEFAULT_FS`/`resolveGitDir`/`findRepoRoot` were
  // originally defined locally in this file (mt#2700) and now live in
  // `./types` so every `.minsky/hooks/*.ts` guard can share one repo-root
  // resolver. Re-exported below for backward compatibility with this file's
  // own tests (`check-branch-fresh.test.ts` imports them from here).
  DEFAULT_FS,
  resolveGitDir,
  findRepoRoot,
} from "./types";
import type { ToolHookInput, HostCapInfo, MergeDetectFs } from "./types";
import { recordFireLogEntry, classifyOverride } from "./fire-log";

export { resolveGitDir, findRepoRoot };
export type { MergeDetectFs };

/** This guard's fire-log identifier (mt#2889, evaluation-loop Phase 1 completion). */
const GUARD_NAME = "check-branch-fresh";
// PR #963 R1 NON-BLOCKING #2 fix: import the shared helper instead of
// duplicating filename + write logic in this file. Keeps payload shape +
// path canonical at one site (src/domain/session/freshness-marker.ts) so
// schema changes can't drift between the write side (this hook) and the
// read + CAS side (session_commit). The shared module imports only
// node:fs / node:path / errors — no transitive dependency surface that
// would slow hook startup.
import { writeFreshnessMarker } from "../../packages/domain/src/session/freshness-marker";

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
  /**
   * True iff the commits-ahead comparison (`listCommitsAhead`) actually ran
   * to completion. Required to gate the mt#1522 CAS marker write — we must
   * not capture a SHA when the budget-exhausted-before-comparison path
   * returned with `mainRef` set but no real freshness validation. PR #963
   * R1 BLOCKING #6 fix.
   */
  comparisonRan?: boolean;
  /**
   * The EXACT branch ref the commits-ahead comparison used as the left side
   * of the `branchRef..mainRef` range (e.g. `"origin/task/mt-2700"`). Set
   * only when the comparison ran. The entrypoint derives the denial
   * message's branch name from THIS value (via `denialBranchName`) rather
   * than re-deriving from `currentBranch`, so the message can never name a
   * ref other than the one the ahead-count was computed against (PR #1851
   * R1 BLOCKING #1).
   */
  branchRef?: string;
  /**
   * The diff-overlap verdict (mt#3484), set whenever the overlap probe ran —
   * on BOTH the block path (it found overlap, or could not determine it) and
   * the allow-despite-behind path (it found none). Undefined when the probe
   * never ran: the comparison returned early, or the budget was exhausted and
   * the check fell back to blocking on ahead-count alone.
   */
  overlap?: DiffOverlapResult;
  /**
   * Why `overlap` is absent on a path that WOULD otherwise have computed it
   * (mt#3484, PR #2536 R1 BLOCKING #2). Set only on the budget-exhausted deny
   * path, so a consumer can tell "the probe was skipped, and here is why" from
   * "this result never reached the probe at all" — without inferring either
   * from a bare `undefined`.
   *
   * Deliberately NOT a synthesized `DiffOverlapResult`: the probe did not run,
   * so there is no verdict, and manufacturing `overlaps: true/false` here would
   * put a fabricated finding on a field whose whole contract is that it reports
   * what was measured.
   */
  overlapSkipped?: "budget-exhausted";
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
 * Detect whether a merge, rebase, or cherry-pick is currently in progress
 * in the given working directory. Returns the name of the detected git-state
 * file/dir when one is present, or null when none are.
 *
 * The state markers checked are the well-known git transient-operation
 * files, probed under the *resolved* git directory (see `resolveGitDir` —
 * handles `.git`-as-file indirection used by `git worktree` and submodules):
 *
 *   - `MERGE_HEAD`         — `git merge` in progress, awaiting commit
 *   - `REBASE_HEAD`        — rebase in progress (newer git versions)
 *   - `rebase-merge/`      — interactive rebase (`git rebase -i`) in progress
 *   - `rebase-apply/`      — non-interactive rebase via `git format-patch`
 *                            apply path (and older git versions)
 *   - `CHERRY_PICK_HEAD`   — `git cherry-pick` in progress, awaiting commit
 *
 * Detection is a `fs.existsSync` per marker — no subprocess, no network.
 * Safe to call ahead of the wall-clock budget guard.
 *
 * Why this exists (mt#1739): without this detection, the freshness guard
 * blocks `session_commit` even when the commit being prepared is the merge
 * commit that resolves the staleness it's flagging. The freshness predicate
 * (`origin/<branch>..origin/main`) only updates after the merge commit is
 * pushed, creating a chicken-and-egg deadlock. Recognizing mid-merge state
 * means the operator is *resolving* staleness, not introducing it — silent
 * allow is the correct response.
 *
 * @see mt#1739 — originating task
 * @see feedback_freshness_guard_mid_merge_paradox — bridge memory
 * @see PR #1054 R1 — added `rebase-apply` marker + `.git`-file resolution
 */
export const MERGE_IN_PROGRESS_MARKERS = [
  "MERGE_HEAD",
  "REBASE_HEAD",
  "rebase-merge",
  "rebase-apply",
  "CHERRY_PICK_HEAD",
] as const;

// `MergeDetectFs`, `DEFAULT_FS`, `resolveGitDir`, and `findRepoRoot` moved to
// `./types` (mt#2710) — imported above and re-exported for this file's own
// tests. See that module's "Repo-root resolution" section for the full
// doc comments (unchanged, just relocated).

export function detectMergeInProgress(
  repoDir: string,
  fs: MergeDetectFs = DEFAULT_FS
): string | null {
  const gitDir = resolveGitDir(repoDir, fs);
  for (const marker of MERGE_IN_PROGRESS_MARKERS) {
    if (fs.existsSync(join(gitDir, marker))) {
      return marker;
    }
  }
  return null;
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
 * Resolve a ref to its 40-char SHA. Returns null on any failure (ref doesn't
 * exist, git command failed, etc.). Used to capture `origin/main` at
 * allow time for the CAS marker (mt#1522).
 */
export function resolveRefSha(repoDir: string, ref: string): string | null {
  const result = execWithPath(["git", "-C", repoDir, "rev-parse", ref], {
    timeout: GIT_TIMEOUT_MS,
  });
  if (result.exitCode !== 0) return null;
  const sha = result.stdout.trim();
  if (!/^[0-9a-f]{40}$/.test(sha)) return null;
  return sha;
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

  // mt#1739: mid-merge / mid-rebase / mid-cherry-pick is an allow path. The
  // operator is finalising a commit that *resolves* main-ahead-of-branch
  // staleness, not introducing fresh work on a stale branch. Skipping the
  // remote-ref comparison closes the chicken-and-egg deadlock described in
  // feedback_freshness_guard_mid_merge_paradox.
  //
  // Detection is `fs.existsSync`-only — cheaper than any subprocess in this
  // hook, so we run it before the budget guard (no risk of exhausting it).
  //
  // Returned WITHOUT silent: true because this is an operator-driven action
  // (not one of the four "nothing to report" routine cases — even-with-main,
  // fresh branch, detached HEAD, undetectable default). The entrypoint emits
  // `result.reason` to stdout as an audit line so operators see that the
  // hook recognised the merge state, mirroring the MINSKY_SKIP_FRESHNESS=1
  // override-audit convention.
  const midMergeMarker = detectMergeInProgress(repoDir);
  if (midMergeMarker) {
    return {
      blocked: false,
      aheadCount: 0,
      aheadSubjects: [],
      reason: `merge-in-progress (.git/${midMergeMarker}) — freshness check skipped`,
    };
  }

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
      comparisonRan: true,
      branchRef,
    };
  }

  // mt#3484: main being ahead is NOT by itself a reason to block — see the
  // "Diff-overlap predicate" section's header for the measurement that drove
  // this. Ask the question the guard actually exists to ask: do main's new
  // commits touch anything this branch touches?
  //
  // Budget-guarded because the probe costs up to three local git calls. On
  // exhaustion we fall back to the PRE-mt#3484 behavior (block on ahead-count)
  // rather than allowing — a guard that silently weakens under time pressure
  // is worse than one that is occasionally over-strict.
  if (overBudget(GIT_TIMEOUT_MS * 3)) {
    return {
      blocked: true,
      aheadCount: count,
      aheadSubjects: subjects,
      reason: `${mainRef} is ${count} commit(s) ahead of ${branchRef} (overlap probe skipped — budget exhausted)`,
      mainRef,
      currentBranch,
      comparisonRan: true,
      branchRef,
      overlapSkipped: "budget-exhausted",
    };
  }

  const overlap = computeDiffOverlap(repoDir, branchRef, mainRef, GIT_TIMEOUT_MS);

  if (!overlap.overlaps) {
    // Main advanced, but on disjoint files. Allow — and say so out loud rather
    // than silently, because the operator should still see that the branch is
    // behind (the Behavioral Contract's four silent paths are the "nothing to
    // report" cases; this one has something to report).
    return {
      blocked: false,
      aheadCount: count,
      aheadSubjects: subjects,
      reason: `${mainRef} is ${count} commit(s) ahead of ${branchRef}, but none of those commits touch files this branch changes — allowing.`,
      mainRef,
      currentBranch,
      comparisonRan: true,
      branchRef,
      overlap,
    };
  }

  return {
    blocked: true,
    aheadCount: count,
    aheadSubjects: subjects,
    reason: overlap.undetermined
      ? `${mainRef} is ${count} commit(s) ahead of ${branchRef} and the overlap probe could not run (${overlap.undetermined}) — blocking on the safe side`
      : `${mainRef} is ${count} commit(s) ahead of ${branchRef} and ${overlap.sharedFiles.length} file(s) overlap this branch's diff`,
    mainRef,
    currentBranch,
    comparisonRan: true,
    branchRef,
    overlap,
  };
}

// ---------------------------------------------------------------------------
// Diff-overlap predicate (mt#3484)
// ---------------------------------------------------------------------------
//
// Why the predicate changed from ahead-count to diff-overlap:
//
// The guard's stated purpose (see this file's header) is that "sibling PRs
// that merged while the agent was mid-iteration may have already fixed the
// same bug from a different angle, making the current work redundant or
// conflicting." That is a claim about the RELATIONSHIP between two diffs.
// `origin/<branch>..origin/main` being non-empty is only a proxy for it, and
// under concurrent-agent load the proxy fires constantly while the underlying
// risk stays rare.
//
// Measured on 2026-07-31 (mt#3484): seven consecutive `session_commit` denials
// in fifteen minutes in one conversation, six more concurrently in another,
// against a remedy cycle (~205s) longer than the interval at which main
// advanced (~2.6 min mean). Not one of the seven blocking batches touched a
// file the blocked PR's own diff touched. The proxy was wrong every time.
//
// GitHub's equivalent control is "Require branches to be up to date before
// merging" (`requiresStrictStatusChecks`), which IS enabled on this repo at
// merge time. This guard is therefore not the only thing standing between a
// stale branch and main — it is an additional, strictly earlier copy of that
// requirement, applied on every commit rather than once per merge. Narrowing
// it to real overlap leaves the merge-time guarantee untouched.

/** Injectable git-mechanics for the overlap probe — tests inject fakes for a hermetic run. */
export interface OverlapDeps {
  /**
   * File paths changed by a `git diff --name-only <range>` invocation, or
   * `null` when the probe itself failed (non-zero exit). `null` is distinct
   * from `[]`: an empty array means "ran, found nothing changed"; `null` means
   * "could not establish what changed" and must fail CLOSED.
   */
  filesChangedInRange: (repoDir: string, range: string, timeoutMs: number) => string[] | null;
  /** Paths with staged or unstaged modifications, or `null` when the probe failed. */
  workingTreeFiles: (repoDir: string, timeoutMs: number) => string[] | null;
}

const DEFAULT_OVERLAP_DEPS: OverlapDeps = {
  filesChangedInRange: (repoDir, range, timeoutMs) => {
    const result = execWithPath(["git", "-C", repoDir, "diff", "--name-only", range], {
      timeout: timeoutMs,
    });
    if (result.exitCode !== 0) return null;
    return result.stdout
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
  },
  workingTreeFiles: (repoDir, timeoutMs) => {
    const result = execWithPath(["git", "-C", repoDir, "status", "--porcelain"], {
      timeout: timeoutMs,
    });
    if (result.exitCode !== 0) return null;
    return (
      result.stdout
        .split("\n")
        .filter((line) => line.length > 3)
        // Porcelain v1 format is `XY <path>`; a rename reads `R  old -> new`.
        // Take the destination path, which is the one that exists post-change.
        .map((line) => {
          const path = line.slice(3).trim();
          const arrow = path.indexOf(" -> ");
          return arrow === -1 ? path : path.slice(arrow + 4);
        })
        .filter(Boolean)
    );
  },
};

export interface DiffOverlapResult {
  /** True when the guard should still block: a real overlap, or an undetermined probe. */
  overlaps: boolean;
  /** The intersecting paths, sorted. Empty when `overlaps` is false, or when `undetermined` is set. */
  sharedFiles: string[];
  /** Set when a probe failed; the value names which one. `overlaps` is forced true. */
  undetermined?: string;
}

/** Cap on how many shared paths the denial message enumerates. */
export const MAX_SHARED_FILES_SHOWN = 10;

/**
 * Decide whether main's new commits actually touch anything this branch
 * touches.
 *
 * Two three-dot ranges, both measured from the merge base so neither side is
 * polluted by the other's history:
 *   - `mainRef...branchRef` — what THIS branch changed.
 *   - `branchRef...mainRef` — what main changed since the branch diverged.
 *
 * `extraBranchFiles` folds in the working tree (the edit about to be
 * committed, which is not in either committed range yet but is exactly the
 * content at risk at `session_commit` time).
 *
 * FAILS CLOSED. If either probe returns `null` the function cannot establish
 * non-overlap, so it reports `overlaps: true` with `undetermined` set. A
 * broken probe must never be the reason a risky commit is allowed through —
 * per mem#704, a check that cannot fail carries no information, and the
 * inverse holds too: a check that cannot SUCCEED must not read as a pass.
 */
export function computeDiffOverlap(
  repoDir: string,
  branchRef: string,
  mainRef: string,
  timeoutMs: number,
  deps: OverlapDeps = DEFAULT_OVERLAP_DEPS
): DiffOverlapResult {
  const branchFiles = deps.filesChangedInRange(repoDir, `${mainRef}...${branchRef}`, timeoutMs);
  if (branchFiles === null) {
    return { overlaps: true, sharedFiles: [], undetermined: "branch-diff probe failed" };
  }

  const mainFiles = deps.filesChangedInRange(repoDir, `${branchRef}...${mainRef}`, timeoutMs);
  if (mainFiles === null) {
    return { overlaps: true, sharedFiles: [], undetermined: "main-diff probe failed" };
  }

  const workingFiles = deps.workingTreeFiles(repoDir, timeoutMs);
  if (workingFiles === null) {
    return { overlaps: true, sharedFiles: [], undetermined: "working-tree probe failed" };
  }

  const mainSet = new Set(mainFiles);
  const shared = new Set<string>();
  for (const file of [...branchFiles, ...workingFiles]) {
    if (mainSet.has(file)) shared.add(file);
  }

  const sharedFiles = [...shared].sort();
  return { overlaps: sharedFiles.length > 0, sharedFiles };
}

/**
 * Distinguish the two states the old message conflated (mt#3484 criterion 5).
 *
 * When `origin/main` is ahead of `origin/<branch>`, there are two very
 * different situations and the remedies are opposites:
 *
 *   (a) The LOCAL branch already contains main's tip — someone merged and
 *       never pushed. `session_update` will not help: a local branch that is
 *       `ahead` short-circuits to `skipped: "No update needed - session is
 *       current or ahead"` (conflict-detection.ts) and returns BEFORE its push
 *       step, so the remote never advances and the guard blocks forever. The
 *       remedy is a push.
 *   (b) The local branch does NOT contain main's tip — main genuinely advanced.
 *       The remedy is to merge it.
 *
 * The agent cannot currently tell these apart from any tool it has:
 * `git_status` against a session workspace reports `upstream: null, ahead:
 * null, behind: null`. Note that mt#2815's auto-merge CREATES state (a) — it
 * merges local-only and never pushes.
 *
 * Returns `null` when the probe fails, so callers can omit the claim rather
 * than assert the wrong remedy.
 */
export function localBranchContainsMain(
  repoDir: string,
  mainRef: string,
  timeoutMs: number
): boolean | null {
  const result = execWithPath(
    ["git", "-C", repoDir, "merge-base", "--is-ancestor", mainRef, "HEAD"],
    { timeout: timeoutMs }
  );
  // `--is-ancestor` documents exit 0 = yes, 1 = no. Any OTHER code is a real
  // failure (bad ref, not a repo) and must not be read as a confident "no".
  if (result.exitCode === 0) return true;
  if (result.exitCode === 1) return false;
  return null;
}

// ---------------------------------------------------------------------------
// Clean-tree auto-merge (mt#2815)
// ---------------------------------------------------------------------------
//
// Motivation: under concurrent-agent load, origin/main routinely advances by
// a handful of commits between an agent's last fetch and its next commit /
// PR-create step. mt#2815's investigation (7+ block->session_update->retry
// cycles across 3 conversations in one week, all reconfirmed evidence
// clean) found these fires are almost always resolved by a plain rebase
// with ZERO actual conflicts — the diverging commits are sibling-PR work on
// disjoint files. Each cycle still costs a full agent round-trip: block
// message -> session_update call -> re-invoke the original tool. This
// closes the common case.
//
// When the working tree is FULLY CLEAN (no staged or unstaged changes — the
// guarded tool call has nothing pending that a merge could clobber) and
// merging `mainRef` into the current branch applies with NO conflicts,
// perform the merge inline and let the original tool call proceed. The
// merge commit is LOCAL ONLY — this hook never pushes; the guarded tool's
// own push step (session_commit always pushes; session_pr_create /
// session_pr_edit push as part of their own rebase-on-main step) carries
// the merge commit to origin/<branch>.
//
// IMPORTANT — clean tree does NOT itself guarantee a conflict-free merge.
// The conflicts this guard exists to catch are between two commit
// HISTORIES (origin/main's new commits vs. the session branch's own
// already-pushed commits) — working-tree cleanliness only rules out the
// SEPARATE failure mode of local uncommitted edits colliding with the
// incoming merge. History-level conflicts can still occur on a clean tree;
// that is exactly why this function ATTEMPTS the merge and verifies the
// outcome (non-zero exit / conflict markers) rather than skipping the
// attempt on the assumption that clean-tree implies safe. The empirical
// "most fires are clean, zero-conflict" finding justifies attempting this
// by default — it does not justify skipping the verification.
//
// Protective property (regression-tested): a merge that produces conflicts
// is immediately aborted (`git merge --abort`) before this function
// returns. This is critical, not cosmetic — a left-behind MERGE_HEAD would
// be picked up by `detectMergeInProgress` on the VERY NEXT hook invocation
// and silently ALLOW past a still-stale, still-unresolved branch (the
// mt#1739 mid-merge carve-out is meant for an operator actively resolving a
// merge, not an abandoned auto-merge attempt). On conflict, the block
// behavior downstream is byte-for-byte the pre-mt#2815 path — no silent
// conflict resolution, ever.
//
// Explicitly NOT attempted when the working tree is dirty. `session_commit`
// calls are typically dirty by construction (there is something to commit),
// so this mechanism's practical reach is largest at `session_pr_create` /
// `session_pr_edit` time, where the tree is clean by workflow convention
// (everything already committed). That scoping is intentional, not a gap:
// it keeps the mechanism to the case the investigation evidence actually
// covers, per the acceptance criteria's "no conflicts possible on clean
// tree + no overlapping files" framing — which this comment block exists to
// qualify precisely (see the IMPORTANT paragraph above).

/** Injectable git-mechanics for `attemptCleanTreeAutoMerge` — real impls shell out via `execWithPath`; tests inject fakes for a fully hermetic run. */
export interface AutoMergeDeps {
  /** True iff there are no staged or unstaged changes (`git status --porcelain` is empty). */
  isWorkingTreeClean: (repoDir: string, timeoutMs: number) => boolean;
  /** Attempt `git merge --no-edit <mainRef>` against current HEAD. */
  runMerge: (repoDir: string, mainRef: string, timeoutMs: number) => { exitCode: number };
  /** Best-effort `git merge --abort` — always called after a failed merge attempt. */
  abortMerge: (repoDir: string, timeoutMs: number) => void;
  /** List conflicted file paths (UU/AA/DD/AU/UA/DU/UD) after a failed merge. */
  listConflictedFiles: (repoDir: string, timeoutMs: number) => string[];
}

const DEFAULT_AUTO_MERGE_DEPS: AutoMergeDeps = {
  isWorkingTreeClean: (repoDir, timeoutMs) => {
    const result = execWithPath(["git", "-C", repoDir, "status", "--porcelain"], {
      timeout: timeoutMs,
    });
    return result.exitCode === 0 && result.stdout.trim().length === 0;
  },
  runMerge: (repoDir, mainRef, timeoutMs) =>
    execWithPath(["git", "-C", repoDir, "merge", "--no-edit", mainRef], { timeout: timeoutMs }),
  abortMerge: (repoDir, timeoutMs) => {
    execWithPath(["git", "-C", repoDir, "merge", "--abort"], { timeout: timeoutMs });
  },
  listConflictedFiles: (repoDir, timeoutMs) => {
    const result = execWithPath(["git", "-C", repoDir, "status", "--porcelain"], {
      timeout: timeoutMs,
    });
    if (result.exitCode !== 0) return [];
    return result.stdout
      .split("\n")
      .filter((line) => /^(UU|AA|DD|AU|UA|DU|UD) /.test(line))
      .map((line) => line.slice(3).trim())
      .filter(Boolean);
  },
};

/**
 * Whether the entrypoint should attempt the mt#2815 clean-tree auto-merge for
 * a given freshness result (mt#3484, PR #2536 R1 BLOCKING #1 + NON-BLOCKING #2).
 *
 * Extracted from the `import.meta.main` entrypoint specifically so this decision
 * is testable: the auto-merge WRITES to the branch, and "when do we mutate?" is
 * exactly the kind of predicate that should not live only in an unreachable
 * entrypoint conditional.
 *
 * True only on POSITIVE overlap knowledge — a real overlap or an `undetermined`
 * probe, both of which a clean merge would resolve. False when the probe never
 * ran (budget-exhausted deny), because mutating a branch we have established
 * nothing about is not something a narrowed guard should do.
 */
export function shouldAttemptAutoMerge(result: BranchFreshnessResult): boolean {
  return result.blocked === true && result.overlap?.overlaps === true;
}

export type AutoMergeOutcome =
  | { attempted: false; reason: string }
  | { attempted: true; merged: true; mergedCommitCount: number }
  | { attempted: true; merged: false; conflictedFiles: string[] };

/**
 * Attempt an inline merge of `mainRef` into the current branch when the
 * working tree is clean, so a clean-tree/no-conflict freshness block can be
 * resolved without a manual session_update round-trip. Only called from the
 * entrypoint when `checkBranchFreshness` already returned `blocked: true`.
 *
 * Never leaves a MERGE_HEAD behind: any non-zero-exit merge attempt is
 * aborted before this function returns (see header comment above for why
 * that matters).
 */
export function attemptCleanTreeAutoMerge(
  repoDir: string,
  branchRef: string | undefined,
  mainRef: string | undefined,
  aheadCount: number,
  hookStart: number,
  deps: AutoMergeDeps = DEFAULT_AUTO_MERGE_DEPS
): AutoMergeOutcome {
  if (!branchRef || !mainRef) {
    return {
      attempted: false,
      reason: "missing branchRef/mainRef — comparison did not fully run",
    };
  }

  // Budget-guard the merge attempt itself — a merge of already-fetched refs
  // is comparable in cost to any other local git probe in this file.
  if (!budgetAllows(hookStart, GIT_TIMEOUT_MS * 2)) {
    return { attempted: false, reason: "overall budget exhausted before auto-merge attempt" };
  }

  if (!deps.isWorkingTreeClean(repoDir, GIT_TIMEOUT_MS)) {
    return {
      attempted: false,
      reason: "working tree is not clean — auto-merge skipped, falling back to block",
    };
  }

  // PR #2000 R1 BLOCKING #1/#2: this is a purely LOCAL git operation against
  // already-fetched refs (the entrypoint's refreshRemoteRefs already ran
  // before checkBranchFreshness) — it belongs to the same local-probe budget
  // class as every other execWithPath call in this file (GIT_TIMEOUT_MS),
  // NOT the network-bound FETCH_TIMEOUT_MS class (~55% of the overall
  // budget, sized for a real network round-trip to origin). Using
  // FETCH_TIMEOUT_MS here would let a single local merge attempt consume
  // more than half the hook's total budget, inconsistent with the
  // `GIT_TIMEOUT_MS * 2` reservation the budget-guard above already made
  // for exactly this call plus the isWorkingTreeClean probe.
  const mergeResult = deps.runMerge(repoDir, mainRef, GIT_TIMEOUT_MS);
  if (mergeResult.exitCode === 0) {
    return { attempted: true, merged: true, mergedCommitCount: aheadCount };
  }

  // Merge failed — conflicts (the expected failure mode on a clean tree) or
  // something else entirely (e.g. a lock file race). Either way: abort
  // defensively so no MERGE_HEAD survives for the NEXT hook invocation to
  // misread as an operator-driven mid-merge (mt#1739's carve-out).
  const conflictedFiles = deps.listConflictedFiles(repoDir, GIT_TIMEOUT_MS);
  deps.abortMerge(repoDir, GIT_TIMEOUT_MS);
  return { attempted: true, merged: false, conflictedFiles };
}

// ---------------------------------------------------------------------------
// Message formatting
// ---------------------------------------------------------------------------

/**
 * Derive the branch NAME the denial message should render, from the EXACT
 * ref the comparison used (`result.branchRef`), falling back to
 * `currentBranch` only for results that never reached the comparison.
 * Centralized so the message can never drift from the compared ref
 * (PR #1851 R1 BLOCKING #1). The entrypoint always calls
 * `checkBranchFreshness` with `branch: undefined` (detection inside the
 * budget guard — round-5 fix); this helper keeps the message honest even
 * if a future caller passes an override.
 */
export function denialBranchName(result: BranchFreshnessResult): string {
  const ref = result.branchRef ?? `origin/${result.currentBranch ?? "unknown"}`;
  return ref.replace(/^origin\//, "");
}

export function formatBlockMessage(
  branch: string,
  mainRef: string,
  aheadCount: number,
  subjects: string[],
  overlap?: DiffOverlapResult,
  localHasMain?: boolean | null
): string {
  // Derive the branch name from the ref so guidance reflects the actual default
  // branch (e.g. "origin/master" → "master") rather than hardcoding "main".
  const mainBranch = mainRef.replace(/^origin\//, "");
  const lines: string[] = [];

  // mt#3484: lead with WHY this blocked. Post-mt#3484 the guard only blocks on
  // real diff overlap (or an overlap probe that could not run), so the count
  // alone is no longer the reason and must not be presented as one.
  if (overlap?.undetermined) {
    lines.push(
      `Branch-freshness guard: blocked — could not determine whether ${mainRef}'s new commits overlap this branch (${overlap.undetermined}).`
    );
    lines.push("");
    lines.push(
      "This is the fail-closed path: the guard blocks when it cannot establish that the change is safe, rather than assuming it is."
    );
  } else if (overlap && overlap.sharedFiles.length > 0) {
    const shown = overlap.sharedFiles.slice(0, MAX_SHARED_FILES_SHOWN);
    lines.push(
      `Branch-freshness guard: blocked — ${overlap.sharedFiles.length} file(s) changed by ${mainRef} are also changed by this branch.`
    );
    lines.push("");
    lines.push(
      `Overlapping file(s)${overlap.sharedFiles.length > shown.length ? ` (first ${shown.length} of ${overlap.sharedFiles.length})` : ""}:`
    );
    for (const file of shown) {
      lines.push(`  ${file}`);
    }
  } else {
    // Budget-exhausted fallback: the overlap probe never ran, so the pre-mt#3484
    // ahead-count wording is the honest description of what was actually checked.
    // On a BLOCK, `overlap === undefined` has exactly one cause — the hook ran
    // out of wall-clock budget before the probe — so the message can name it
    // rather than leaving the reader to infer it from an absence (PR #2536 R1).
    lines.push(
      `Branch-freshness guard: blocked — ${mainRef} is ${aheadCount} commit(s) ahead of origin/${branch}.`
    );
    lines.push("");
    lines.push(
      "The overlap check did NOT run (the hook exhausted its time budget first), so this block is on commit count alone — it does NOT mean an overlap was found. Retrying usually gets a real answer."
    );
  }

  lines.push("");
  lines.push(
    `New commits on ${mainRef} not in this branch (first ${Math.min(subjects.length, 10)} of ${aheadCount}):`
  );
  for (const subject of subjects.slice(0, 10)) {
    lines.push(`  ${subject}`);
  }

  lines.push("");
  lines.push(
    `Review the new commits on ${mainBranch} before continuing — they may subsume or conflict with this PR.`
  );
  lines.push("");

  // mt#3484 criterion 5: name the state, because the two states have OPPOSITE
  // remedies and nothing else the agent can call distinguishes them.
  lines.push("Recommended actions:");
  if (localHasMain === true) {
    lines.push(
      `  1. PUSH. Your LOCAL branch already contains ${mainBranch} — only origin/${branch} is behind.`
    );
    lines.push(
      `     session_update will NOT help here: a local branch that is already ahead short-circuits`
    );
    lines.push(
      `     ("No update needed - session is current or ahead") and returns before its push step, so`
    );
    lines.push(`     the remote never advances and this guard keeps firing. Run git_push instead.`);
  } else {
    lines.push(`  1. RUN session_update to merge current ${mainBranch} into this branch.`);
  }
  lines.push("  2. REVIEW the overlapping files above for a sibling fix that subsumes this work.");
  lines.push("  3. If a sibling PR already fixed the same issue, consider closing this one.");
  lines.push("");
  // Plain "Override:", matching the house form used by the other 23 override
  // lines in this tree (mt#4416). This one used to open with an alarm word, and
  // was the only one that did — for a routine, audit-logged escape hatch listed
  // alongside a dozen peers in `hook-files.mdc`. It cost a real false alarm: the
  // principal saw the string in unrelated grep output and asked whether
  // something had actually gone wrong. Nothing had; the guard had not even
  // fired. Same scarcity argument `docs/design-system.md` §5.1 makes for red —
  // an alarm word spent on a non-alarm stops being a signal.
  //
  // The literal old text is deliberately not quoted here: the acceptance grep
  // for it should stay a clean zero, and a comment naming it would keep the
  // phrase alive in the tree it was removed from.
  lines.push("Override: set MINSKY_SKIP_FRESHNESS=1 in your environment and retry.");
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
  const startMs = Date.now();
  const input = await readInput<ToolHookInput>();

  // mt#2889 (evaluation-loop Phase 1 completion): fire-log every evaluation,
  // exactly once per invocation regardless of which exit fires below. NOTE:
  // no canary declared for this guard (registry.ts) — its real evaluation
  // has genuine side effects (a live `git fetch`, and on a blocked+clean-tree
  // path an actual `git merge` via attemptCleanTreeAutoMerge, mt#2815; a CAS
  // marker write on the allow path) that a synthetic canary invocation
  // cannot safely exercise without either mutating a real repo checkout or
  // building a disposable scratch git-repo fixture beyond this pass's
  // budget — documented as a known gap in the PR body.
  const recordAndExit = (
    decision: "allow" | "deny",
    overrideFields?: {
      overrideEnvVar: string;
      overrideClassification: ReturnType<typeof classifyOverride>;
    },
    /**
     * mt#3920 — clean-run evidence for guard-health's recovery join, and only where this
     * guard actually compared the branch. Left UNSET at the two exits above the
     * comparison (an unguarded tool, and the MINSKY_SKIP_FRESHNESS override): neither
     * says anything about whether the probe works. The two exits below pass
     * `result.comparisonRan === true ? "decided" : "crashed"` — the budget-exhausted
     * fallback returns a `mainRef` without ever running `listCommitsAhead`, so it looks
     * exactly like a completed evaluation from the outside.
     */
    outcome?: "decided" | "crashed"
  ): never => {
    recordFireLogEntry({
      guardName: GUARD_NAME,
      event: "PreToolUse",
      decision,
      ...(outcome !== undefined ? { guardOutcome: outcome } : {}),
      durationMs: Date.now() - startMs,
      toolName: input.tool_name,
      sessionId: input.session_id,
      ...overrideFields,
    });
    process.exit(0);
  };

  // Only act on the guarded tools
  if (!GUARDED_TOOLS.has(input.tool_name)) {
    recordAndExit("allow");
  }

  // Check for override env var
  const skipFreshness = process.env["MINSKY_SKIP_FRESHNESS"];
  if (skipFreshness === "1") {
    const ts = new Date().toISOString();
    process.stdout.write(
      `[check-branch-fresh] OVERRIDE active (MINSKY_SKIP_FRESHNESS=1) — tool=${input.tool_name} ts=${ts}\n`
    );
    // mt#2889 PR #2012 R1 (class-not-instance fix, mirroring NON-BLOCKING #5's
    // check-generated-file-edit.ts fix): classify via the shared
    // classifyOverride() rather than a hardcoded literal, so a future
    // deregistration of this var from KNOWN_OVERRIDE_ENV_VARS correctly
    // downgrades the fire-log classification instead of silently lying.
    recordAndExit("allow", {
      overrideEnvVar: "MINSKY_SKIP_FRESHNESS",
      overrideClassification: classifyOverride("MINSKY_SKIP_FRESHNESS"),
    });
  }

  // Resolve the repo ROOT from the shell cwd (mt#2700): `input.cwd` is
  // routinely a subdirectory of the repo, which the `git -C` probes tolerate
  // (git walks up) but the fs-only mid-merge detection and the CAS-marker
  // write do not. All downstream consumers get the root.
  //
  // Nested-repo intent (PR #1851 R2): `findRepoRoot` stops at the NEAREST
  // enclosing `.git`, which is exactly the repo `git -C <input.cwd>` would
  // have discovered by its own upward walk — so handing the same nearest
  // root to the git subprocesses changes nothing for nested checkouts
  // (inner repo wins in both worlds); it only anchors the fs probes and
  // marker write to that same repo. Pinned by the nested-repo test in
  // check-branch-fresh.test.ts.
  const repoDir = findRepoRoot(input.cwd);

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

  // mt#2815: when blocked, attempt an inline clean-tree auto-merge before
  // falling back to denial. See attemptCleanTreeAutoMerge's header comment
  // for the full rationale and the protective-property guarantee (any
  // conflict aborts the merge and denies exactly as before — no silent
  // conflict resolution).
  //
  // mt#3484 (PR #2536 R1 BLOCKING #1): gate on POSITIVE overlap knowledge, not
  // on `blocked` alone. Post-mt#3484 there are two ways to be blocked, and only
  // one of them justifies mutating the branch:
  //   - `overlap.overlaps === true` — either a real file overlap, or an
  //     `undetermined` probe. Both warrant the attempt: a clean merge resolves
  //     the overlap, and on the undetermined path it also resolves the
  //     uncertainty that caused the block.
  //   - `overlap === undefined` — the budget-exhausted fallback, where the probe
  //     never ran. We do NOT know whether anything overlaps, and auto-merge
  //     WRITES to the branch. Attempting a mutation on a branch we have not
  //     established anything about is exactly the "narrowed scope" this task
  //     claims to have; running it here would make that claim false.
  let autoMergeOutcome: AutoMergeOutcome | undefined;
  if (shouldAttemptAutoMerge(result)) {
    autoMergeOutcome = attemptCleanTreeAutoMerge(
      repoDir,
      result.branchRef,
      result.mainRef,
      result.aheadCount,
      hookStart
    );
  }
  const autoMerged = autoMergeOutcome?.attempted === true && autoMergeOutcome.merged === true;
  const effectivelyBlocked = result.blocked && !autoMerged;

  if (!effectivelyBlocked) {
    // mt#1522: write the freshness CAS marker before emitting allow.
    // Only fires when ALL of the following hold:
    //   - tool === session_commit (spec scopes the CAS check there;
    //     session_pr_create / session_pr_edit are too infrequent for the
    //     seconds-class race to matter).
    //   - result.mainRef is set (mainRef detected).
    //   - result.comparisonRan === true (the listCommitsAhead probe
    //     actually executed — guards against the budget-exhausted-
    //     before-comparison path that returns mainRef without running
    //     the comparison; PR #963 R1 BLOCKING #6 fix).
    // Applies identically on the auto-merged path: the merge just landed
    // origin/main's commits locally, so capturing mainRef's current SHA
    // here is exactly the right marker for the residual push-time race.
    // Failure to write is non-fatal: surfaced as a warning so the operator
    // knows the CAS check won't fire on the next push (no worse than the
    // pre-mt#1522 baseline).
    if (
      input.tool_name === "mcp__minsky__session_commit" &&
      result.mainRef &&
      result.comparisonRan === true
    ) {
      const capturedSha = resolveRefSha(repoDir, result.mainRef);
      if (capturedSha === null) {
        warnings.push(
          `Could not resolve ${result.mainRef} to SHA for CAS marker — push-time CAS check will bypass`
        );
      } else {
        const writeResult = writeFreshnessMarker(repoDir, {
          mainRef: result.mainRef,
          sha: capturedSha,
          toolName: input.tool_name,
          ts: new Date().toISOString(),
        });
        if (!writeResult.ok) {
          warnings.push(
            `Could not write freshness marker (${writeResult.reason ?? "(no reason)"}) — push-time CAS check will bypass`
          );
        }
      }
    }

    // Behavioral Contract: silent paths emit no `reason` to stdout or
    // additionalContext. Non-silent paths (budget-exhausted) DO emit their
    // reason. Warnings (e.g., fetch failures) ALWAYS emit regardless of
    // silent — operators should know about staleness even on the silent
    // happy paths. This carve-out is documented in the header comment and
    // in the published Behavioral Contract (.minsky/rules/hook-files.mdc).
    // The auto-merge audit line (mt#2815) is likewise never silent — it
    // reports a real repo mutation and must always be visible.
    const isSilent = result.silent === true;
    const lines: string[] = [];
    if (!isSilent) {
      lines.push(`[check-branch-fresh] ${result.reason}`);
    }
    if (autoMerged && autoMergeOutcome?.attempted && autoMergeOutcome.merged) {
      lines.push(
        `[check-branch-fresh] auto-merged ${autoMergeOutcome.mergedCommitCount} commit(s) from ${result.mainRef} into ${result.branchRef ?? "the current branch"} (clean tree, no conflicts) — proceeding without a manual session_update round-trip.`
      );
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
    recordAndExit("allow", undefined, result.comparisonRan === true ? "decided" : "crashed");
  }

  // Blocked: format and emit denial. Reuse `result.mainRef` and the EXACT
  // compared ref via `denialBranchName(result)` (PR #1851 R1 BLOCKING #1)
  // instead of re-detecting — re-detection could yield different values
  // under flaky probes, AND re-detection would run outside the budget guard.
  const mainRef = result.mainRef ?? "origin/main";

  // mt#3484 criterion 5: probe which of the two behind-states this is, so the
  // message can name the right remedy. Budget-guarded and failure-tolerant —
  // `null` (probe failed or budget gone) renders the generic session_update
  // guidance rather than asserting the wrong one.
  const localHasMain = budgetAllows(hookStart, GIT_TIMEOUT_MS)
    ? localBranchContainsMain(repoDir, mainRef, GIT_TIMEOUT_MS)
    : null;

  const message = formatBlockMessage(
    denialBranchName(result),
    mainRef,
    result.aheadCount,
    result.aheadSubjects,
    result.overlap,
    localHasMain
  );

  // When fetch failed, the comparison ran against possibly-stale refs.
  // Surface that prominently in the deny message so operators don't act on
  // a block whose evidence may be hours old.
  let fullMessage =
    warnings.length > 0
      ? `${message}\n\nWarnings:\n${warnings.map((w) => `  [check-branch-fresh] ${w}`).join("\n")}`
      : message;

  // mt#2815: surface that an auto-merge was attempted and hit conflicts,
  // so the agent knows a resolution attempt already happened before it
  // sees the standard "run session_update" guidance below.
  if (autoMergeOutcome?.attempted === true && autoMergeOutcome.merged === false) {
    const files =
      autoMergeOutcome.conflictedFiles.length > 0
        ? `\nConflicted file(s): ${autoMergeOutcome.conflictedFiles.join(", ")}`
        : "";
    fullMessage += `\n\n[check-branch-fresh] Auto-merge attempted (mt#2815) but hit conflicts — aborted, falling back to manual resolution.${files}`;
  }

  writeOutput({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: fullMessage,
    },
  });
  recordAndExit("deny", undefined, result.comparisonRan === true ? "decided" : "crashed");
}
