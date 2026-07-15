#!/usr/bin/env bun
// Shared PR-data fetch layer for the session_pr_merge PreToolUse gate stack
// (mt#2617).
//
// ## Why
//
// `session_pr_merge` triggers four PreToolUse gates —
// require-review-before-merge.ts, require-execution-evidence-before-merge.ts,
// require-deploy-verification-before-merge.ts, block-out-of-band-merge.ts —
// each running as its OWN subprocess. Before this module, sharing was
// partial and ad hoc: deploy-verification imported helpers from
// execution-evidence, but review-gate (the largest, ~40 `gh` references) had
// zero shared-module imports and independently re-fetched PR data with
// bespoke timeout logic and (in review-gate's case) hardcoded
// `edobry/minsky` + a hardcoded `main` base branch. A single merge attempt
// plausibly issued 8+ separate `gh` subprocess round-trips.
//
// This module is the ONE place that knows how to ask `gh` for PR data. Each
// gate keeps its own pure parse/evaluate/check functions (already covered by
// that gate's own test suite) — this module owns only the "how do we fetch
// it, and how many `gh` calls does that cost" concern. Consolidation
// happens at two levels:
//
//   1. WITHIN a single gate: require-review-before-merge.ts used to issue
//      THREE separate `check-runs` queries with different query params
//      (`per_page=1` for presence, `check_name=bundle-boot-smoke` for the
//      bundle-boot gate, `per_page=100` for the required-checks gate). All
//      three of its existing parse functions operate on the SAME raw
//      `check-runs` response shape and do their own client-side
//      filtering/sorting — so ONE `per_page=100` fetch (see
//      `fetchCheckRunsRaw` below) satisfies all three without changing what
//      gets parsed.
//   2. ACROSS gates that resolve PR metadata by task: execution-evidence and
//      deploy-verification each used to do `resolvePrNumber` (1-2 calls) +
//      a SEPARATE `fetchPrMeta` (1 call) = up to 3 calls. `fetchPrContext`
//      collapses PR-number resolution and metadata fetch into ONE `gh`
//      call per attempt (see `resolvePrMetaForTask`).
//
// ## Design notes
//
// - Dependency-free (only imports `execWithPath` from `./types`, matching
//   the `transcript.ts` / `types.ts` sibling shape — no cross-imports from
//   `src/`).
// - Every fetch function accepts an injectable `exec` (default:
//   `execWithPath`, PATH-augmented) so gate test suites can supply a fake
//   without spawning a real `gh` subprocess.
// - ONE timeout policy: `DEFAULT_GH_TIMEOUT_MS` (10s) is the default for
//   every call in this module, matching the majority of the pre-existing
//   per-call timeouts across the four gates (which ranged 10-15s
//   inconsistently). No retries — none of the four gates retried before
//   this module either; adding retries now would change gate DECISIONS
//   under flaky-network conditions, which the "zero behavior change"
//   requirement forbids.
// - `withCallCounter` wraps any `ExecFn` so callers (and tests) can count
//   how many `gh` subprocesses a code path spawns — the round-trip
//   instrumentation used for the mt#2617 before/after evidence.
// - `fetchCheckRunsRaw` does NOT paginate beyond `per_page=100` (matches
//   every caller it replaces — none paginated either); a consumer that
//   enumerates the full run list, not just presence via `total_count`,
//   must check `total_count` against the returned `check_runs.length` and
//   fail closed on a mismatch — see that function's doc comment for the
//   concrete guardrail (`evaluateRequiredChecksStatus`) that already does
//   this.
//
// ## Back-compat
//
// `parseGitHubRemoteUrl`, `deriveRepoFromGit`, `resolvePrNumber`,
// `makeProdPrDeps`, `PrFile`, `ExecFn`, `PrDeps`, `FetchPrFilesResult` are
// moved here VERBATIM from require-execution-evidence-before-merge.ts (same
// logic, same call shapes, same parsing) and re-exported from that file so
// every existing consumer (deploy-surface-detector.ts,
// deploy-verification-after-merge.ts, require-deploy-verification-before-merge.ts,
// and each gate's own test suite) keeps working unchanged. `resolvePrNumber`
// in particular is directly unit-tested against a specific raw-stdout
// parsing contract (`gh pr view --json number --jq .number` returning a bare
// numeric string) — it is kept byte-identical rather than rewritten in terms
// of the new JSON-object-returning meta functions below.
//
// @see mt#2617 — this module's tracking task
// @see mt#2607 finding F3 — originating audit finding (duplicated PR-data fetch)

import { execWithPath } from "./types";

// ---------------------------------------------------------------------------
// Shared types
// ---------------------------------------------------------------------------

/** File entry from GitHub's PR-files REST endpoint. */
export interface PrFile {
  filename: string;
  status: "added" | "removed" | "modified" | "renamed" | "copied" | "changed" | "unchanged";
  /**
   * Present (as a real string) for renamed/copied files — the filename
   * before the rename/copy.
   *
   * mt#2809: typed to include `null`, not just `undefined`, because that is
   * what this field ACTUALLY is at runtime for every non-renamed entry.
   * `fetchPrFiles` below builds this via a `gh api ... --jq` projection
   * (`previous_filename: .previous_filename`) that evaluates the field on
   * every file regardless of status; jq's `.foo` access on a missing key
   * returns `null` rather than omitting the key, so the JSON that
   * `JSON.parse` sees carries a literal `null` — not an absent key — for
   * every non-renamed file. Consumers MUST check `!= null` (or
   * `typeof x === "string"`), never `!== undefined` alone — the latter
   * treats `null` as "present" and was the mt#2809 crash's root cause
   * (`isDeploySurfaceFile(f.previous_filename)` called with `null`).
   */
  previous_filename?: string | null;
}

/** A single PR review (subset of GitHub's review shape). */
export interface PrReview {
  body: string;
  commit_id: string;
  submitted_at: string;
  user_login?: string;
}

/** Resolved PR identity + metadata — what every gate needs first. */
export interface PrMeta {
  number: number;
  title: string;
  body: string;
  headSha: string;
  baseBranch: string;
}

export type ExecResult = { exitCode: number; stdout: string; stderr: string; timedOut?: boolean };
export type ExecFn = (cmd: string[], opts?: { cwd?: string; timeout?: number }) => ExecResult;

export interface FetchOpts {
  cwd?: string;
  exec?: ExecFn;
  timeout?: number;
}

/** Unified default timeout for every `gh` call issued through this module. */
export const DEFAULT_GH_TIMEOUT_MS = 10000;

// ---------------------------------------------------------------------------
// Call-counting exec wrapper (round-trip instrumentation — mt#2617)
// ---------------------------------------------------------------------------

export interface CountingExec {
  exec: ExecFn;
  count: () => number;
}

/**
 * Wrap an exec function so every invocation increments a counter. Used to
 * measure `gh` round-trips per merge attempt — the before/after evidence for
 * mt#2617's "gh round-trips per merge attempt measurably reduced" success
 * criterion. Production callers don't need this, but any gate entrypoint or
 * test can wrap its exec with this to get a call count for free.
 */
export function withCallCounter(exec: ExecFn = execWithPath): CountingExec {
  let calls = 0;
  return {
    exec: (cmd, opts) => {
      calls++;
      return exec(cmd, opts);
    },
    count: () => calls,
  };
}

// ---------------------------------------------------------------------------
// Repo derivation (moved verbatim from require-execution-evidence-before-merge.ts)
// ---------------------------------------------------------------------------

/**
 * Parse an `owner/repo` slug out of a GitHub remote URL. Returns null if the
 * URL doesn't look like a GitHub remote.
 *
 * Supports SCP-style SSH, URL-style SSH, HTTPS with or without credentials.
 * Pure function — no I/O.
 */
export function parseGitHubRemoteUrl(url: string): string | null {
  const trimmed = url.trim();
  // SCP-style SSH: git@github.com:owner/repo[.git]
  const sshMatch = trimmed.match(/^git@github\.com:([^/]+\/[^/]+?)(?:\.git)?$/);
  if (sshMatch) return sshMatch[1] ?? null;
  // URL-style SSH (with optional port or git+ssh prefix)
  const sshUrlMatch = trimmed.match(
    /^(?:git\+)?ssh:\/\/(?:[^@]+@)?github\.com(?::\d+)?\/([^/]+\/[^/]+?)(?:\.git)?\/?$/
  );
  if (sshUrlMatch) return sshUrlMatch[1] ?? null;
  // HTTPS form (with optional embedded credentials)
  const httpsMatch = trimmed.match(
    /^https:\/\/(?:[^@]+@)?github\.com\/([^/]+\/[^/]+?)(?:\.git)?\/?$/
  );
  if (httpsMatch) return httpsMatch[1] ?? null;
  return null;
}

/**
 * Derive the GitHub `owner/repo` slug from the `origin` remote of the given
 * git working directory. Returns null if the remote can't be read or doesn't
 * look like a GitHub URL — callers should fail-open with a warning.
 */
export function deriveRepoFromGit(repoDir: string, exec: ExecFn = execWithPath): string | null {
  const result = exec(["git", "remote", "get-url", "origin"], {
    cwd: repoDir,
    timeout: 5000,
  });
  if (result.exitCode !== 0 || !result.stdout.trim()) return null;
  return parseGitHubRemoteUrl(result.stdout);
}

// ---------------------------------------------------------------------------
// Legacy PR-number resolution (moved verbatim — resolvePrNumber's stdout
// parsing contract, bare numeric string, is directly unit-tested and MUST
// NOT change).
// ---------------------------------------------------------------------------

/**
 * Resolve the PR number for the current context.
 *
 * Primary path: `gh pr view --json number --jq .number` (no args = current
 * branch). Handles fork PRs and non-standard branch names naturally.
 *
 * Fallback: `gh pr list --repo <repo> --head task/<id>`.
 *
 * Returns null if neither path resolves, in which case the caller should
 * emit a warning and fail-open rather than silently exit(0).
 *
 * Kept byte-identical to the pre-mt#2617 implementation (moved from
 * require-execution-evidence-before-merge.ts) — its raw-stdout parsing
 * contract is unit-tested directly. New callers that need full PR metadata
 * (not just the number) should prefer `resolvePrMetaForTask`, which
 * collapses this + a metadata fetch into the SAME one or two calls instead
 * of adding a third.
 */
export function resolvePrNumber(
  repo: string,
  task: string,
  cwd: string,
  exec: ExecFn = execWithPath
): { prNumber: number | null; warning?: string } {
  const viewResult = exec(
    ["gh", "pr", "view", "--repo", repo, "--json", "number", "--jq", ".number"],
    { cwd, timeout: 10000 }
  );
  if (viewResult.exitCode === 0) {
    const parsed = parseInt(viewResult.stdout.trim(), 10);
    if (!isNaN(parsed) && parsed > 0) {
      return { prNumber: parsed };
    }
  }

  const branch = `task/${task.replace("#", "-")}`;
  const listResult = exec(
    [
      "gh",
      "pr",
      "list",
      "--repo",
      repo,
      "--head",
      branch,
      "--json",
      "number",
      "--jq",
      ".[0].number",
    ],
    { cwd, timeout: 10000 }
  );
  if (listResult.exitCode === 0) {
    const parsed = parseInt(listResult.stdout.trim(), 10);
    if (!isNaN(parsed) && parsed > 0) {
      return { prNumber: parsed };
    }
  }

  return {
    prNumber: null,
    warning:
      `[execution-evidence] Could not resolve PR number via \`gh pr view\` or ` +
      `\`gh pr list --head ${branch}\` — test-file check skipped. ` +
      `Ensure the branch has an open PR and gh is authenticated.`,
  };
}

// ---------------------------------------------------------------------------
// PR files fetch (moved verbatim from makeProdPrDeps.fetchPrFiles)
// ---------------------------------------------------------------------------

/** Result of fetchPrFiles — files plus an optional warning if the API call failed */
export interface FetchPrFilesResult {
  files: PrFile[];
  warning?: string;
}

/**
 * Fetch PR files from GitHub's paginated files REST endpoint.
 * Returns `{ files: [], warning }` on error (fail-open: if we can't check,
 * allow merge) so that callers can surface the warning in the audit trail.
 */
export function fetchPrFiles(
  repo: string,
  prNumber: number,
  opts: FetchOpts = {}
): FetchPrFilesResult {
  const { cwd, exec = execWithPath, timeout = 15000 } = opts;
  const result = exec(
    [
      "gh",
      "api",
      `repos/${repo}/pulls/${prNumber}/files`,
      "--paginate",
      "--jq",
      "[.[] | {filename: .filename, status: .status, previous_filename: .previous_filename}]",
    ],
    { cwd, timeout }
  );
  if (result.exitCode !== 0) {
    return {
      files: [],
      warning: `fetchPrFiles: gh api failed (exit ${result.exitCode}) for PR #${prNumber} — test-file detection skipped.`,
    };
  }
  try {
    const raw = result.stdout.trim();
    if (raw.startsWith("[")) {
      try {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed) && parsed.length > 0 && Array.isArray(parsed[0])) {
          return { files: (parsed as PrFile[][]).flat() };
        }
        return { files: parsed as PrFile[] };
      } catch {
        // Fall through to line-by-line parse
      }
    }
    const pages = raw
      .split("\n")
      .filter((l) => l.trim().startsWith("["))
      .map((l) => {
        try {
          return JSON.parse(l) as PrFile[];
        } catch {
          return [] as PrFile[];
        }
      });
    return { files: pages.flat() };
  } catch {
    return {
      files: [],
      warning: `fetchPrFiles: JSON parse failed for PR #${prNumber} — test-file detection skipped.`,
    };
  }
}

export interface PrDeps {
  fetchPrFiles: (repo: string, prNumber: number) => FetchPrFilesResult;
  fetchPrMeta: (repo: string, prNumber: number) => { title: string; body: string } | null;
}

/**
 * Production `PrDeps` factory — moved verbatim from
 * require-execution-evidence-before-merge.ts's `makeProdPrDeps`. Kept for
 * back-compat (its `fetchPrFiles` behavior is directly relied on by callers
 * that still want the `{fetchPrFiles, fetchPrMeta}` shape); new entrypoint
 * code should prefer `fetchPrContext`, which collapses the two calls
 * `fetchPrMeta` here still issues separately (number resolution + meta) into
 * one.
 */
export function makeProdPrDeps(cwd?: string): PrDeps {
  return {
    fetchPrFiles(repo: string, prNumber: number): FetchPrFilesResult {
      return fetchPrFiles(repo, prNumber, { cwd });
    },
    fetchPrMeta(repo: string, prNumber: number): { title: string; body: string } | null {
      const result = execWithPath(
        [
          "gh",
          "api",
          `repos/${repo}/pulls/${prNumber}`,
          "--jq",
          '{title: .title, body: (.body // "")}',
        ],
        { cwd, timeout: 15000 }
      );
      if (result.exitCode !== 0) return null;
      try {
        return JSON.parse(result.stdout) as { title: string; body: string };
      } catch {
        return null;
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Consolidated PR meta resolution (new — mt#2617)
// ---------------------------------------------------------------------------

const PR_META_JSON_FIELDS = "number,title,body,headRefOid,baseRefName";
const PR_META_JQ_OBJECT =
  '{number: .number, title: .title, body: (.body // ""), headSha: .headRefOid, baseBranch: .baseRefName}';

function parsePrMeta(raw: string): PrMeta | null {
  const trimmed = raw.trim();
  if (!trimmed || trimmed === "null") return null;
  try {
    const parsed = JSON.parse(trimmed) as Partial<PrMeta>;
    if (
      typeof parsed.number !== "number" ||
      typeof parsed.title !== "string" ||
      typeof parsed.body !== "string" ||
      typeof parsed.headSha !== "string" ||
      typeof parsed.baseBranch !== "string"
    ) {
      return null;
    }
    return parsed as PrMeta;
  } catch {
    return null;
  }
}

/**
 * Resolve PR metadata for the CURRENT checked-out branch — ONE `gh` call
 * (`gh pr view`) returning number/title/body/headSha/baseBranch together.
 * Returns null on any failure (no PR for this branch, transport error,
 * parse error) — callers that need a fallback should try
 * `fetchPrMetaByBranch` next (mirrors the pre-mt#2617 `resolvePrNumber`
 * primary/fallback strategy).
 */
export function fetchPrMetaByCurrentBranch(repo: string, opts: FetchOpts = {}): PrMeta | null {
  const { cwd, exec = execWithPath, timeout = DEFAULT_GH_TIMEOUT_MS } = opts;
  const result = exec(
    ["gh", "pr", "view", "--repo", repo, "--json", PR_META_JSON_FIELDS, "--jq", PR_META_JQ_OBJECT],
    { cwd, timeout }
  );
  if (result.exitCode !== 0) return null;
  return parsePrMeta(result.stdout);
}

/**
 * Resolve PR metadata by head branch name — ONE `gh` call
 * (`gh pr list --head`) returning number/title/body/headSha/baseBranch
 * together. Returns null when no PR matches the branch (legitimate) OR the
 * call/parse fails (transport error) — matches the pre-mt#2617 behavior of
 * both execution-evidence's fallback (which never distinguished the two) and
 * review-gate's single lookup (which silently exits either way).
 */
export function fetchPrMetaByBranch(
  repo: string,
  branch: string,
  opts: FetchOpts = {}
): PrMeta | null {
  const { cwd, exec = execWithPath, timeout = DEFAULT_GH_TIMEOUT_MS } = opts;
  const result = exec(
    [
      "gh",
      "pr",
      "list",
      "--repo",
      repo,
      "--head",
      branch,
      "--json",
      PR_META_JSON_FIELDS,
      "--jq",
      `.[0] | ${PR_META_JQ_OBJECT}`,
    ],
    { cwd, timeout }
  );
  if (result.exitCode !== 0) return null;
  return parsePrMeta(result.stdout);
}

/**
 * Resolve PR metadata by PR number — ONE `gh` call (`gh pr view <n>`).
 */
export function fetchPrMetaByNumber(
  repo: string,
  prNumber: number,
  opts: FetchOpts = {}
): PrMeta | null {
  const { cwd, exec = execWithPath, timeout = DEFAULT_GH_TIMEOUT_MS } = opts;
  const result = exec(
    [
      "gh",
      "pr",
      "view",
      String(prNumber),
      "--repo",
      repo,
      "--json",
      PR_META_JSON_FIELDS,
      "--jq",
      PR_META_JQ_OBJECT,
    ],
    { cwd, timeout }
  );
  if (result.exitCode !== 0) return null;
  return parsePrMeta(result.stdout);
}

/**
 * Resolve PR number + full metadata for a task, trying the current
 * checked-out branch first (works for forks / non-standard branch names)
 * and falling back to `task/<id>` head-branch lookup. Mirrors the
 * pre-mt#2617 `resolvePrNumber` primary/fallback STRATEGY exactly, but
 * returns full metadata from the SAME calls instead of requiring a second,
 * separate `fetchPrMeta` round-trip — collapses `resolvePrNumber` (1-2
 * calls) + `fetchPrMeta` (1 call) into 1-2 calls total.
 */
export function resolvePrMetaForTask(
  repo: string,
  task: string,
  opts: FetchOpts = {}
): { meta: PrMeta | null; warning?: string } {
  const viaCurrent = fetchPrMetaByCurrentBranch(repo, opts);
  if (viaCurrent) return { meta: viaCurrent };

  const branch = `task/${task.replace("#", "-")}`;
  const viaBranch = fetchPrMetaByBranch(repo, branch, opts);
  if (viaBranch) return { meta: viaBranch };

  return {
    meta: null,
    warning:
      `Could not resolve PR via \`gh pr view\` or \`gh pr list --head ${branch}\` — ` +
      `check skipped. Ensure the branch has an open PR and gh is authenticated.`,
  };
}

/**
 * Resolve `{pr, headSha, baseBranch}` (as STRINGS — matching the
 * pre-mt#2617 `require-review-before-merge.ts` contract, whose
 * parse/evaluate functions take `prNumber: string`) by head branch name.
 * ONE `gh` call. Returns null on ANY failure (no PR for branch, transport
 * error) without distinguishing the two — matches review-gate's pre-mt#2617
 * behavior of silently exiting either way (`if (!pr) process.exit(0)`).
 */
export function resolvePrRefByBranch(
  repo: string,
  branch: string,
  opts: FetchOpts = {}
): { pr: string; headSha: string; baseBranch: string } | null {
  const meta = fetchPrMetaByBranch(repo, branch, opts);
  if (!meta) return null;
  return { pr: String(meta.number), headSha: meta.headSha, baseBranch: meta.baseBranch };
}

// ---------------------------------------------------------------------------
// Raw check-runs / branch-protection / reviews fetch — single-call,
// caller-parses (each gate keeps its own already-tested parse functions;
// this module only reduces HOW MANY calls are made).
// ---------------------------------------------------------------------------

/**
 * Fetch ALL check_runs for a commit in ONE call (`per_page=100`). Returns
 * the RAW exec result — callers parse it with their own (already-tested)
 * parser. Because GitHub's Checks API always returns `total_count` (the true
 * total, independent of page size) and this module's callers all filter the
 * `check_runs[]` array client-side by name, a single `per_page=100` fetch
 * satisfies presence checks, name-filtered checks (e.g. bundle-boot-smoke),
 * AND full-enumeration checks (e.g. required-checks-status) without any
 * change to what gets parsed — replacing what was previously THREE separate
 * `gh api .../check-runs` calls with different query params in
 * require-review-before-merge.ts.
 *
 * **Does not paginate** (matches the pre-mt#2617 behavior of every caller
 * this replaces — none of them paginated either). A commit with more than
 * 100 check_runs will have its `check_runs[]` array truncated to the first
 * page even though `total_count` still reports the true total. Consumers
 * that enumerate the FULL run list (not just presence-via-`total_count`) —
 * currently `evaluateRequiredChecksStatus` in require-review-before-merge.ts
 * — MUST compare `total_count` against `check_runs.length` and fail closed
 * on a mismatch rather than silently evaluating a truncated set; that gate
 * already does this (its `allRuns.totalCount > allRuns.runs.length`
 * pagination guardrail, mt#1938/PR #1167 R1).
 */
export function fetchCheckRunsRaw(repo: string, headSha: string, opts: FetchOpts = {}): ExecResult {
  const { cwd, exec = execWithPath, timeout = DEFAULT_GH_TIMEOUT_MS } = opts;
  return exec(["gh", "api", `repos/${repo}/commits/${headSha}/check-runs?per_page=100`], {
    cwd,
    timeout,
  });
}

/**
 * Fetch branch-protection settings for a branch in ONE call. Returns the RAW
 * exec result — callers parse it with their own parser
 * (`parseBranchProtectionResponse`). `branch` is caller-supplied so the
 * gate can resolve the PR's actual base branch dynamically instead of
 * hardcoding `main` (mt#2617 absorbed scope, mt#2653 item 5).
 */
export function fetchBranchProtectionRaw(
  repo: string,
  branch: string,
  opts: FetchOpts = {}
): ExecResult {
  const { cwd, exec = execWithPath, timeout = DEFAULT_GH_TIMEOUT_MS } = opts;
  return exec(["gh", "api", `repos/${repo}/branches/${branch}/protection`], { cwd, timeout });
}

/**
 * Fetch all reviews for a PR in ONE call. Returns the RAW exec result —
 * callers parse it with their own inline logic (review-gate maps
 * `user.login` -> `user_login` before use).
 */
export function fetchReviewsRaw(
  repo: string,
  prNumber: string | number,
  opts: FetchOpts = {}
): ExecResult {
  const { cwd, exec = execWithPath, timeout = DEFAULT_GH_TIMEOUT_MS } = opts;
  return exec(["gh", "api", `repos/${repo}/pulls/${prNumber}/reviews`], { cwd, timeout });
}

/** Fetch a PR's body only, by number. ONE call. */
export function fetchPrBody(
  repo: string,
  prNumber: number,
  opts: FetchOpts = {}
): { ok: true; body: string } | { ok: false; error: string } {
  const { cwd, exec = execWithPath, timeout = DEFAULT_GH_TIMEOUT_MS } = opts;
  const result = exec(
    ["gh", "pr", "view", String(prNumber), "--repo", repo, "--json", "body", "--jq", ".body"],
    { cwd, timeout }
  );
  if (result.timedOut) {
    return { ok: false, error: `gh pr view timed out: ${result.stderr || "(no stderr)"}` };
  }
  if (result.exitCode !== 0) {
    return {
      ok: false,
      error: `gh pr view exited ${result.exitCode}: ${result.stderr || "(no stderr)"}`,
    };
  }
  return { ok: true, body: result.stdout };
}

/**
 * Resolve `{prNumber, body}` for a task's branch in ONE call. Returns `null`
 * when no PR exists for the branch (legitimate — branch hasn't pushed yet,
 * PR already merged, etc.), distinct from a structured failure for
 * transport errors — matches block-out-of-band-merge.ts's pre-mt#2617
 * `resolvePrFromTask` contract exactly (silent-allow on notFound, fail-open
 * WITH a warning on transport error).
 */
export function resolvePrBodyFromTask(
  repo: string,
  task: string,
  opts: FetchOpts = {}
): { ok: true; prNumber: number; body: string } | { ok: false; error: string } | null {
  const { cwd, exec = execWithPath, timeout = DEFAULT_GH_TIMEOUT_MS } = opts;
  if (!task) return null;
  const branch = `task/${task.replace("#", "-")}`;
  const result = exec(
    ["gh", "pr", "list", "--repo", repo, "--head", branch, "--json", "number,body", "--jq", ".[0]"],
    { cwd, timeout }
  );
  if (result.timedOut) {
    return { ok: false, error: `gh pr list timed out: ${result.stderr || "(no stderr)"}` };
  }
  if (result.exitCode !== 0) {
    return {
      ok: false,
      error: `gh pr list exited ${result.exitCode}: ${result.stderr || "(no stderr)"}`,
    };
  }
  const trimmed = result.stdout.trim();
  if (!trimmed || trimmed === "null") return null;
  let parsed: { number?: unknown; body?: unknown };
  try {
    parsed = JSON.parse(trimmed);
  } catch (e) {
    return {
      ok: false,
      error: `failed to parse gh pr list response: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
  if (typeof parsed.number !== "number" || typeof parsed.body !== "string") {
    return { ok: false, error: "gh pr list response missing number or body field" };
  }
  return { ok: true, prNumber: parsed.number, body: parsed.body };
}

// ---------------------------------------------------------------------------
// fetchPrContext — the consolidated top-level entry point (mt#2617)
// ---------------------------------------------------------------------------

export interface FetchPrContextOptions extends FetchOpts {
  /** Resolve by task ID (tries current branch, falls back to task/<id>). */
  task?: string;
  /** Resolve by known PR number (e.g. extracted from a merge URL). */
  prNumber?: number;
  /** Which optional pieces to also fetch, beyond the always-fetched meta. */
  include?: {
    files?: boolean;
  };
}

export interface PrContextSuccess {
  ok: true;
  prNumber: number;
  headSha: string;
  baseBranch: string;
  title: string;
  body: string;
  files: PrFile[];
  warnings: string[];
  /** Number of `gh` subprocess invocations made to build this result. */
  ghCallCount: number;
}
export interface PrContextFailure {
  ok: false;
  warning: string;
  /**
   * Any non-fatal warnings accumulated BEFORE resolution failed (mt#2617 R1
   * BLOCKING #2). Pre-mt#2617, execution-evidence and deploy-verification
   * fetched files and meta as two INDEPENDENT calls, so a files-fetch
   * warning could exist even when meta resolution ultimately failed — and
   * the pre-refactor fail-open path surfaced both. `fetchPrContext` resolves
   * meta FIRST and returns immediately on failure (files are never
   * attempted), so this is currently always `[]` — kept as a field (rather
   * than omitted) so callers always merge `warning` + `warnings` the same
   * way regardless of `ok`, and so a future change to the resolution order
   * can populate it without an API change.
   */
  warnings: string[];
  ghCallCount: number;
}
export type PrContextResult = PrContextSuccess | PrContextFailure;

/**
 * Fetch everything a merge gate typically needs about a PR — title, body,
 * files, head SHA, and base branch — in as few `gh` calls as possible.
 *
 * Resolution: pass `prNumber` when already known (one call); otherwise pass
 * `task` (tries current branch first, falls back to `task/<id>` — one or two
 * calls, mirroring the pre-mt#2617 `resolvePrNumber` strategy).
 *
 * `include.files` additionally fetches the PR's changed-file list (one more
 * call — the file-status data isn't available from `gh pr view`, only from
 * the paginated files REST endpoint).
 */
export function fetchPrContext(repo: string, options: FetchPrContextOptions = {}): PrContextResult {
  const { cwd, timeout, task, prNumber, include = {} } = options;
  const counting = withCallCounter(options.exec ?? execWithPath);
  const fetchOpts: FetchOpts = { cwd, exec: counting.exec, timeout };

  let meta: PrMeta | null;
  let resolutionWarning: string | undefined;
  if (typeof prNumber === "number") {
    meta = fetchPrMetaByNumber(repo, prNumber, fetchOpts);
    resolutionWarning = meta
      ? undefined
      : `Could not fetch PR #${prNumber} metadata via \`gh pr view\`.`;
  } else if (task) {
    const resolved = resolvePrMetaForTask(repo, task, fetchOpts);
    meta = resolved.meta;
    resolutionWarning = resolved.warning;
  } else {
    meta = fetchPrMetaByCurrentBranch(repo, fetchOpts);
    resolutionWarning = meta
      ? undefined
      : "Could not resolve PR via `gh pr view` (current branch).";
  }

  if (!meta) {
    return {
      ok: false,
      warning: resolutionWarning ?? "Could not resolve PR metadata.",
      warnings: [],
      ghCallCount: counting.count(),
    };
  }

  const warnings: string[] = [];
  let files: PrFile[] = [];
  if (include.files) {
    const filesResult = fetchPrFiles(repo, meta.number, fetchOpts);
    files = filesResult.files;
    if (filesResult.warning) warnings.push(filesResult.warning);
  }

  return {
    ok: true,
    prNumber: meta.number,
    headSha: meta.headSha,
    baseBranch: meta.baseBranch,
    title: meta.title,
    body: meta.body,
    files,
    warnings,
    ghCallCount: counting.count(),
  };
}

/**
 * Build the ordered list of warning strings a gate should surface when
 * `fetchPrContext` fails (mt#2617 R1 BLOCKING #2). Accumulated per-call
 * warnings (`failure.warnings` — currently always `[]`, see the field's doc
 * comment) come first, matching the pre-mt#2617 ordering where
 * `topLevelWarnings` (e.g. a `fetchPrFiles` warning) preceded the terminal
 * "could not fetch PR metadata" message. The single resolution `warning`
 * comes last. Shared here so every gate's fail-open path surfaces the same
 * information the same way, instead of each gate re-deriving its own
 * (potentially lossy) join.
 */
export function formatContextFailureWarnings(failure: PrContextFailure): string[] {
  return [...failure.warnings, failure.warning];
}
