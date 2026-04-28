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

import { readInput, writeOutput } from "./types";
import type { ToolHookInput } from "./types";

// ---------------------------------------------------------------------------
// PATH-augmented subprocess helper
// ---------------------------------------------------------------------------

/**
 * Wrapper around Bun.spawnSync that prepends common homebrew/system binary
 * directories to PATH so that `gh` and `git` resolve correctly regardless of
 * the shell PATH that launched Claude Code. Used for all gh/git calls in this
 * hook (fetchOpenPrs, fetchRecentMerges, detectDefaultBranch, deriveRepoFromGit).
 */
function execWithPath(
  cmd: string[],
  options?: { cwd?: string; timeout?: number }
): { exitCode: number; stdout: string; stderr: string; timedOut?: boolean } {
  const pathPrefix = `/opt/homebrew/bin:/usr/local/bin:${process.env.PATH ?? ""}`;
  const result = Bun.spawnSync(cmd, {
    cwd: options?.cwd,
    stdout: "pipe",
    stderr: "pipe",
    timeout: options?.timeout,
    env: { ...process.env, PATH: pathPrefix },
  });
  const timedOut = result.exitCode === null && result.signalCode === "SIGTERM";
  return {
    exitCode: result.exitCode ?? 1,
    stdout: result.stdout.toString().trim(),
    stderr: result.stderr.toString().trim(),
    timedOut,
  };
}

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
    // Fallback: bare path token (must contain /)
    const bareMatch = trimmed.match(/^[-*]\s+([\w.][^\s(,]+\/[^\s(,]*)/);
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
// Check A: Open-PR sweep
// ---------------------------------------------------------------------------

interface PrInfo {
  number: number;
  title: string;
  headRefName: string;
}

/**
 * Fetch open PRs from the repository using paginated gh api calls.
 * The --paginate flag fetches all pages; jq decomposes the array into one
 * JSON object per line so we can parse them individually.
 *
 * Throws on non-zero exit so the caller (runParallelWorkChecks) can surface
 * the failure as a warning rather than silently returning [].
 */
export function fetchOpenPrs(repo: string): PrInfo[] {
  const result = execWithPath([
    "gh",
    "api",
    `/repos/${repo}/pulls?state=open&per_page=100`,
    "--paginate",
    "--jq",
    ".[] | {number, title, headRefName: .head.ref}",
  ]);

  if (result.exitCode !== 0) {
    throw new Error(`gh api /pulls exited ${result.exitCode}: ${result.stderr || result.stdout}`);
  }

  if (!result.stdout.trim()) {
    return [];
  }

  const prs: PrInfo[] = [];
  for (const line of result.stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      prs.push(JSON.parse(trimmed) as PrInfo);
    } catch {
      // Skip malformed lines
    }
  }
  return prs;
}

/**
 * Fetch the list of changed files for a PR number.
 *
 * Unlike fetchOpenPrs, this function does NOT throw on non-zero exit — a
 * single PR lookup failure should not abort the whole sweep. Instead it
 * pushes to the provided warnings array and returns [].
 */
export function fetchPrFiles(repo: string, prNumber: number, warnings: string[] = []): string[] {
  const result = execWithPath([
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
  ]);

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
 * Both are treated as path prefixes / path suffixes for fuzzy matching.
 */
export function findOverlappingFiles(inScopeFiles: string[], prFiles: string[]): string[] {
  const overlapping: string[] = [];
  for (const scopeFile of inScopeFiles) {
    // Normalize: remove leading ./
    const normalizedScope = scopeFile.replace(/^\.\//, "");
    for (const prFile of prFiles) {
      if (
        prFile === normalizedScope ||
        prFile.startsWith(normalizedScope) ||
        prFile.startsWith(`${normalizedScope}/`) ||
        normalizedScope.startsWith(prFile) ||
        normalizedScope.startsWith(`${prFile}/`)
      ) {
        if (!overlapping.includes(prFile)) {
          overlapping.push(prFile);
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
 * Three modes, in order of preference:
 *   1. If `currentBranch` is provided (the actual `HEAD` of the session repo),
 *      exact match wins — the most reliable signal.
 *   2. Token-based match: the normalized task token (`mt-1362` for `mt#1362`)
 *      appears as a delimited segment in the branch name. Case-insensitive.
 *      Matches `task/mt-1362`, `feature/mt-1362`, `bugfix/MT-1362`, etc.
 *   3. Otherwise, no match — branch is treated as a peer.
 *
 * This addresses the round-5 BLOCKING finding that the prior exact `task/<id>`
 * convention false-blocked authors using non-standard branch naming.
 */
export function isOwnBranch(
  branchName: string,
  taskId: string,
  currentBranch?: string | null
): boolean {
  if (currentBranch && branchName === currentBranch) {
    return true;
  }
  const normalizedToken = taskId.replace("#", "-").toLowerCase();
  // Token must appear bounded by non-alphanumeric chars (or string boundaries)
  // so `mt-1362` doesn't false-match inside `mt-13620` or `mt-1362-extra`.
  // (The latter IS a legit own-branch shape, so we DO match it via the trailing `-`.)
  const escaped = normalizedToken.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const tokenRegex = new RegExp(`(^|[/_-])${escaped}($|[/_-])`, "i");
  return tokenRegex.test(branchName);
}

/**
 * Run the open-PR sweep. Skips PRs whose branch matches the task's own branch
 * (per `isOwnBranch` heuristic) to avoid false self-collision.
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
  warnings: string[] = []
): ParallelWorkCollision[] {
  const prs = fetchPrs(input.repo);
  const collisions: ParallelWorkCollision[] = [];

  // Bound the per-PR sweep so we don't blow past the 30s hook timeout in
  // repos with hundreds of open PRs. 200 covers the realistic working set
  // and matches the open-PR fetch upper bound from `gh api` pagination;
  // beyond that we warn and stop scanning.
  const MAX_PRS_TO_SCAN = 200;
  const prsToScan = prs.slice(0, MAX_PRS_TO_SCAN);
  if (prs.length > MAX_PRS_TO_SCAN) {
    warnings.push(
      `Open-PR sweep capped at ${MAX_PRS_TO_SCAN} of ${prs.length} open PRs (preserves 30s hook budget)`
    );
  }

  for (const pr of prsToScan) {
    // Skip the task's own branch via robust detection (handles non-standard naming)
    if (isOwnBranch(pr.headRefName, input.taskId, currentBranch)) {
      continue;
    }

    const prFiles = fetchFiles(input.repo, pr.number, warnings);
    const overlapping = findOverlappingFiles(input.inScopeFiles, prFiles);

    if (overlapping.length > 0) {
      collisions.push({
        type: "open-pr",
        prNumber: pr.number,
        prTitle: pr.title,
        overlappingFiles: overlapping,
      });
    }
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
  const symbolic = execWithPath(["git", "-C", repoDir, "symbolic-ref", "refs/remotes/origin/HEAD"]);
  if (symbolic.exitCode === 0 && symbolic.stdout.trim()) {
    return { ref: symbolic.stdout.trim().replace(/^refs\/remotes\//, "") };
  }

  // Probe 2: `git remote show origin` — parses "HEAD branch: <name>"
  const remoteShow = execWithPath(["git", "-C", repoDir, "remote", "show", "origin"]);
  if (remoteShow.exitCode === 0) {
    const headMatch = remoteShow.stdout.match(/^\s*HEAD branch:\s*(\S+)\s*$/m);
    if (headMatch && headMatch[1] !== "(unknown)") {
      return { ref: `origin/${headMatch[1]}` };
    }
  }

  // Probes 3 and 4: try common defaults explicitly
  for (const candidate of ["main", "master"]) {
    const probe = execWithPath([
      "git",
      "-C",
      repoDir,
      "rev-parse",
      "--verify",
      `origin/${candidate}`,
    ]);
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
  defaultBranchRef?: string
): ParallelWorkCollision[] {
  // ISO timestamp for `hours` ago
  const since = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();

  const branchRef = defaultBranchRef ?? "origin/main";

  // Get log with file names in the last N hours on the default branch
  const result = execWithPath([
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
  ]);

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
  for (const entry of entries) {
    const overlapping = findOverlappingFiles(inScopeFiles, entry.files);
    if (overlapping.length > 0) {
      collisions.push({
        type: "recently-merged",
        commitSha: entry.sha.slice(0, 7),
        commitMessage: entry.message,
        overlappingFiles: overlapping,
      });
    }
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
    defaultBranchRef?: string
  ) => ParallelWorkCollision[];
  detectDefaultBranch: (repoDir: string) => { ref: string | null; warning?: string };
}

const DEFAULT_DEPS: ParallelWorkCheckDeps = {
  fetchOpenPrs,
  fetchPrFiles,
  fetchRecentMerges,
  detectDefaultBranch,
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

  // Check A: open PRs
  try {
    const prCollisions = checkOpenPrs(
      input,
      currentBranch,
      deps.fetchOpenPrs,
      deps.fetchPrFiles,
      warnings
    );
    collisions.push(...prCollisions);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    warnings.push(`Open-PR sweep failed (non-blocking): ${msg}`);
  }

  // Check B: recently merged — detect default branch first
  try {
    const { ref: defaultBranchRef, warning: branchWarning } = deps.detectDefaultBranch(repoDir);
    if (branchWarning) {
      warnings.push(branchWarning);
    }
    if (defaultBranchRef === null) {
      // All probes failed; skip the sweep rather than running against a wrong ref
    } else {
      const mergeCollisions = deps.fetchRecentMerges(
        repoDir,
        input.inScopeFiles,
        input.lookbackHours,
        defaultBranchRef
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
 */
export function fetchTaskSpec(taskId: string): string | null {
  const pathPrefix = `/opt/homebrew/bin:/usr/local/bin:${process.env.PATH ?? ""}`;

  const result = Bun.spawnSync(["minsky", "tasks", "spec", "get", taskId], {
    env: { ...process.env, PATH: pathPrefix },
    stdout: "pipe",
    stderr: "pipe",
  });

  if (result.exitCode !== 0) {
    return null;
  }

  return result.stdout.toString();
}

// ---------------------------------------------------------------------------
// Repo derivation
// ---------------------------------------------------------------------------

/**
 * Parse an `owner/repo` slug out of a GitHub remote URL. Returns null if the
 * URL doesn't look like a GitHub remote.
 *
 * Supports four forms:
 *   - SCP-style SSH:    `git@github.com:owner/repo[.git]`
 *   - URL-style SSH:    `ssh://git@github.com/owner/repo[.git]` or `ssh://github.com/owner/repo[.git]`
 *   - HTTPS:            `https://github.com/owner/repo[.git][/]`
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

  // URL-style SSH: ssh://[git@]github.com/owner/repo[.git][/]
  const sshUrlMatch = trimmed.match(/^ssh:\/\/(?:git@)?github\.com\/([^/]+\/[^/]+?)(?:\.git)?\/?$/);
  if (sshUrlMatch) {
    return sshUrlMatch[1];
  }

  // HTTPS form: https://github.com/owner/repo[.git][/]
  const httpsMatch = trimmed.match(/^https:\/\/github\.com\/([^/]+\/[^/]+?)(?:\.git)?\/?$/);
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
  const result = execWithPath(["git", "-C", repoDir, "remote", "get-url", "origin"]);
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

  // Detect the actual current branch (most reliable own-branch signal). If
  // the call fails, isOwnBranch falls back to a token-based regex on the
  // normalized task ID.
  const branchProbe = execWithPath(["git", "-C", repoDir, "rev-parse", "--abbrev-ref", "HEAD"]);
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

  process.exit(0);
}
