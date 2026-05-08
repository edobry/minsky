#!/usr/bin/env bun
// PreToolUse hook: block the `Skill` tool when skill === "loop" and the prompt
// args reference PRs or tasks that are already in a terminal state.
//
// Rationale: When a user invokes /loop to drive PR #N to convergence and that
// PR has already been merged, the loop will run for hours producing orphan
// commits on a closed branch. This hook detects the terminal state up-front
// and blocks before the first iteration.
//
// Origin: 2026-05-01 retrospective on PR #922 (mt#1496). User merged at 18:24Z;
// agent iterated /loop for ~6 more hours, attributing bot silence to webhook miss
// without checking PR state. Orphan commit 1d683c925 was pushed to a closed
// branch and is not in main.
//
// What is checked:
//   For each PR number extracted from args: gh api to get state + merged fields.
//   For each task ID extracted from args: minsky tasks status get --json.
//
// On hit: BLOCK with structured message naming each terminal-state item.
// On miss or warn: permit (fail-open on partial coverage failures).
// Override: MINSKY_FORCE_LOOP_TERMINAL=1 env var bypasses with audit log.
//
// @see mt#1555 — tracking task
// @see parallel-work-guard.ts — reference implementation (same shape)

import { readInput, writeOutput, execWithPath, readHostCap, deriveBudgets } from "./types";
import type { ToolHookInput } from "./types";

// ---------------------------------------------------------------------------
// Budget derivation (mt#1546 pattern)
// ---------------------------------------------------------------------------

// Derive timeouts from the host cap configured in settings.json. This is
// called at entrypoint time (inside `if (import.meta.main)`) so that importing
// this module for tests has no fs/env side effects.
function getDerivedTimeoutMs(): number {
  const { hostCapSec } = readHostCap("loop-preflight-pr-merge-check.ts");
  const { gitTimeoutMs } = deriveBudgets(hostCapSec);
  return gitTimeoutMs;
}

// Fallback used when a concrete timeout is needed outside the main entrypoint
// (e.g., in pure-helper calls from tests that pass a timeout explicitly).
const FALLBACK_TIMEOUT_MS = 5_000;

// ---------------------------------------------------------------------------
// Regex helpers (pure functions, unit-tested)
// ---------------------------------------------------------------------------

/**
 * Extract PR numbers from a free-form string.
 *
 * Accepted patterns (case-insensitive):
 *   - `#922`               (hash-prefixed number)
 *   - `PR #922`            (word "PR" then hash-prefixed number)
 *   - `PR 922`             (word "PR" then bare number)
 *   - `pull/922`           (path segment, for GitHub URLs)
 *   - `pulls/922`          (path segment, for GitHub URLs)
 *
 * Excludes task-ID patterns like `mt#922` or `md#922` by requiring that the
 * `#` prefix not be preceded by word characters.
 *
 * Returns a deduplicated array of number-typed PR numbers.
 */
export function extractPrNumbers(text: string): number[] {
  const seen = new Set<number>();
  const results: number[] = [];

  // Pattern 1: bare `#NNN` or `PR #NNN` / `PR NNN`
  // Require word boundary or start-of-word before `#` so task IDs like
  // `mt#922` don't match. The negative lookbehind `(?<!\w)` handles this.
  const hashRe = /(?<!\w)#(\d+)/g;
  let m: RegExpExecArray | null;
  while ((m = hashRe.exec(text)) !== null) {
    const n = parseInt(m[1] as string, 10);
    if (!isNaN(n) && !seen.has(n)) {
      seen.add(n);
      results.push(n);
    }
  }

  // Pattern 2: `PR NNN` (bare number, no hash)
  const prBareRe = /\bPR\s+(\d+)\b/gi;
  while ((m = prBareRe.exec(text)) !== null) {
    const n = parseInt(m[1] as string, 10);
    if (!isNaN(n) && !seen.has(n)) {
      seen.add(n);
      results.push(n);
    }
  }

  // Pattern 3: `pull/NNN` or `pulls/NNN` (GitHub URL path segments)
  const urlRe = /\bpulls?\/(\d+)\b/gi;
  while ((m = urlRe.exec(text)) !== null) {
    const n = parseInt(m[1] as string, 10);
    if (!isNaN(n) && !seen.has(n)) {
      seen.add(n);
      results.push(n);
    }
  }

  return results;
}

/**
 * Extract task IDs from a free-form string.
 *
 * Accepted patterns (case-insensitive):
 *   - `mt#1555`  (Minsky DB task)
 *   - `md#409`   (Minsky DB alternate prefix)
 *
 * Returns a deduplicated array of task ID strings in their original case
 * (normalized to lowercase prefix + original digit suffix).
 */
export function extractTaskIds(text: string): string[] {
  const seen = new Set<string>();
  const results: string[] = [];

  // Match `mt#NNN` or `md#NNN` (case-insensitive prefix)
  const taskRe = /\b(mt|md)#(\d+)\b/gi;
  let m: RegExpExecArray | null;
  while ((m = taskRe.exec(text)) !== null) {
    // Normalize to lowercase prefix to deduplicate case variants
    const normalized = `${m[1].toLowerCase()}#${m[2]}`;
    if (!seen.has(normalized)) {
      seen.add(normalized);
      results.push(normalized);
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// PR state check
// ---------------------------------------------------------------------------

export interface PrStateResult {
  prNumber: number;
  state: "open" | "closed";
  merged: boolean;
  title: string;
}

export type PrCheckOutcome =
  | { kind: "terminal"; result: PrStateResult }
  | { kind: "active"; result: PrStateResult }
  | { kind: "error"; prNumber: number; warning: string };

/**
 * Fetch the state of a single PR via `gh api`.
 *
 * Returns a PrCheckOutcome:
 *   - "terminal" if the PR is merged or closed
 *   - "active" if the PR is open and not merged
 *   - "error" if the gh call fails (404, network error, etc.)
 *
 * On error, pushes a warning to the `warnings` array and returns "error"
 * so the caller can permit the tool call gracefully (partial-coverage posture).
 */
export function checkPrState(
  repo: string,
  prNumber: number,
  warnings: string[],
  timeoutMs: number = FALLBACK_TIMEOUT_MS
): PrCheckOutcome {
  const result = execWithPath(
    [
      "gh",
      "api",
      `repos/${repo}/pulls/${prNumber}`,
      "--jq",
      '.state + "\\t" + (.merged | tostring) + "\\t" + .title',
    ],
    { timeout: timeoutMs }
  );

  if (result.exitCode !== 0) {
    const warning = `Could not check PR #${prNumber}: gh exited ${result.exitCode}: ${result.stderr || result.stdout}`;
    warnings.push(warning);
    return { kind: "error", prNumber, warning };
  }

  const parts = result.stdout.trim().split("\t");
  if (parts.length < 3) {
    const warning = `Could not parse PR #${prNumber} response: '${result.stdout.trim()}'`;
    warnings.push(warning);
    return { kind: "error", prNumber, warning };
  }

  const state = (parts[0] as string).toLowerCase() === "open" ? "open" : "closed";
  const merged = (parts[1] as string).toLowerCase() === "true";
  const title = parts.slice(2).join("\t");

  const prResult: PrStateResult = { prNumber, state, merged, title };
  const isTerminal = state === "closed" || merged;
  return { kind: isTerminal ? "terminal" : "active", result: prResult };
}

// ---------------------------------------------------------------------------
// Task state check
// ---------------------------------------------------------------------------

export interface TaskStateResult {
  taskId: string;
  status: string;
}

export type TaskCheckOutcome =
  | { kind: "terminal"; result: TaskStateResult }
  | { kind: "active"; result: TaskStateResult }
  | { kind: "error"; taskId: string; warning: string };

/** Terminal task statuses per the task lifecycle. */
export const TERMINAL_TASK_STATUSES: ReadonlySet<string> = new Set(["DONE", "CLOSED"]);

/**
 * Fetch the status of a single task via the `minsky` CLI.
 *
 * Returns a TaskCheckOutcome:
 *   - "terminal" if the task is DONE or CLOSED
 *   - "active" if the task is in any other status
 *   - "error" if the minsky call fails (task not found, CLI error, etc.)
 */
export function checkTaskState(
  taskId: string,
  warnings: string[],
  timeoutMs: number = FALLBACK_TIMEOUT_MS
): TaskCheckOutcome {
  // Use `minsky tasks status get <id> --json` to get a JSON response.
  // The `--json` flag returns the status as a JSON string.
  const result = execWithPath(["minsky", "tasks", "status", "get", taskId, "--json"], {
    timeout: timeoutMs,
  });

  if (result.exitCode !== 0) {
    const warning = `Could not check task ${taskId}: minsky exited ${result.exitCode}: ${result.stderr || result.stdout}`;
    warnings.push(warning);
    return { kind: "error", taskId, warning };
  }

  let status: string;
  try {
    // The output may be a JSON string like `"DONE"` or a JSON object like
    // `{ "status": "DONE" }`. Handle both. JSON.parse returns `any`;
    // we narrow explicitly with typeof/in checks below.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const parsed: any = JSON.parse(result.stdout.trim());
    if (typeof parsed === "string") {
      status = parsed;
    } else if (parsed !== null && typeof parsed === "object" && "status" in parsed) {
      status = String((parsed as { status: unknown }).status);
    } else {
      // Fallback: treat raw output as the status string
      status = result.stdout.trim();
    }
  } catch {
    // JSON parse failed — use raw output as the status
    status = result.stdout.trim();
  }

  const isTerminal = TERMINAL_TASK_STATUSES.has(status.toUpperCase());
  const taskResult: TaskStateResult = { taskId, status };
  return { kind: isTerminal ? "terminal" : "active", result: taskResult };
}

// ---------------------------------------------------------------------------
// Repo derivation
// ---------------------------------------------------------------------------

/**
 * Parse an `owner/repo` slug from a GitHub remote URL.
 * Supports SCP-style SSH, URL-style SSH, and HTTPS forms.
 * Pure function — no I/O.
 */
export function parseGitHubRemoteUrl(url: string): string | null {
  const trimmed = url.trim();

  // SCP-style SSH: git@github.com:owner/repo[.git]
  const sshMatch = trimmed.match(/^git@github\.com:([^/]+\/[^/]+?)(?:\.git)?$/);
  if (sshMatch) return sshMatch[1] as string;

  // URL-style SSH (with optional port): ssh://[git@]github.com[:port]/owner/repo[.git][/]
  const sshUrlMatch = trimmed.match(
    /^(?:git\+)?ssh:\/\/(?:[^@]+@)?github\.com(?::\d+)?\/([^/]+\/[^/]+?)(?:\.git)?\/?$/
  );
  if (sshUrlMatch) return sshUrlMatch[1] as string;

  // HTTPS form: https://[token@]github.com/owner/repo[.git][/]
  const httpsMatch = trimmed.match(
    /^https:\/\/(?:[^@]+@)?github\.com\/([^/]+\/[^/]+?)(?:\.git)?\/?$/
  );
  if (httpsMatch) return httpsMatch[1] as string;

  return null;
}

/**
 * Derive the GitHub `owner/repo` slug from the `origin` remote of the given
 * git working directory. Returns null if the remote can't be read or parsed.
 */
export function deriveRepoFromGit(
  repoDir: string,
  timeoutMs: number = FALLBACK_TIMEOUT_MS
): string | null {
  const result = execWithPath(["git", "-C", repoDir, "remote", "get-url", "origin"], {
    timeout: timeoutMs,
  });
  if (result.exitCode !== 0 || !result.stdout.trim()) return null;
  return parseGitHubRemoteUrl(result.stdout);
}

// ---------------------------------------------------------------------------
// Block message formatting
// ---------------------------------------------------------------------------

export interface TerminalPrItem {
  prNumber: number;
  title: string;
  state: string;
  merged: boolean;
}

export interface TerminalTaskItem {
  taskId: string;
  status: string;
}

/**
 * Format the structured block message when terminal-state items are found.
 * Names each item and explains why the loop is being blocked.
 */
export function formatBlockMessage(
  terminalPrs: TerminalPrItem[],
  terminalTasks: TerminalTaskItem[]
): string {
  const lines: string[] = [
    "Loop preflight: /loop blocked — one or more referenced PRs/tasks are already in a terminal state.",
    "",
  ];

  for (const pr of terminalPrs) {
    const stateLabel = pr.merged ? "MERGED" : "CLOSED";
    lines.push(`  PR #${pr.prNumber} is ${stateLabel}: "${pr.title}"`);
  }

  for (const task of terminalTasks) {
    lines.push(`  Task ${task.taskId} is ${task.status}`);
  }

  lines.push("");
  lines.push("Iterating on closed/merged PRs or completed tasks wastes resources and may produce");
  lines.push("orphan commits on closed branches (see mt#1555 origin incident, PR #922).");
  lines.push("");
  lines.push("Recommended actions:");
  lines.push("  1. CHECK — verify the terminal state is intentional before continuing.");
  lines.push("  2. REFRAME — if you meant a different PR/task, clarify the prompt and retry.");
  lines.push("  3. OVERRIDE — if iteration on a terminal item is intentional:");
  lines.push("       Set MINSKY_FORCE_LOOP_TERMINAL=1 in your environment and retry.");
  lines.push("       The override is audit-logged to session stdout.");

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Main preflight check logic
// ---------------------------------------------------------------------------

export interface LoopPreflightResult {
  blocked: boolean;
  terminalPrs: TerminalPrItem[];
  terminalTasks: TerminalTaskItem[];
  warnings: string[];
}

/**
 * Run the loop preflight check against all extracted PR numbers and task IDs.
 *
 * Partial-coverage posture: if a PR or task lookup fails (404, network error),
 * it logs a warning but does NOT block — the hook is conservative in the
 * "fail-open on errors" direction.
 *
 * Injectable `checkPr` and `checkTask` deps so tests can exercise the
 * terminal/active/error paths without live gh/minsky calls.
 */
export function runLoopPreflightCheck(
  prNumbers: number[],
  taskIds: string[],
  repo: string,
  warnings: string[],
  timeoutMs: number = FALLBACK_TIMEOUT_MS,
  checkPr: (
    repo: string,
    prNumber: number,
    warnings: string[],
    timeoutMs: number
  ) => PrCheckOutcome = checkPrState,
  checkTask: (
    taskId: string,
    warnings: string[],
    timeoutMs: number
  ) => TaskCheckOutcome = checkTaskState
): LoopPreflightResult {
  const terminalPrs: TerminalPrItem[] = [];
  const terminalTasks: TerminalTaskItem[] = [];

  for (const prNumber of prNumbers) {
    const outcome = checkPr(repo, prNumber, warnings, timeoutMs);
    if (outcome.kind === "terminal") {
      terminalPrs.push({
        prNumber: outcome.result.prNumber,
        title: outcome.result.title,
        state: outcome.result.state,
        merged: outcome.result.merged,
      });
    }
    // "active" and "error" outcomes: don't block
  }

  for (const taskId of taskIds) {
    const outcome = checkTask(taskId, warnings, timeoutMs);
    if (outcome.kind === "terminal") {
      terminalTasks.push({
        taskId: outcome.result.taskId,
        status: outcome.result.status,
      });
    }
    // "active" and "error" outcomes: don't block
  }

  const blocked = terminalPrs.length > 0 || terminalTasks.length > 0;
  return { blocked, terminalPrs, terminalTasks, warnings };
}

// ---------------------------------------------------------------------------
// Hook entry point
// ---------------------------------------------------------------------------

if (import.meta.main) {
  const input = await readInput<ToolHookInput>();

  // Only act on the Skill tool
  if (input.tool_name !== "Skill") {
    process.exit(0);
  }

  // Only act when skill === "loop"
  const skillName = input.tool_input["skill"] as string | undefined;
  if (skillName !== "loop") {
    process.exit(0);
  }

  // Check for override env var
  const forceTerminal = process.env["MINSKY_FORCE_LOOP_TERMINAL"];
  if (forceTerminal === "1") {
    const ts = new Date().toISOString();
    process.stdout.write(
      `[loop-preflight] OVERRIDE active (MINSKY_FORCE_LOOP_TERMINAL=1) — ts=${ts}\n`
    );
    process.exit(0);
  }

  // Derive budget from host cap
  const timeoutMs = getDerivedTimeoutMs();

  // Extract the loop prompt args for PR/task references
  const args = (input.tool_input["args"] as string | undefined) ?? "";
  const prNumbers = extractPrNumbers(args);
  const taskIds = extractTaskIds(args);

  // If no PR/task references, permit immediately
  if (prNumbers.length === 0 && taskIds.length === 0) {
    process.exit(0);
  }

  const warnings: string[] = [];

  // Derive repo from git remote
  const repoDir = input.cwd;
  const repo = deriveRepoFromGit(repoDir, timeoutMs);
  if (!repo) {
    process.stdout.write(
      `[loop-preflight] Could not derive owner/repo from git remote — PR check skipped\n`
    );
    // Still check tasks even if repo derivation fails
    if (taskIds.length === 0) {
      process.exit(0);
    }
  }

  const result = runLoopPreflightCheck(
    repo ? prNumbers : [], // skip PR checks if no repo
    taskIds,
    repo ?? "",
    warnings,
    timeoutMs
  );

  for (const w of warnings) {
    process.stdout.write(`[loop-preflight] ${w}\n`);
  }

  if (result.blocked) {
    writeOutput({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: formatBlockMessage(result.terminalPrs, result.terminalTasks),
      },
    });
    process.exit(0);
  }

  // Permit: surface any warnings in additionalContext
  if (warnings.length > 0) {
    writeOutput({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        additionalContext: warnings.map((w) => `[loop-preflight] ${w}`).join("\n"),
      },
    });
  }

  process.exit(0);
}
