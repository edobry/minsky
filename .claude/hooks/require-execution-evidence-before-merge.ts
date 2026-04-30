#!/usr/bin/env bun
// PreToolUse hook: block session_pr_merge if a PR adds new test files but the PR body
// lacks an "Execution evidence:" block.
//
// Rationale: Memory-tier enforcement (`feedback_behavior_detecting_artifacts_need_execution_evidence`)
// failed 4-for-4 at the mt#1205 workstream. The first live run found 3 real bugs in 326ms,
// including a production bug that had silently no-op'd `withPgPoolRetry` for ~3 days.
//
// This hook makes the discipline structural: at the exact tool call boundary where the
// failure mode occurs (merging a PR that adds tests that have never been run).
//
// Two escape hatches:
//   1. PR title starts with `[unverified-tests]` — allows merge with a warning.
//      Use when tests cannot be run yet (e.g. infrastructure not deployed) and a
//      follow-up verification task is filed.
//   2. PR body contains `Execution evidence:` — evidence paste from actual test run.
//
// @see mt#1459 — this hook implementation
// @see mt#1460 — sibling /prepare-pr skill step (PR-creation-time guard)
// @see feedback_behavior_detecting_artifacts_need_execution_evidence — four-incident history

import { readInput, writeOutput } from "./types";
import type { ToolHookInput } from "./types";

// ---------------------------------------------------------------------------
// PATH-augmented subprocess helper
// ---------------------------------------------------------------------------

/**
 * Wrapper around Bun.spawnSync that prepends common homebrew/system binary
 * directories to PATH so that `gh` resolves correctly regardless of
 * the shell PATH that launched Claude Code.
 */
function execWithPath(
  cmd: string[],
  options?: { cwd?: string; timeout?: number }
): { exitCode: number; stdout: string; stderr: string } {
  const pathPrefix = `/opt/homebrew/bin:/usr/local/bin:${process.env.PATH ?? ""}`;
  const result = Bun.spawnSync(cmd, {
    cwd: options?.cwd,
    stdout: "pipe",
    stderr: "pipe",
    timeout: options?.timeout ?? 10000,
    env: { ...process.env, PATH: pathPrefix },
  });
  return {
    exitCode: result.exitCode ?? 1,
    stdout: result.stdout.toString().trim(),
    stderr: result.stderr.toString().trim(),
  };
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** File entry from GitHub PR files API */
export interface PrFile {
  filename: string;
  status: "added" | "removed" | "modified" | "renamed" | "copied" | "changed" | "unchanged";
}

/** Result of the execution-evidence check */
export interface ExecutionEvidenceCheckResult {
  /** Whether merge should be blocked */
  blocked: boolean;
  /** Human-readable reason if blocked; undefined if allowed */
  reason?: string;
  /** Any new test files found in the PR diff */
  newTestFiles: string[];
  /** Whether the bypass prefix was detected */
  bypassDetected: boolean;
  /** Any non-fatal warnings to surface */
  warnings: string[];
}

// ---------------------------------------------------------------------------
// Test file detection
// ---------------------------------------------------------------------------

/**
 * Pattern for test files we care about. Matches:
 *   - *.test.ts
 *   - *.integration.test.ts
 *   - *.spec.ts
 */
const TEST_FILE_PATTERN = /\.(test|integration\.test|spec)\.ts$/;

/**
 * Returns true when a filename matches a test-file pattern.
 */
export function isTestFile(filename: string): boolean {
  return TEST_FILE_PATTERN.test(filename);
}

/**
 * Filters a list of PrFile objects to only those that are newly ADDED test files.
 */
export function findNewTestFiles(files: PrFile[]): string[] {
  return files.filter((f) => f.status === "added" && isTestFile(f.filename)).map((f) => f.filename);
}

// ---------------------------------------------------------------------------
// PR body parsing
// ---------------------------------------------------------------------------

/**
 * Returns true when the PR body contains an "Execution evidence:" block.
 * The heading is case-insensitive and may appear anywhere in the body.
 */
export function hasExecutionEvidence(prBody: string): boolean {
  return /execution evidence:/i.test(prBody);
}

/**
 * Returns true when the PR title starts with the bypass prefix `[unverified-tests]`
 * (case-insensitive).
 */
export function hasBypassPrefix(prTitle: string): boolean {
  return /^\[unverified-tests\]/i.test(prTitle.trim());
}

// ---------------------------------------------------------------------------
// PR data fetching (injectable for tests)
// ---------------------------------------------------------------------------

export interface PrDeps {
  fetchPrFiles: (repo: string, prNumber: number) => PrFile[];
  fetchPrMeta: (repo: string, prNumber: number) => { title: string; body: string } | null;
}

/**
 * Fetch PR files from GitHub API.
 * Returns empty array on error (fail-open: if we can't check, allow merge).
 */
export function makeProdPrDeps(cwd?: string): PrDeps {
  return {
    fetchPrFiles(repo: string, prNumber: number): PrFile[] {
      const result = execWithPath(
        [
          "gh",
          "api",
          `repos/${repo}/pulls/${prNumber}/files`,
          "--jq",
          "[.[] | {filename: .filename, status: .status}]",
        ],
        { cwd, timeout: 15000 }
      );
      if (result.exitCode !== 0) return [];
      try {
        return JSON.parse(result.stdout) as PrFile[];
      } catch {
        return [];
      }
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
// Core check logic (pure / injectable)
// ---------------------------------------------------------------------------

/**
 * Run the execution-evidence check given PR files and metadata.
 * This is the pure core of the hook — injectable for unit tests.
 */
export function checkExecutionEvidence(
  prFiles: PrFile[],
  prTitle: string,
  prBody: string
): ExecutionEvidenceCheckResult {
  const warnings: string[] = [];
  const newTestFiles = findNewTestFiles(prFiles);

  // No new test files → hook is silent
  if (newTestFiles.length === 0) {
    return { blocked: false, newTestFiles: [], bypassDetected: false, warnings };
  }

  // Bypass prefix present → allow with warning
  const bypassDetected = hasBypassPrefix(prTitle);
  if (bypassDetected) {
    warnings.push(
      `[unverified-tests] bypass detected: merge proceeding without execution evidence for ` +
        `${newTestFiles.length} new test file(s). File a follow-up verification task.`
    );
    return { blocked: false, newTestFiles, bypassDetected: true, warnings };
  }

  // Execution evidence present → allow
  if (hasExecutionEvidence(prBody)) {
    return { blocked: false, newTestFiles, bypassDetected: false, warnings };
  }

  // No evidence, no bypass → block
  const fileList = newTestFiles.map((f) => `  - ${f}`).join("\n");
  const reason =
    `Merge blocked: PR adds ${newTestFiles.length} new test file(s) but PR body has no ` +
    `\`Execution evidence:\` block.\n\n` +
    `New test files:\n${fileList}\n\n` +
    `To unblock, choose one of:\n` +
    `  1. Run the new tests and paste output under an \`Execution evidence:\` heading in ` +
    `the PR body (use mcp__minsky__session_pr_edit to update the body).\n` +
    `  2. Prefix the PR title with \`[unverified-tests]\` and file a follow-up ` +
    `verification task before re-attempting the merge.`;

  return { blocked: true, reason, newTestFiles, bypassDetected: false, warnings };
}

// ---------------------------------------------------------------------------
// Top-level hook entry point
// ---------------------------------------------------------------------------

if (import.meta.main) {
  const input = await readInput<ToolHookInput>();

  const task = (input.tool_input.task as string | undefined) ?? "";
  if (!task) process.exit(0);

  const branch = `task/${task.replace("#", "-")}`;

  // Resolve PR number from branch
  const prResult = execWithPath(
    [
      "gh",
      "pr",
      "list",
      "--repo",
      "edobry/minsky",
      "--head",
      branch,
      "--json",
      "number",
      "--jq",
      ".[0].number",
    ],
    { cwd: input.cwd }
  );

  const prNumber = parseInt(prResult.stdout.trim(), 10);
  if (!prNumber || isNaN(prNumber)) process.exit(0);

  const deps = makeProdPrDeps(input.cwd);
  const prFiles = deps.fetchPrFiles("edobry/minsky", prNumber);
  const prMeta = deps.fetchPrMeta("edobry/minsky", prNumber);

  // If we can't fetch PR data, fail-open (allow merge with a warning)
  if (!prMeta) {
    writeOutput({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        additionalContext: `⚠️ Could not fetch PR #${prNumber} metadata to check execution evidence. Proceeding without check.`,
      },
    });
    process.exit(0);
  }

  const result = checkExecutionEvidence(prFiles, prMeta.title, prMeta.body);

  // Surface any warnings even on allow
  for (const warning of result.warnings) {
    writeOutput({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        additionalContext: `⚠️ ${warning}`,
      },
    });
  }

  if (result.blocked) {
    writeOutput({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: result.reason,
      },
    });
  }
}
