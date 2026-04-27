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
//   B. Recently-merged sweep: any commit on main in the last 24h touching in-scope paths.
//
// On hit: BLOCK with structured message listing the colliding PR/commit.
// On miss or warn: permit.
// Override: MINSKY_FORCE_PARALLEL=1 env var bypasses with audit log.
//
// @see mt#1362 — Tier-3 structural ceiling for the parallel-work guard ladder
// @see mt#1305 — Tier-2 skill-step enforcement (floor)
// @see feedback_check_parallel_work_before_decomposing — four-incident history

import { execSync, readInput, writeOutput } from "./types";
import type { ToolHookInput } from "./types";

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

  // Find ## Scope section
  const scopeMatch = specContent.match(/^##\s+Scope\s*$/m);
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

  // Find "**In scope:**" block
  const inScopeMatch = scopeContent.match(/\*\*In scope:\*\*/i);
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
 * Fetch open PRs from the repository. Returns a list of {number, title, headRefName}.
 */
export function fetchOpenPrs(repo: string): PrInfo[] {
  const result = execSync([
    "gh",
    "pr",
    "list",
    "--repo",
    repo,
    "--state",
    "open",
    "--json",
    "number,title,headRefName",
    "--limit",
    "50",
  ]);

  if (result.exitCode !== 0 || !result.stdout.trim()) {
    return [];
  }

  try {
    return JSON.parse(result.stdout) as PrInfo[];
  } catch {
    return [];
  }
}

/**
 * Fetch the list of changed files for a PR number.
 */
export function fetchPrFiles(repo: string, prNumber: number): string[] {
  const result = execSync([
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

  if (result.exitCode !== 0 || !result.stdout.trim()) {
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
 * Run the open-PR sweep. Skips the PR for the current task's own branch.
 */
export function checkOpenPrs(
  input: ParallelWorkCheckInput,
  skipBranch?: string
): ParallelWorkCollision[] {
  const prs = fetchOpenPrs(input.repo);
  const collisions: ParallelWorkCollision[] = [];

  for (const pr of prs) {
    // Skip the task's own branch (if session already existed)
    if (skipBranch && pr.headRefName === skipBranch) {
      continue;
    }

    const prFiles = fetchPrFiles(input.repo, pr.number);
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
 * Fetch commits on main in the last `hours` hours that touch any of the
 * in-scope paths. Uses `git log --name-only` for file list.
 */
export function fetchRecentMerges(
  repoDir: string,
  inScopeFiles: string[],
  hours: number
): ParallelWorkCollision[] {
  // ISO timestamp for `hours` ago
  const since = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();

  // Get log with file names in the last N hours on main
  const result = execSync([
    "git",
    "-C",
    repoDir,
    "log",
    "origin/main",
    `--since=${since}`,
    "--name-only",
    "--format=COMMIT:%H %s",
    "--no-merges",
  ]);

  if (result.exitCode !== 0 || !result.stdout.trim()) {
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
 * Run both parallel-work checks (open-PR + recently-merged).
 * Returns a structured result with all collisions found.
 *
 * The `repoDir` param is only needed for the git log check; if absent,
 * the recently-merged check is skipped.
 */
export function runParallelWorkChecks(
  input: ParallelWorkCheckInput,
  repoDir: string,
  skipBranch?: string
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
    const prCollisions = checkOpenPrs(input, skipBranch);
    collisions.push(...prCollisions);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    warnings.push(`Open-PR sweep failed (non-blocking): ${msg}`);
  }

  // Check B: recently merged
  try {
    const mergeCollisions = fetchRecentMerges(repoDir, input.inScopeFiles, input.lookbackHours);
    collisions.push(...mergeCollisions);
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
// Hook entry point
// ---------------------------------------------------------------------------

if (import.meta.main) {
  const input = await readInput<ToolHookInput>();

  // Only act on session_start
  if (input.tool_name !== "mcp__minsky__session_start") {
    process.exit(0);
  }

  const taskId = (input.tool_input.taskId as string | undefined) ?? "";
  if (!taskId) {
    // No task ID — can't run check; warn and allow
    process.stdout.write(
      `[parallel-work-guard] No taskId in session_start input — check skipped\n`
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

  const repo = "edobry/minsky";
  const repoDir = input.cwd;

  // Derive the task's own branch name so we skip it in the open-PR sweep
  const normalizedId = taskId.replace("#", "-").toLowerCase();
  const skipBranch = `task/${normalizedId}`;

  const checkInput: ParallelWorkCheckInput = {
    taskId,
    inScopeFiles,
    repo,
    lookbackHours: 24,
  };

  const result = runParallelWorkChecks(checkInput, repoDir, skipBranch);

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
