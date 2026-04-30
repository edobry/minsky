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

import { readInput, writeOutput, execWithPath } from "./types";
import type { ToolHookInput } from "./types";

// NOTE: execWithPath is centralized in types.ts and imported above.
// Both this hook and parallel-work-guard.ts consume it from there to keep
// PATH-augmentation and timeout behavior consistent across hooks.
// See NON-BLOCKING #5 from PR #909 round 1 review.

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
 * Returns true when the PR body contains an "Execution evidence:" block with
 * non-empty content following the marker.
 *
 * Acceptance criteria:
 *   - The marker must appear as a Markdown heading (## Execution evidence:)
 *     OR as a standalone label line (Execution evidence: <content>).
 *   - Negation phrases like "No Execution evidence:" do NOT qualify.
 *   - The heading must be followed by non-whitespace content.
 *
 * Detection strategy:
 *   1. Find a line that, after stripping leading # characters and whitespace,
 *      matches "Execution evidence:" (case-insensitive) — this is the heading.
 *   2. Verify the heading line itself does NOT start with "No " (negation guard).
 *   3. Require that there is at least one non-empty line of content after the
 *      heading and before the next Markdown heading or end-of-string.
 */
export function hasExecutionEvidence(prBody: string): boolean {
  // Matches lines that are (optional) Markdown heading + "Execution evidence:"
  // Anchored at start-of-line via the `m` flag.
  // The heading prefix (###, ##, #) is optional; plain "Execution evidence:" also matches.
  // Captures everything on the heading line before the marker for negation check.
  const headingPattern = /^(#{0,6}\s*)(execution evidence:\s*)(.*)$/im;

  const lines = prBody.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const match = line.match(headingPattern);
    if (!match) continue;

    // Negation guard: skip lines like "No Execution evidence:" or
    // "## No Execution evidence:" where the word before the marker is "No".
    // The text before "Execution" (captured in match[1]) should not end with
    // a negating word. We check the full line up to "execution" for "no ".
    const beforeMarker = line.slice(0, line.toLowerCase().indexOf("execution")).toLowerCase();
    if (/\bno\b/.test(beforeMarker)) continue;

    // Also reject template placeholders where the heading line itself contains
    // the full text on the same line — allow only if there's content on the same
    // line OR content follows on subsequent lines.
    const inlineContent = match[3].trim();
    if (inlineContent.length > 0) {
      // Inline content on the heading line counts as evidence
      return true;
    }

    // Look for non-empty content on subsequent lines before the next ## heading
    for (let j = i + 1; j < lines.length; j++) {
      const nextLine = lines[j];
      if (/^#{1,6}\s/.test(nextLine)) break; // next heading — stop
      if (nextLine.trim().length > 0) return true; // found content
    }
    // Heading found but no content — keep looking in case there's another
    // Execution evidence: block further down
  }

  return false;
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
      // Use --paginate so PRs with more than 30 files (GitHub's default page
      // size) are not silently truncated. --paginate accumulates all pages and
      // outputs them as a JSON array of per-page arrays; --jq flattens them.
      // Resolves BLOCKING #3 from PR #909 round 1 review.
      const result = execWithPath(
        [
          "gh",
          "api",
          `repos/${repo}/pulls/${prNumber}/files`,
          "--paginate",
          "--jq",
          "[.[] | {filename: .filename, status: .status}]",
        ],
        { cwd, timeout: 15000 }
      );
      if (result.exitCode !== 0) return [];
      try {
        // When --paginate is used with --jq, each page outputs one JSON array.
        // Multiple arrays may be concatenated in stdout. Merge them.
        const raw = result.stdout.trim();
        // Try direct parse first (single page — most common case)
        if (raw.startsWith("[")) {
          try {
            const parsed = JSON.parse(raw);
            // If it's an array of arrays (multi-page), flatten; else use as-is
            if (Array.isArray(parsed) && parsed.length > 0 && Array.isArray(parsed[0])) {
              return (parsed as PrFile[][]).flat();
            }
            return parsed as PrFile[];
          } catch {
            // Fall through to line-by-line parse
          }
        }
        // Multi-page: each line is a separate JSON array from --jq
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
        return pages.flat();
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
// Repo derivation (derives owner/repo from git remote — no hardcoded slugs)
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
  if (sshMatch) return sshMatch[1];
  // URL-style SSH (with optional port or git+ssh prefix)
  const sshUrlMatch = trimmed.match(
    /^(?:git\+)?ssh:\/\/(?:[^@]+@)?github\.com(?::\d+)?\/([^/]+\/[^/]+?)(?:\.git)?\/?$/
  );
  if (sshUrlMatch) return sshUrlMatch[1];
  // HTTPS form (with optional embedded credentials)
  const httpsMatch = trimmed.match(
    /^https:\/\/(?:[^@]+@)?github\.com\/([^/]+\/[^/]+?)(?:\.git)?\/?$/
  );
  if (httpsMatch) return httpsMatch[1];
  return null;
}

/**
 * Derive the GitHub `owner/repo` slug from the `origin` remote of the given
 * git working directory. Returns null if the remote can't be read or doesn't
 * look like a GitHub URL — callers should fail-open with a warning.
 */
export function deriveRepoFromGit(repoDir: string): string | null {
  const result = execWithPath(["git", "remote", "get-url", "origin"], {
    cwd: repoDir,
    timeout: 5000,
  });
  if (result.exitCode !== 0 || !result.stdout.trim()) return null;
  return parseGitHubRemoteUrl(result.stdout);
}

// ---------------------------------------------------------------------------
// Top-level hook entry point
// ---------------------------------------------------------------------------

if (import.meta.main) {
  const input = await readInput<ToolHookInput>();

  const task = (input.tool_input.task as string | undefined) ?? "";
  if (!task) process.exit(0);

  // Derive owner/repo from the git remote so the hook works on forks and
  // non-edobry/minsky remotes. Fail-open with a warning if derivation fails.
  // Resolves BLOCKING #2 from PR #909 round 1 review.
  const repo = deriveRepoFromGit(input.cwd);
  if (!repo) {
    writeOutput({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        additionalContext:
          "⚠️ [execution-evidence] Could not derive owner/repo from git remote — check skipped.",
      },
    });
    process.exit(0);
  }

  const branch = `task/${task.replace("#", "-")}`;

  // Resolve PR number from branch
  const prResult = execWithPath(
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
    { cwd: input.cwd }
  );

  const prNumber = parseInt(prResult.stdout.trim(), 10);
  if (!prNumber || isNaN(prNumber)) process.exit(0);

  const deps = makeProdPrDeps(input.cwd);
  const prFiles = deps.fetchPrFiles(repo, prNumber);
  const prMeta = deps.fetchPrMeta(repo, prNumber);

  // If we can't fetch PR data, fail-open (allow merge with a warning).
  // Single writeOutput call — emitting multiple JSON objects to stdout would
  // produce invalid JSON for consumers. Resolves BLOCKING #1 from PR #909 r1.
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

  if (result.blocked) {
    // Blocked: aggregate warnings + deny into a single writeOutput call.
    // Multiple JSON objects on stdout violate the single-JSON contract.
    // Resolves BLOCKING #1 from PR #909 round 1 review.
    const warningContext =
      result.warnings.length > 0 ? `${result.warnings.map((w) => `⚠️ ${w}`).join("\n")}\n\n` : "";
    writeOutput({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: `${warningContext}${result.reason}`,
      },
    });
  } else if (result.warnings.length > 0) {
    // Allowed but with warnings: single writeOutput with aggregated context.
    writeOutput({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        additionalContext: result.warnings.map((w) => `⚠️ ${w}`).join("\n"),
      },
    });
  }
}
