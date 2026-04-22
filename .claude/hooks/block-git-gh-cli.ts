#!/usr/bin/env bun
// PreToolUse hook: block git/gh CLI commands when a purpose-built MCP tool exists.
//
// Rationale: Minsky provides MCP tools for all common git/gh operations.
// Using raw CLI bypasses session resolution, auto-push, and audit trails.
// This hook intercepts Bash tool calls and denies known-equivalent operations.

import { readInput, writeOutput } from "./types";
import type { ToolHookInput } from "./types";

// ---------------------------------------------------------------------------
// Denial table types
// ---------------------------------------------------------------------------

export interface DenialRule {
  match: (args: string[]) => boolean;
  reason: string;
}

// ---------------------------------------------------------------------------
// Denial tables
// ---------------------------------------------------------------------------

export const gitDenials: DenialRule[] = [
  // git -C <path> anything — always deny, point to session_exec
  {
    match: (args) => args[0] === "-C",
    reason:
      "Use `mcp__minsky__session_exec(task, command)` instead of `git -C <path>`. It resolves the session directory automatically.",
  },
  {
    match: (args) => args[0] === "add",
    reason: "Use `mcp__minsky__session_commit` with `all: true` instead of `git add`.",
  },
  {
    match: (args) => args[0] === "commit",
    reason: "Use `mcp__minsky__session_commit` instead of `git commit`.",
  },
  {
    match: (args) => args[0] === "push",
    reason:
      "Use `mcp__minsky__session_commit` (auto-pushes) or `mcp__minsky__git_push` instead of `git push`.",
  },
  {
    match: (args) => args[0] === "status",
    reason:
      "Use `mcp__minsky__session_exec(task, 'git status')` inside a session, or avoid the call if context is available from diff/log tools.",
  },
  {
    match: (args) => args[0] === "log",
    reason: "Use `mcp__minsky__git_log` instead of `git log`.",
  },
  {
    match: (args) => args[0] === "diff",
    reason: "Use `mcp__minsky__git_diff` or `mcp__minsky__session_diff` instead of `git diff`.",
  },
  {
    match: (args) => args[0] === "blame",
    reason: "Use `mcp__minsky__git_blame` instead of `git blame`.",
  },
  {
    match: (args) => args[0] === "fetch",
    reason:
      "Fetch is handled automatically by `mcp__minsky__session_update` and other session ops.",
  },
  {
    match: (args) => args[0] === "pull",
    reason: "Pulling is handled by the post-merge-pull hook automatically.",
  },
  {
    match: (args) => args[0] === "clone",
    reason: "Use `mcp__minsky__session_start` instead of `git clone` for session creation.",
  },
  {
    match: (args) => args[0] === "checkout",
    reason: "Branch checkout is handled by session state ops (`session_start`, `session_update`).",
  },
  {
    match: (args) => args[0] === "branch",
    reason: "Branch management is handled by session state ops.",
  },
  {
    match: (args) => args[0] === "merge",
    reason: "Use `mcp__minsky__session_pr_merge` instead of `git merge`.",
  },
  {
    match: (args) => args[0] === "rebase",
    reason: "Rebasing is handled by `mcp__minsky__session_update`.",
  },
  {
    match: (args) => args[0] === "stash",
    reason: "Use `mcp__minsky__session_exec(task, 'git stash')` if targeting a session.",
  },
];

export const ghDenials: DenialRule[] = [
  {
    match: (args) => args[0] === "pr" && args[1] === "create",
    reason: "Use `mcp__minsky__session_pr_create` instead of `gh pr create`.",
  },
  {
    match: (args) => args[0] === "pr" && args[1] === "list",
    reason: "Use `mcp__github__list_pull_requests` instead of `gh pr list`.",
  },
  {
    match: (args) => args[0] === "pr" && (args[1] === "view" || args[1] === "get"),
    reason: 'Use `mcp__github__pull_request_read` (method: "get") instead of `gh pr view`.',
  },
  {
    match: (args) => args[0] === "pr" && args[1] === "merge",
    reason:
      "Use `mcp__minsky__session_pr_merge` or `mcp__github__merge_pull_request` instead of `gh pr merge`.",
  },
  {
    match: (args) => args[0] === "pr" && args[1] === "review",
    reason: "Use `mcp__github__pull_request_review_write` instead of `gh pr review`.",
  },
  {
    match: (args) =>
      args[0] === "issue" && (args[1] === "create" || args[1] === "list" || args[1] === "view"),
    reason: "Use `mcp__github__issue_write` / `mcp__github__issue_read` instead of `gh issue`.",
  },
];

// ---------------------------------------------------------------------------
// Parsing logic (exported for tests)
// ---------------------------------------------------------------------------

// ENV_VAR_PREFIX matches leading `FOO=bar` assignments (possibly multiple).
const ENV_VAR_RE = /^[A-Z_][A-Z0-9_]*=\S*/;

/**
 * Strip leading shell env-var assignments from a token list and return the
 * remaining tokens.
 *
 * e.g. ["FOO=bar", "BAZ=qux", "git", "status"] → ["git", "status"]
 */
export function stripEnvVarAssignments(tokens: string[]): string[] {
  let i = 0;
  while (i < tokens.length && ENV_VAR_RE.test(tokens[i])) {
    i++;
  }
  return tokens.slice(i);
}

/**
 * Split a shell command string into individual segments on `&&`, `||`, `;`,
 * and `|` (pipe). Returns non-empty trimmed segments.
 */
export function splitOnShellOperators(command: string): string[] {
  // Replace &&, ||, ;, | with a NUL sentinel, then split.
  const normalized = command
    .replace(/&&/g, "\x00")
    .replace(/\|\|/g, "\x00")
    .replace(/;/g, "\x00")
    .replace(/\|/g, "\x00");
  return normalized
    .split("\x00")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

export interface ParsedCommand {
  binary: "git" | "gh";
  args: string[]; // tokens after the binary
}

/**
 * Parse a single shell segment into a ParsedCommand if it starts with git or gh,
 * or returns null otherwise.
 */
export function parseSegment(segment: string): ParsedCommand | null {
  const tokens = segment.split(/\s+/).filter((t) => t.length > 0);
  const stripped = stripEnvVarAssignments(tokens);
  if (stripped.length === 0) return null;
  const binary = stripped[0];
  if (binary !== "git" && binary !== "gh") return null;
  return {
    binary: binary as "git" | "gh",
    args: stripped.slice(1),
  };
}

/**
 * Parse an entire command string and return all git/gh invocations found.
 */
export function parseCommands(command: string): ParsedCommand[] {
  const segments = splitOnShellOperators(command);
  const result: ParsedCommand[] = [];
  for (const seg of segments) {
    const parsed = parseSegment(seg);
    if (parsed) result.push(parsed);
  }
  return result;
}

/**
 * Check a parsed command against the denial tables.
 * Returns the denial reason string if denied, or null if allowed.
 */
export function checkDenial(parsed: ParsedCommand): string | null {
  const denials = parsed.binary === "git" ? gitDenials : ghDenials;
  for (const rule of denials) {
    if (rule.match(parsed.args)) {
      return rule.reason;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Hook entry point
// ---------------------------------------------------------------------------

const input = await readInput<ToolHookInput>();
const command = (input.tool_input.command as string) ?? "";

const parsedCommands = parseCommands(command);

for (const parsed of parsedCommands) {
  const reason = checkDenial(parsed);
  if (reason) {
    writeOutput({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: reason,
      },
    });
    process.exit(0);
  }
}

process.exit(0);
