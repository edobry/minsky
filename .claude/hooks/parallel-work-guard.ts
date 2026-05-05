#!/usr/bin/env bun
// PreToolUse hook: block mcp__minsky__session_start when parallel work is detected.
//
// Rationale: Starting a new session while another open PR or a recently-merged commit
// touches the same files produces silent merge conflicts, duplicated effort, and broken
// session state. This hook enforces the parallel-work check that mt#1305 added to the
// /plan-task and /implement-task skills — but structurally, at the tool call boundary,
// so it fires regardless of which skill (or no skill) led to session_start.
//
// Two checks are run:
//   A. Open-PR sweep: any open PR whose changed files overlap the task's in-scope paths.
//   B. Recently-merged sweep: any commit on the default branch in the last 24h touching in-scope paths.
//
// On hit: BLOCK with structured message listing the colliding PR/commit.
// On miss or warn: permit.
// Override: MINSKY_FORCE_PARALLEL=1 env var bypasses with audit log.
//
// @see mt#1362 — Tier-3 structural ceiling for the parallel-work guard ladder
// @see mt#1305 — Tier-2 skill-step enforcement (floor)
// @see feedback_check_parallel_work_before_decomposing — four-incident history

import { readInput, writeOutput, execWithPath } from "./types";
import type { ToolHookInput } from "./types";

// NOTE: execWithPath is centralized in types.ts and imported above.
// This avoids duplicating the PATH-augmentation logic across hooks.
// See NON-BLOCKING #5 from PR #909 round 1 review.

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ParallelWorkCollision {
  type: "open-pr" | "recently-merged";
  prNumber?: number;
  prTitle?: string;
  commitSha?: string;
  commitMessage?: string;
  overlappingFiles: string[];
}

export interface ParallelWorkCheckInput {
  taskId: string;
  inScopeFiles: string[];
  repo: string;
  lookbackHours: number;
}

export interface ParallelWorkCheckResult {
  blocked: boolean;
  collisions: ParallelWorkCollision[];
  warnings: string[];
}

// ---------------------------------------------------------------------------
// Spec parsing
// ---------------------------------------------------------------------------

/**
 * Extract the `## Scope` → `**In scope:**` file paths from a task spec.
 * Returns the list of paths found and any parse warnings.
 *
 * Strategy: find the "In scope:" bullet list between "## Scope" and the next
 * heading or end of content. Extract lines that look like file paths
 * (contain `/` or start with `.`).
 */
export function extractInScopeFiles(specContent: string): {
  files: string[];
  warnings: string[];
} {
  const warnings: string[] = [];

  // Find ## Scope section. Loosened from strict `^##\s+Scope\s*$` to allow an
  // optional trailing colon (`## Scope:`) since some specs in this repo use
  // that variant. Still anchors at start-of-line and requires `## ` prefix.
  const scopeMatch = specContent.match(/^##\s+Scope:?\s*$/m);
  if (!scopeMatch) {
    warnings.push("No '## Scope' section found in spec — parallel-work check skipped");
    return { files: [], warnings };
  }

  const scopeStart = (scopeMatch.index ?? 0) + scopeMatch[0].length;
  // Find next ## heading or end of string
  const nextHeadingMatch = specContent.slice(scopeStart).match(/^##\s+/m);
  const scopeEnd =
    nextHeadingMatch !== null && nextHeadingMatch.index !== undefined
      ? scopeStart + nextHeadingMatch.index
      : specContent.length;

  const scopeContent = specContent.slice(scopeStart, scopeEnd);

  // Find "**In scope:**" or "**In scope (parenthetical):**" block.
  // Some specs use a parenthetical suffix like `**In scope (this task):**`
  // (e.g., mt#1305-style). The `[^*]*?` allows any non-asterisk chars between
  // "In scope" and ":**", capturing both forms.
  const inScopeMatch = scopeContent.match(/\*\*In scope[^*]*?:\*\*/i);
  if (!inScopeMatch) {
    warnings.push(
      "No '**In scope:**' block found in ## Scope section — parallel-work check skipped"
    );
    return { files: [], warnings };
  }

  const inScopeStart = (inScopeMatch.index ?? 0) + inScopeMatch[0].length;
  // Find next bold section or end of scope content
  const nextBoldMatch = scopeContent.slice(inScopeStart).match(/\*\*\w/);
  const inScopeEnd =
    nextBoldMatch !== null && nextBoldMatch.index !== undefined
      ? inScopeStart + nextBoldMatch.index
      : scopeContent.length;

  const inScopeContent = scopeContent.slice(inScopeStart, inScopeEnd);

  // Extract lines that look like file paths
  const files: string[] = [];
  for (const line of inScopeContent.split("\n")) {
    const trimmed = line.trim();
    // Match: bullet list item containing a file path (has / or starts with .)
    // Common patterns:
    //   "- `src/foo/bar.ts`"         (backtick-wrapped, starts with letter)
    //   "- `src/foo/bar.ts` (new)"   (backtick-wrapped with annotation)
    //   "- `.claude/hooks/x.ts`"     (backtick-wrapped, starts with .)
    //   "- src/foo/bar.ts (new)"     (unquoted)
    //
    // Strategy: extract the backtick-wrapped token if present, else match
    // a bare path token that contains a /
    const backtickMatch = trimmed.match(/^[-*]\s+`([^`]+)`/);
    if (backtickMatch) {
      const rawPath = backtickMatch[1].trim();
      // Only include if it looks like a file or directory path (contains / or starts with .)
      if ((rawPath.includes("/") || rawPath.startsWith(".")) && rawPath.length > 0) {
        files.push(rawPath);
      }
      continue;
    }
    // Fallback: bare path token (must contain /). Lead character class accepts
    // letters, digits, underscore, dot, and @ so that scoped-package paths
    // like @types/foo/index.d.ts are matched in addition to ordinary paths.
    const bareMatch = trimmed.match(/^[-*]\s+([@\w.][^\s(,]+\/[^\s(,]*)/);
    if (bareMatch) {
      const rawPath = bareMatch[1].replace(/\/$/, "").trim();
      if (rawPath.length > 0) {
        files.push(rawPath);
      }
    }
  }

  if (files.length === 0) {
    warnings.push(
      "Could not extract file paths from '**In scope:**' block — parallel-work check skipped"
    );
  }

  return { files, warnings };
}

// ---------------------------------------------------------------------------
// Append-only structured-config exemption
// ---------------------------------------------------------------------------

/**
 * Files where overlap is structurally non-conflicting when both PRs only
 * append entries to existing JSON arrays. These are config files that
 * register independent items (hooks, plugins, rules) — adding a new entry
 * doesn't conflict with another PR adding a different entry.
 *
 * The mechanism: `isAppendOnlyToJsonArrays` performs a structural check
 * comparing BEFORE and AFTER JSON. When the change is purely "added new
 * elements to existing arrays" (no modifications to existing values, no
 * new object keys), the change is exempt from the parallel-work guard.
 *
 * @see mt#1587 — origin task; see also `feedback_check_parallel_work_before_decomposing`
 */
export const STRUCTURED_CONFIG_ALLOWLIST: readonly string[] = [
  ".claude/settings.json",
  ".claude/settings.local.json",
] as const;

/**
 * True iff `after` differs from `before` only by appending new elements to
 * existing JSON arrays at any depth. Specifically:
 *   - At every object path, AFTER must have the SAME set of keys as BEFORE
 *     (no added keys, no removed keys).
 *   - At every array path, AFTER must equal BEFORE in the first
 *     `before.length` positions (i.e., BEFORE is a prefix of AFTER).
 *     New elements may appear after BEFORE's last index.
 *   - At every primitive path, AFTER must equal BEFORE exactly.
 *
 * Returns false on any deviation (modified value, deleted key, added key
 * outside an array, array shrunk, array element modified at an existing
 * index). The caller treats false as "real conflict, keep collision."
 *
 * Pure function — no I/O.
 */
export function isAppendOnlyToJsonArrays(before: unknown, after: unknown): boolean {
  // Arrays: AFTER must extend BEFORE at the tail; existing indices must match.
  if (Array.isArray(before)) {
    if (!Array.isArray(after)) return false;
    if (after.length < before.length) return false;
    for (let i = 0; i < before.length; i++) {
      if (!deepJsonEqual(before[i], after[i])) return false;
    }
    return true;
  }

  // Objects: same key set, recursively compatible values.
  if (before !== null && typeof before === "object") {
    if (after === null || typeof after !== "object" || Array.isArray(after)) {
      return false;
    }
    const beforeRecord = before as Record<string, unknown>;
    const afterRecord = after as Record<string, unknown>;
    const beforeKeys = Object.keys(beforeRecord);
    const afterKeys = Object.keys(afterRecord);
    if (afterKeys.length !== beforeKeys.length) {
      // AFTER added or removed object keys — not append-only-to-arrays.
      return false;
    }
    for (const key of beforeKeys) {
      if (!Object.prototype.hasOwnProperty.call(afterRecord, key)) return false;
      if (!isAppendOnlyToJsonArrays(beforeRecord[key], afterRecord[key])) {
        return false;
      }
    }
    return true;
  }

  // Primitives (and null): strict equality.
  return deepJsonEqual(before, after);
}

/**
 * Order-insensitive structural deep-equality (PR #952 R3#2 fix).
 *
 * For objects, compares the same key SET regardless of insertion order; for
 * arrays, compares element-by-element at the same index (order matters);
 * for primitives, strict equality. This avoids the false-non-exemption that
 * a JSON.stringify-based check produced when two semantically-equal objects
 * had different key insertion orders across refs (e.g., one prettified, one
 * hand-edited).
 *
 * Sufficient for our use case (settings.json contents — no functions, no
 * Dates, no cycles).
 */
function deepJsonEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;

  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (!deepJsonEqual(a[i], b[i])) return false;
    }
    return true;
  }

  if (a !== null && typeof a === "object") {
    if (b === null || typeof b !== "object" || Array.isArray(b)) return false;
    const aRecord = a as Record<string, unknown>;
    const bRecord = b as Record<string, unknown>;
    const aKeys = Object.keys(aRecord);
    const bKeys = Object.keys(bRecord);
    if (aKeys.length !== bKeys.length) return false;
    for (const key of aKeys) {
      if (!Object.prototype.hasOwnProperty.call(bRecord, key)) return false;
      if (!deepJsonEqual(aRecord[key], bRecord[key])) return false;
    }
    return true;
  }

  // Primitives + null: strict equality (already handled by `a === b` above
  // for most cases; this branch handles NaN-vs-NaN, but we treat NaN !== NaN
  // per IEEE — non-issue for JSON since NaN is not representable).
  return false;
}

/**
 * Fetch file content at a specific git ref via the GitHub Contents API.
 * Returns the decoded UTF-8 content, or null on failure.
 *
 * Adds a warning to the provided array on failure so the caller can surface
 * partial-coverage notes without aborting the whole sweep.
 */
export function fetchFileContentAtRef(
  repo: string,
  ref: string,
  filePath: string,
  warnings: string[]
): string | null {
  // Hard guard: the GitHub Contents API rejects rev-spec expressions like
  // <sha>^, <sha>~1, HEAD^, etc. — only branch names, tags, refs/pull/N/head,
  // and 40-char SHAs are accepted. Callers must resolve rev-specs to
  // concrete SHAs BEFORE calling this function (see fetchRecentMerges'
  // git rev-parse). Defense-in-depth against future regressions
  // reintroducing the bug — PR #952 R4#2.
  if (/[\^~]/.test(ref)) {
    warnings.push(
      `Refusing to fetch ${filePath}@${ref}: ref contains rev-spec syntax (^/~) which the GitHub Contents API rejects. Resolve to a concrete SHA before calling fetchFileContentAtRef.`
    );
    return null;
  }

  // Encode each path SEGMENT separately and rejoin with '/'. encodeURIComponent
  // on the full path encodes '/' as '%2F', which the GitHub Contents API
  // rejects with 404 — disabling the exemption entirely (PR #952 R1 BLOCKING).
  // The ref query parameter is still fully encoded.
  const encodedPath = filePath.split("/").map(encodeURIComponent).join("/");
  const result = execWithPath(
    [
      "gh",
      "api",
      `repos/${repo}/contents/${encodedPath}?ref=${encodeURIComponent(ref)}`,
      "--jq",
      ".content",
    ],
    { timeout: GH_GIT_TIMEOUT_MS }
  );

  if (result.exitCode !== 0) {
    warnings.push(
      `Could not fetch ${filePath}@${ref}: gh exited ${result.exitCode}: ${result.stderr || result.stdout}`
    );
    return null;
  }

  const base64 = result.stdout.trim().replace(/\n/g, "");
  if (!base64) {
    warnings.push(`Empty content for ${filePath}@${ref}`);
    return null;
  }

  try {
    return Buffer.from(base64, "base64").toString("utf8");
  } catch (err) {
    warnings.push(
      `Could not decode ${filePath}@${ref}: ${err instanceof Error ? err.message : String(err)}`
    );
    return null;
  }
}

/**
 * Check whether the change to `filePath` between `fromRef` and `toRef` is
 * append-only into JSON arrays.
 *
 * Fetches the file content at both refs via `gh api`, parses both as JSON,
 * and runs `isAppendOnlyToJsonArrays`. Returns false on any fetch, parse,
 * or structural-check failure (fail-closed: preserve the collision if we
 * can't prove it's safe).
 *
 * Used to filter STRUCTURED_CONFIG_ALLOWLIST hits out of the open-PR and
 * recently-merged collision lists. Both refs MUST be concrete refs the
 * GitHub Contents API can resolve — branch names, tags, full SHAs, or
 * `refs/pull/<num>/head`. Rev-spec syntax (`^`, `~`) is rejected by
 * `fetchFileContentAtRef`; callers must resolve parent SHAs ahead of
 * time (see `fetchRecentMerges` for the canonical pattern using
 * `git rev-parse <sha>^`).
 *
 * Typical refs:
 *   - For open PRs: fromRef = base branch name (e.g., "main"),
 *     toRef = `refs/pull/<num>/head`.
 *   - For recently-merged commits: fromRef = parent SHA resolved via
 *     `git rev-parse <sha>^`, toRef = the merge commit SHA.
 */
export function isFileChangeAppendOnly(
  repo: string,
  fromRef: string,
  toRef: string,
  filePath: string,
  warnings: string[]
): boolean {
  const beforeContent = fetchFileContentAtRef(repo, fromRef, filePath, warnings);
  const afterContent = fetchFileContentAtRef(repo, toRef, filePath, warnings);
  if (beforeContent === null || afterContent === null) {
    return false;
  }

  let beforeJson: unknown;
  let afterJson: unknown;
  try {
    beforeJson = JSON.parse(beforeContent);
    afterJson = JSON.parse(afterContent);
  } catch (err) {
    warnings.push(
      `Could not parse JSON for ${filePath} on ref pair ${fromRef}…${toRef}: ${err instanceof Error ? err.message : String(err)}`
    );
    return false;
  }

  return isAppendOnlyToJsonArrays(beforeJson, afterJson);
}

// ---------------------------------------------------------------------------
// Check A: Open-PR sweep
// ---------------------------------------------------------------------------

interface PrInfo {
  number: number;
  title: string;
  headRefName: string;
}

/**
 * Server-side cap for the open-PR fetch. Aligned with `MAX_PRS_TO_SCAN` in
 * `checkOpenPrs` — if you raise one, raise the other.
 */
const FETCH_OPEN_PRS_LIMIT = 200;

/**
 * Per-subprocess timeout in milliseconds for gh/git calls. The PreToolUse
 * hook has a 30s overall budget; per-call caps prevent a single slow
 * subprocess from consuming it. Treat timeouts as warnings (fail-open).
 *
 * Lowered from 10s to 5s so that even degraded per-PR lookups can't
 * cumulatively blow the 30s budget across 200 sequential calls.
 */
const GH_GIT_TIMEOUT_MS = 5_000;

/**
 * Overall wall-clock budget (in ms) for `checkOpenPrs` to scan its slice
 * of the PR list. Headroom under the 30s PreToolUse hook timeout. When
 * the elapsed time approaches this, the sweep stops early with a warning
 * rather than risking a SIGTERM mid-call.
 */
const OPEN_PR_SWEEP_BUDGET_MS = 25_000;

/**
 * Fetch open PRs from the repository.
 *
 * Uses `gh pr list --state=open --limit N` so the cap is enforced
 * **at the server**: we never walk past N PRs over the network, even when
 * the repo has thousands. This bounds the work for the per-PR sweep and
 * keeps the hook within its 30s budget.
 *
 * Throws on non-zero exit so the caller (runParallelWorkChecks) can surface
 * the failure as a warning rather than silently returning [].
 */
export function fetchOpenPrs(repo: string): PrInfo[] {
  const result = execWithPath(
    [
      "gh",
      "pr",
      "list",
      "--repo",
      repo,
      "--state",
      "open",
      "--limit",
      String(FETCH_OPEN_PRS_LIMIT),
      "--json",
      "number,title,headRefName",
    ],
    { timeout: GH_GIT_TIMEOUT_MS }
  );

  if (result.exitCode !== 0) {
    throw new Error(`gh pr list exited ${result.exitCode}: ${result.stderr || result.stdout}`);
  }

  if (!result.stdout.trim()) {
    return [];
  }

  try {
    return JSON.parse(result.stdout) as PrInfo[];
  } catch (err) {
    throw new Error(
      `gh pr list returned unparseable JSON: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

/**
 * Fetch the list of changed files for a PR number.
 *
 * Unlike fetchOpenPrs, this function does NOT throw on non-zero exit — a
 * single PR lookup failure should not abort the whole sweep. Instead it
 * pushes to the provided warnings array and returns [].
 */
export function fetchPrFiles(repo: string, prNumber: number, warnings: string[] = []): string[] {
  const result = execWithPath(
    [
      "gh",
      "pr",
      "view",
      String(prNumber),
      "--repo",
      repo,
      "--json",
      "files",
      "--jq",
      ".files[].path",
    ],
    { timeout: GH_GIT_TIMEOUT_MS }
  );

  if (result.exitCode !== 0) {
    warnings.push(
      `Could not fetch files for PR #${prNumber}: gh exited ${result.exitCode}: ${result.stderr || result.stdout}`
    );
    return [];
  }

  if (!result.stdout.trim()) {
    return [];
  }

  return result.stdout
    .trim()
    .split("\n")
    .filter((f) => f.length > 0);
}

/**
 * Check if any of the `inScopeFiles` patterns overlap with `prFiles`.
 *
 * Match semantics: exact file equality OR directory-prefix bounded by a
 * path separator (`/`). The boundary is critical — a boundary-less prefix
 * check would false-match `src/app` against `src/application/config.ts`,
 * blocking valid sessions.
 *
 * Both directions are checked: a scope entry may be either a file
 * (matched as equality) or a directory (matched via `${normalizedScope}/`
 * prefix on prFile, or vice versa if the PR's file list happens to
 * include directory entries).
 *
 * Trailing slashes are normalized away on both sides so `src/foo/` and
 * `src/foo` behave identically.
 */
export function findOverlappingFiles(inScopeFiles: string[], prFiles: string[]): string[] {
  const overlapping: string[] = [];
  const normalize = (p: string): string => p.replace(/^\.\//, "").replace(/\/$/, "");
  for (const scopeFile of inScopeFiles) {
    const normalizedScope = normalize(scopeFile);
    for (const rawPrFile of prFiles) {
      const normalizedPrFile = normalize(rawPrFile);
      const matches =
        normalizedPrFile === normalizedScope ||
        normalizedPrFile.startsWith(`${normalizedScope}/`) ||
        normalizedScope.startsWith(`${normalizedPrFile}/`);
      if (matches) {
        if (!overlapping.includes(rawPrFile)) {
          overlapping.push(rawPrFile);
        }
        break;
      }
    }
  }
  return overlapping;
}

/**
 * Decide whether a PR's branch should be treated as the task's own branch
 * (and therefore skipped to avoid self-collision).
 *
 * Only one mode: exact equality with `currentBranch` (the actual HEAD of the
 * session repo). If `currentBranch` is null or undefined, no skip occurs —
 * the branch is treated as a peer. This prevents a teammate's PR using the
 * same task ID (different author, different scope variant) from being silently
 * skipped by a token-based heuristic, which was the root failure mode this
 * guard exists to catch.
 *
 * Round-10 BLOCKING fix: prior token-based heuristic was removed because it
 * matched any branch whose name contained the task token as a delimited
 * segment (e.g. "feature/mt-1362"), hiding legitimate peer PRs that share
 * the same task ID.
 */
export function isOwnBranch(
  branchName: string,
  _taskId: string,
  currentBranch?: string | null
): boolean {
  if (currentBranch && branchName === currentBranch) {
    return true;
  }
  return false;
}

/**
 * Run the open-PR sweep. Skips PRs whose branch exactly matches the session's
 * current branch (per `isOwnBranch`) to avoid false self-collision.
 *
 * `fetchPrs` and `fetchFiles` are injectable so tests can exercise the
 * collision/no-collision paths without live `gh` calls.
 *
 * The `warnings` array is threaded through to fetchFiles so that individual
 * per-PR lookup failures are surfaced without aborting the sweep.
 */
export function checkOpenPrs(
  input: ParallelWorkCheckInput,
  currentBranch?: string | null,
  fetchPrs: (repo: string) => PrInfo[] = fetchOpenPrs,
  fetchFiles: (repo: string, prNumber: number, warnings: string[]) => string[] = fetchPrFiles,
  warnings: string[] = [],
  baseBranch: string = "main",
  isAppendOnly: (
    repo: string,
    fromRef: string,
    toRef: string,
    filePath: string,
    warnings: string[]
  ) => boolean = isFileChangeAppendOnly
): ParallelWorkCollision[] {
  // Start the sweep budget timer BEFORE the fetchOpenPrs call so that the
  // time spent fetching the PR list counts against the 25s budget. Without
  // this, a slow fetchOpenPrs (up to GH_GIT_TIMEOUT_MS=5s) plus N×5s per-PR
  // lookups could exceed the 30s PreToolUse cap.
  const sweepStart = Date.now();
  const prs = fetchPrs(input.repo);
  const collisions: ParallelWorkCollision[] = [];

  // Bound the per-PR sweep two ways:
  //   1. Hard cap at MAX_PRS_TO_SCAN (200) — matches the server-side cap
  //      in fetchOpenPrs. Because gh pr list --limit truncates at the
  //      server, in production prs.length will never exceed 200; this
  //      slice is a defense-in-depth check for tests that bypass that
  //      cap via injected deps.
  //   2. Wall-clock budget — stop early if cumulative scan time approaches
  //      the 30s hook timeout, so we always emit a structured allow/deny
  //      rather than getting SIGTERM'd mid-call.
  const MAX_PRS_TO_SCAN = 200;
  const prsToScan = prs.slice(0, MAX_PRS_TO_SCAN);
  // Emit warning when:
  //   (a) injected deps returned > 200 PRs (test-only path), OR
  //   (b) production fetch hit the server-side cap exactly (likely
  //       truncated — total open PR count is unknown but ≥200).
  if (prs.length > MAX_PRS_TO_SCAN) {
    warnings.push(
      `Open-PR sweep capped at ${MAX_PRS_TO_SCAN} of ${prs.length} open PRs (preserves 30s hook budget)`
    );
  } else if (prs.length === MAX_PRS_TO_SCAN) {
    warnings.push(
      `Open-PR sweep at server cap of ${MAX_PRS_TO_SCAN} PRs — total count unknown, additional PRs may exist beyond this set`
    );
  }

  let scannedCount = 0;
  let abortedForBudget = false;

  for (const pr of prsToScan) {
    // Time-budget check — fire BEFORE the next subprocess so we never
    // start a call we can't afford to finish.
    if (Date.now() - sweepStart >= OPEN_PR_SWEEP_BUDGET_MS) {
      abortedForBudget = true;
      break;
    }

    // Skip the task's own PR branch (exact currentBranch match only)
    if (isOwnBranch(pr.headRefName, input.taskId, currentBranch)) {
      continue;
    }

    const prFiles = fetchFiles(input.repo, pr.number, warnings);
    scannedCount += 1;
    const overlapping = findOverlappingFiles(input.inScopeFiles, prFiles);

    if (overlapping.length === 0) {
      continue;
    }

    // Filter out STRUCTURED_CONFIG_ALLOWLIST files whose change in this PR
    // is purely append-only into JSON arrays — those don't conflict with
    // a peer PR also adding entries (mt#1587). Each filtered file emits a
    // warning so operators can audit the exemption. Allowlisted files that
    // FAIL the structural check also emit a triage hint (PR #952 R1 inline
    // nit) so operators understand why a collision was kept.
    // Use `refs/pull/<num>/head` — the canonical PR-head ref that GitHub
    // always provides in the base repo's namespace, regardless of whether
    // the PR is from a fork. PR #952 R4#1 fix replacing the R3#1 attempt
    // (which used pr.headRefOid — a fork-only SHA for forked PRs, not
    // addressable via the base repo's Contents API).
    const toRef = `refs/pull/${pr.number}/head`;
    const realOverlapping = overlapping.filter((file) => {
      if (!STRUCTURED_CONFIG_ALLOWLIST.includes(file)) return true;
      // Mid-iteration budget recheck (PR #952 R5#4): each isAppendOnly call
      // can issue up to two `gh api` calls (BEFORE + AFTER content fetch).
      // If the budget is nearly exhausted, fail-closed rather than risking
      // SIGTERM mid-fetch.
      if (Date.now() - sweepStart >= OPEN_PR_SWEEP_BUDGET_MS) {
        warnings.push(
          `PR #${pr.number}: ${file} structural-config exemption skipped (budget exhausted) — keeping collision`
        );
        return true;
      }
      const isExempt = isAppendOnly(input.repo, baseBranch, toRef, file, warnings);
      if (isExempt) {
        warnings.push(
          `PR #${pr.number}: ${file} change is append-only into JSON arrays — exempted from collision`
        );
      } else {
        warnings.push(
          `PR #${pr.number}: ${file} is allowlisted but its change is NOT append-only — keeping collision`
        );
      }
      return !isExempt;
    });

    if (realOverlapping.length > 0) {
      collisions.push({
        type: "open-pr",
        prNumber: pr.number,
        prTitle: pr.title,
        overlappingFiles: realOverlapping,
      });
    }
  }

  if (abortedForBudget) {
    warnings.push(
      `Open-PR sweep aborted at ${scannedCount} of ${prsToScan.length} PRs after ${Math.round(
        (Date.now() - sweepStart) / 1000
      )}s (partial scan; 30s hook budget approaching)`
    );
  }

  return collisions;
}

// ---------------------------------------------------------------------------
// Check B: Recently-merged sweep
// ---------------------------------------------------------------------------

interface GitLogEntry {
  sha: string;
  message: string;
  files: string[];
}

/**
 * Detect the default remote branch ref (e.g. "origin/main"). Tries multiple
 * sources in order so repos with master, custom defaults, or unset symbolic
 * refs are all handled correctly. Only warns and falls back when ALL probes
 * fail — addresses the round-5 BLOCKING finding that the previous single-shot
 * fallback to "origin/main" silently disabled the recently-merged sweep on
 * any repo whose default isn't main.
 *
 * Probe order:
 *   1. `git symbolic-ref refs/remotes/origin/HEAD` — fastest, exact answer
 *   2. `git remote show origin` — parses "HEAD branch: <name>" line
 *   3. `git rev-parse --verify origin/main` — probe explicit
 *   4. `git rev-parse --verify origin/master` — probe explicit
 *
 * Returns `{ref: null, warning}` if all probes fail; the caller should treat
 * that as "skip recently-merged sweep" rather than fall back to a wrong ref.
 */
export function detectDefaultBranch(repoDir: string): { ref: string | null; warning?: string } {
  // Probe 1: symbolic ref
  const symbolic = execWithPath(
    ["git", "-C", repoDir, "symbolic-ref", "refs/remotes/origin/HEAD"],
    { timeout: GH_GIT_TIMEOUT_MS }
  );
  if (symbolic.exitCode === 0 && symbolic.stdout.trim()) {
    return { ref: symbolic.stdout.trim().replace(/^refs\/remotes\//, "") };
  }

  // Probe 2: `git remote show origin` — parses "HEAD branch: <name>"
  const remoteShow = execWithPath(["git", "-C", repoDir, "remote", "show", "origin"], {
    timeout: GH_GIT_TIMEOUT_MS,
  });
  if (remoteShow.exitCode === 0) {
    const headMatch = remoteShow.stdout.match(/^\s*HEAD branch:\s*(\S+)\s*$/m);
    if (headMatch && headMatch[1] !== "(unknown)") {
      return { ref: `origin/${headMatch[1]}` };
    }
  }

  // Probes 3 and 4: try common defaults explicitly
  for (const candidate of ["main", "master"]) {
    const probe = execWithPath(
      ["git", "-C", repoDir, "rev-parse", "--verify", `origin/${candidate}`],
      { timeout: GH_GIT_TIMEOUT_MS }
    );
    if (probe.exitCode === 0) {
      return { ref: `origin/${candidate}` };
    }
  }

  return {
    ref: null,
    warning:
      "Could not detect default remote branch via symbolic-ref, `remote show origin`, or `origin/main`/`origin/master` probes; recently-merged sweep skipped",
  };
}

/**
 * Fetch commits on the default branch in the last `hours` hours that touch
 * any of the in-scope paths. Uses `git log --name-only` for file list.
 *
 * Strategy: follow the default branch's first-parent lineage (so we don't
 * recurse into merged branches' individual commits) AND include merge commits
 * with `-m --diff-merges=first-parent` so the merge commit reports the file
 * set brought in by the merged PR. The repo's policy is to use merge-method
 * merges (see docs/pr-workflow.md §Merge method policy), so excluding
 * merges (`--no-merges`) was missing exactly the just-landed PR commits
 * this sweep is meant to catch.
 *
 * Throws on non-zero exit so the caller (runParallelWorkChecks) can surface
 * the failure as a warning rather than silently returning [].
 */
export function fetchRecentMerges(
  repoDir: string,
  inScopeFiles: string[],
  hours: number,
  defaultBranchRef?: string,
  repo?: string,
  warnings: string[] = [],
  isAppendOnly: (
    repo: string,
    fromRef: string,
    toRef: string,
    filePath: string,
    warnings: string[]
  ) => boolean = isFileChangeAppendOnly
): ParallelWorkCollision[] {
  // Wall-clock budget for the merge sweep (PR #952 R5#5). Mirror of
  // OPEN_PR_SWEEP_BUDGET_MS — a per-commit `git rev-parse` plus up to two
  // `gh api` calls per allowlisted file can blow the 30s PreToolUse cap on
  // busy repos with many recent merges.
  const sweepStart = Date.now();
  const MERGE_SWEEP_BUDGET_MS = 25_000;

  // ISO timestamp for `hours` ago
  const since = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();

  const branchRef = defaultBranchRef ?? "origin/main";

  // Get log with file names in the last N hours on the default branch
  const result = execWithPath(
    [
      "git",
      "-C",
      repoDir,
      "log",
      branchRef,
      `--since=${since}`,
      "--first-parent",
      "-m",
      "--diff-merges=first-parent",
      "--name-only",
      "--format=COMMIT:%H %s",
    ],
    { timeout: GH_GIT_TIMEOUT_MS }
  );

  if (result.exitCode !== 0) {
    throw new Error(`git log exited ${result.exitCode}: ${result.stderr || result.stdout}`);
  }

  if (!result.stdout.trim()) {
    return [];
  }

  // Parse output: each commit is delimited by a COMMIT: line, followed by file names
  const entries: GitLogEntry[] = [];
  let current: GitLogEntry | null = null;

  for (const line of result.stdout.split("\n")) {
    const commitMatch = line.match(/^COMMIT:([0-9a-f]+)\s+(.*)/);
    if (commitMatch) {
      if (current) entries.push(current);
      current = { sha: commitMatch[1], message: commitMatch[2], files: [] };
    } else if (current && line.trim().length > 0) {
      current.files.push(line.trim());
    }
  }
  if (current) entries.push(current);

  // Find overlapping commits
  const collisions: ParallelWorkCollision[] = [];
  let mergeBudgetAborted = false;
  for (const entry of entries) {
    // Per-commit wall-clock budget check (PR #952 R5#5). Stop early if
    // the cumulative scan time approaches the 30s hook timeout.
    if (Date.now() - sweepStart >= MERGE_SWEEP_BUDGET_MS) {
      mergeBudgetAborted = true;
      break;
    }

    const overlapping = findOverlappingFiles(inScopeFiles, entry.files);
    if (overlapping.length === 0) {
      continue;
    }

    // Filter out STRUCTURED_CONFIG_ALLOWLIST files whose change in this
    // commit was append-only into JSON arrays. Skip the filter when `repo`
    // wasn't supplied (legacy callers / tests) — preserve original behavior.
    let realOverlapping = overlapping;
    if (repo) {
      // Resolve <sha>^ to a real 40-char SHA before passing to the GitHub
      // Contents API. The Contents API rejects rev-spec expressions like
      // "<sha>^" or "<sha>~1" — only branch names, tags, and full SHAs work.
      // PR #952 R3#3 fix.
      const parentResult = execWithPath(["git", "-C", repoDir, "rev-parse", `${entry.sha}^`], {
        timeout: GH_GIT_TIMEOUT_MS,
      });
      const parentSha = parentResult.exitCode === 0 ? parentResult.stdout.trim() : null;
      if (!parentSha) {
        warnings.push(
          `Commit ${entry.sha.slice(0, 7)}: could not resolve parent SHA via git rev-parse — keeping all overlapping files as collisions`
        );
      }
      realOverlapping = overlapping.filter((file) => {
        if (!STRUCTURED_CONFIG_ALLOWLIST.includes(file)) return true;
        if (!parentSha) return true; // fail-closed: keep collision
        // Mid-iteration budget recheck (PR #952 R5#5): each isAppendOnly
        // call adds two `gh api` calls. Fail-closed if budget exhausted.
        if (Date.now() - sweepStart >= MERGE_SWEEP_BUDGET_MS) {
          warnings.push(
            `Commit ${entry.sha.slice(0, 7)}: ${file} structural-config exemption skipped (budget exhausted) — keeping collision`
          );
          return true;
        }
        const isExempt = isAppendOnly(repo, parentSha, entry.sha, file, warnings);
        if (isExempt) {
          warnings.push(
            `Commit ${entry.sha.slice(0, 7)}: ${file} change is append-only into JSON arrays — exempted from collision`
          );
        } else {
          warnings.push(
            `Commit ${entry.sha.slice(0, 7)}: ${file} is allowlisted but its change is NOT append-only — keeping collision`
          );
        }
        return !isExempt;
      });
    } else {
      // Surface the skipped-exemption case explicitly so operators can see
      // when an allowlisted file was kept as a collision because no `repo`
      // slug was available (PR #952 R1 NON-BLOCKING #4).
      const skippedAllowlisted = overlapping.filter((f) => STRUCTURED_CONFIG_ALLOWLIST.includes(f));
      if (skippedAllowlisted.length > 0) {
        warnings.push(
          `Commit ${entry.sha.slice(0, 7)}: structural-config exemption skipped for ${skippedAllowlisted.join(", ")} — no GitHub repo slug supplied`
        );
      }
    }

    if (realOverlapping.length > 0) {
      collisions.push({
        type: "recently-merged",
        commitSha: entry.sha.slice(0, 7),
        commitMessage: entry.message,
        overlappingFiles: realOverlapping,
      });
    }
  }

  if (mergeBudgetAborted) {
    warnings.push(
      `Recently-merged sweep aborted after ${Math.round((Date.now() - sweepStart) / 1000)}s (partial scan; 30s hook budget approaching)`
    );
  }

  return collisions;
}

// ---------------------------------------------------------------------------
// Main check logic
// ---------------------------------------------------------------------------

/**
 * Injectable dependency surface for `runParallelWorkChecks`. The default
 * impls call live `gh` and `git` subprocesses; tests pass mocks to exercise
 * the collision/no-collision paths hermetically.
 *
 * fetchPrFiles accepts a warnings array so per-PR lookup failures are
 * surfaced without aborting the sweep.
 */
export interface ParallelWorkCheckDeps {
  fetchOpenPrs: (repo: string) => PrInfo[];
  fetchPrFiles: (repo: string, prNumber: number, warnings: string[]) => string[];
  fetchRecentMerges: (
    repoDir: string,
    inScopeFiles: string[],
    hours: number,
    defaultBranchRef?: string,
    repo?: string,
    warnings?: string[],
    isAppendOnly?: (
      repo: string,
      fromRef: string,
      toRef: string,
      filePath: string,
      warnings: string[]
    ) => boolean
  ) => ParallelWorkCollision[];
  detectDefaultBranch: (repoDir: string) => { ref: string | null; warning?: string };
  isFileChangeAppendOnly: (
    repo: string,
    fromRef: string,
    toRef: string,
    filePath: string,
    warnings: string[]
  ) => boolean;
}

const DEFAULT_DEPS: ParallelWorkCheckDeps = {
  fetchOpenPrs,
  fetchPrFiles,
  fetchRecentMerges,
  detectDefaultBranch,
  isFileChangeAppendOnly,
};

/**
 * Run both parallel-work checks (open-PR + recently-merged).
 * Returns a structured result with all collisions found.
 *
 * The `repoDir` param is used for the git log check and default-branch
 * detection. `deps` is injectable so tests can mock the `gh` / `git`
 * subprocesses and exercise the green and colliding paths end-to-end.
 */
export function runParallelWorkChecks(
  input: ParallelWorkCheckInput,
  repoDir: string,
  currentBranch?: string | null,
  deps: ParallelWorkCheckDeps = DEFAULT_DEPS
): ParallelWorkCheckResult {
  const collisions: ParallelWorkCollision[] = [];
  const warnings: string[] = [];

  // Short-circuit: nothing to check if there are no in-scope files
  if (input.inScopeFiles.length === 0) {
    warnings.push("No in-scope files to check — parallel-work check skipped");
    return { blocked: false, collisions, warnings };
  }

  // Detect default branch up-front so both sweeps can use the bare branch
  // name (e.g., "main") for `gh api` content lookups in the structural
  // append-only check (mt#1587).
  let defaultBranchRef: string | null = null;
  try {
    const detected = deps.detectDefaultBranch(repoDir);
    if (detected.warning) warnings.push(detected.warning);
    defaultBranchRef = detected.ref;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    warnings.push(`Default-branch detection failed (non-blocking): ${msg}`);
  }
  const baseBranch = defaultBranchRef ? defaultBranchRef.replace(/^origin\//, "") : "main";
  if (defaultBranchRef === null) {
    // Mirror the recently-merged sweep's explicit signaling: when default
    // detection fails, the open-PR sweep still runs but uses 'main' as its
    // structural-check base. Surface the assumption so operators know why
    // an exemption may have fired against a non-canonical base
    // (PR #952 R1 NON-BLOCKING #3).
    warnings.push(
      "Open-PR structural-check baseBranch defaulted to 'main' (default-branch detection failed)"
    );
  }

  // Check A: open PRs
  try {
    const prCollisions = checkOpenPrs(
      input,
      currentBranch,
      deps.fetchOpenPrs,
      deps.fetchPrFiles,
      warnings,
      baseBranch,
      deps.isFileChangeAppendOnly
    );
    collisions.push(...prCollisions);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    warnings.push(`Open-PR sweep failed (non-blocking): ${msg}`);
  }

  // Check B: recently merged — uses the default branch detected above.
  try {
    if (defaultBranchRef === null) {
      // All probes failed; skip the sweep rather than running against a wrong ref
    } else {
      const mergeCollisions = deps.fetchRecentMerges(
        repoDir,
        input.inScopeFiles,
        input.lookbackHours,
        defaultBranchRef,
        input.repo,
        warnings,
        deps.isFileChangeAppendOnly
      );
      collisions.push(...mergeCollisions);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    warnings.push(`Recently-merged sweep failed (non-blocking): ${msg}`);
  }

  return {
    blocked: collisions.length > 0,
    collisions,
    warnings,
  };
}

// ---------------------------------------------------------------------------
// Denial message formatting
// ---------------------------------------------------------------------------

export function formatBlockMessage(taskId: string, collisions: ParallelWorkCollision[]): string {
  const lines: string[] = [
    `Parallel-work guard: session_start for ${taskId} blocked — in-scope files overlap with active work.`,
    "",
  ];

  for (const col of collisions) {
    if (col.type === "open-pr") {
      lines.push(
        `  OPEN PR #${col.prNumber}: "${col.prTitle}"`,
        `    Overlapping files: ${col.overlappingFiles.join(", ")}`
      );
    } else {
      lines.push(
        `  RECENTLY MERGED (${col.commitSha}): "${col.commitMessage}"`,
        `    Overlapping files: ${col.overlappingFiles.join(", ")}`
      );
    }
    lines.push("");
  }

  lines.push("Recommended actions:");
  lines.push("  1. WAIT — let the parallel PR merge first, then start your session.");
  lines.push("  2. COORDINATE — rebase on that PR's branch and open a single combined PR.");
  lines.push("  3. REFRAME — adjust the task scope to avoid the conflicting files.");
  lines.push("  4. OVERRIDE — if parallel work is intentional and acknowledged:");
  lines.push("       Set MINSKY_FORCE_PARALLEL=1 in your environment and retry.");
  lines.push("       The override is audit-logged.");

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Spec fetching (uses minsky CLI)
// ---------------------------------------------------------------------------

/**
 * Fetch task spec content via the minsky CLI. Returns null on failure.
 *
 * Routed through execWithPath with the same per-call timeout as gh/git
 * subprocesses so a slow minsky CLI can't consume the 30s PreToolUse
 * budget. Per round-9 reviewer feedback.
 */
export function fetchTaskSpec(taskId: string): string | null {
  const result = execWithPath(["minsky", "tasks", "spec", "get", taskId], {
    timeout: GH_GIT_TIMEOUT_MS,
  });

  if (result.exitCode !== 0) {
    return null;
  }

  return result.stdout;
}

// ---------------------------------------------------------------------------
// Repo derivation
// ---------------------------------------------------------------------------

/**
 * Parse an `owner/repo` slug out of a GitHub remote URL. Returns null if the
 * URL doesn't look like a GitHub remote.
 *
 * Supports these forms:
 *   - SCP-style SSH:         `git@github.com:owner/repo[.git]`
 *   - URL-style SSH:         `ssh://[git@]github.com/owner/repo[.git]`
 *   - SSH with port:         `ssh://git@github.com:22/owner/repo[.git]`
 *   - git+ssh prefix:        `git+ssh://git@github.com/owner/repo.git`
 *   - HTTPS plain:           `https://github.com/owner/repo[.git][/]`
 *   - HTTPS with creds:      `https://token@github.com/owner/repo[.git]`
 *
 * Pure function — no I/O.
 */
export function parseGitHubRemoteUrl(url: string): string | null {
  const trimmed = url.trim();

  // SCP-style SSH: git@github.com:owner/repo[.git]
  const sshMatch = trimmed.match(/^git@github\.com:([^/]+\/[^/]+?)(?:\.git)?$/);
  if (sshMatch) {
    return sshMatch[1];
  }

  // URL-style SSH (with optional port): ssh://[git@]github.com[:port]/owner/repo[.git][/]
  // Also handles git+ssh:// prefix
  const sshUrlMatch = trimmed.match(
    /^(?:git\+)?ssh:\/\/(?:[^@]+@)?github\.com(?::\d+)?\/([^/]+\/[^/]+?)(?:\.git)?\/?$/
  );
  if (sshUrlMatch) {
    return sshUrlMatch[1];
  }

  // HTTPS form (with optional embedded credentials): https://[token@]github.com/owner/repo[.git][/]
  const httpsMatch = trimmed.match(
    /^https:\/\/(?:[^@]+@)?github\.com\/([^/]+\/[^/]+?)(?:\.git)?\/?$/
  );
  if (httpsMatch) {
    return httpsMatch[1];
  }

  return null;
}

/**
 * Derive the GitHub `owner/repo` slug from the `origin` remote of the given
 * git working directory. Returns null if the remote can't be read or doesn't
 * look like a GitHub URL.
 */
export function deriveRepoFromGit(repoDir: string): string | null {
  const result = execWithPath(["git", "-C", repoDir, "remote", "get-url", "origin"], {
    timeout: GH_GIT_TIMEOUT_MS,
  });
  if (result.exitCode !== 0 || !result.stdout.trim()) {
    return null;
  }
  return parseGitHubRemoteUrl(result.stdout);
}

// ---------------------------------------------------------------------------
// Hook entry point
// ---------------------------------------------------------------------------

if (import.meta.main) {
  const input = await readInput<ToolHookInput>();

  // Only act on session_start
  if (input.tool_name !== "mcp__minsky__session_start") {
    process.exit(0);
  }

  // The MCP `session_start` tool exposes its task identifier as `task`. We
  // also accept `taskId` for forward compatibility in case the surface is
  // renamed; whichever is present wins.
  const taskFromInput =
    (input.tool_input.task as string | undefined) ??
    (input.tool_input.taskId as string | undefined) ??
    "";
  const taskId = taskFromInput;
  if (!taskId) {
    // No task identifier — can't run check; warn and allow
    process.stdout.write(
      `[parallel-work-guard] No 'task' (or 'taskId') in session_start input — check skipped\n`
    );
    process.exit(0);
  }

  // Check for override env var
  const forceParallel = process.env["MINSKY_FORCE_PARALLEL"];
  if (forceParallel === "1") {
    // Audit-log the override
    const ts = new Date().toISOString();
    process.stdout.write(
      `[parallel-work-guard] OVERRIDE active (MINSKY_FORCE_PARALLEL=1) — task=${taskId} ts=${ts}\n`
    );
    process.exit(0);
  }

  // Fetch and parse spec
  const specContent = fetchTaskSpec(taskId);
  if (!specContent) {
    // Can't fetch spec — warn and allow (non-blocking failure)
    process.stdout.write(
      `[parallel-work-guard] Could not fetch spec for ${taskId} — check skipped\n`
    );
    process.exit(0);
  }

  const { files: inScopeFiles, warnings: parseWarnings } = extractInScopeFiles(specContent);

  for (const w of parseWarnings) {
    process.stdout.write(`[parallel-work-guard] ${w}\n`);
  }

  if (inScopeFiles.length === 0) {
    // No in-scope files parseable — warn and allow
    process.exit(0);
  }

  const repoDir = input.cwd;

  // Derive repo slug from git remote rather than hardcoding. If derivation
  // fails (non-github remote, or no remote), warn and allow — this is the
  // same fail-open posture as the rest of the hook.
  const repo = deriveRepoFromGit(repoDir);
  if (!repo) {
    process.stdout.write(
      `[parallel-work-guard] Could not derive owner/repo from git remote — check skipped\n`
    );
    process.exit(0);
  }

  // Detect the actual current branch — the only own-branch signal used by
  // isOwnBranch (exact equality). If the probe fails, currentBranch is null
  // and all open PRs will be treated as peers (no skipping).
  const branchProbe = execWithPath(["git", "-C", repoDir, "rev-parse", "--abbrev-ref", "HEAD"], {
    timeout: GH_GIT_TIMEOUT_MS,
  });
  const currentBranch =
    branchProbe.exitCode === 0 && branchProbe.stdout.trim() ? branchProbe.stdout.trim() : null;

  const checkInput: ParallelWorkCheckInput = {
    taskId,
    inScopeFiles,
    repo,
    lookbackHours: 24,
  };

  const result = runParallelWorkChecks(checkInput, repoDir, currentBranch);

  for (const w of result.warnings) {
    process.stdout.write(`[parallel-work-guard] ${w}\n`);
  }

  if (result.blocked) {
    writeOutput({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: formatBlockMessage(taskId, result.collisions),
      },
    });
    process.exit(0);
  }

  // When permitting (not blocking), include any aggregated warnings in
  // hookSpecificOutput.additionalContext so host UIs that only surface
  // hookSpecificOutput content (not stdout) still see them. stdout is kept
  // for log-grep compatibility.
  if (result.warnings.length > 0) {
    writeOutput({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        additionalContext: result.warnings.map((w) => `[parallel-work-guard] ${w}`).join("\n"),
      },
    });
  }

  process.exit(0);
}
