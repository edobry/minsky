#!/usr/bin/env bun
// PreToolUse hook: block git/gh CLI commands when a purpose-built MCP tool exists.
//
// Rationale: Minsky provides MCP tools for all common git/gh operations.
// Using raw CLI bypasses session resolution, auto-push, and audit trails.
// This hook intercepts both `Bash` AND `mcp__minsky__session_exec` tool calls
// (both accept a `command` parameter) and denies known-equivalent operations.
//
// Three rules (`git status`, `git stash`, `git reset`) have denial messages
// that explicitly redirect to `session_exec` as the allowed path. Those rules
// are tagged `allowedInSessionExec: true` and skipped when the invocation is
// already via session_exec — otherwise the hook would contradict its own
// guidance.
//
// `git -C` is NOT carved out: the -C rule previously had allowedInSessionExec,
// but minsky-reviewer (mt#1196 review 4167154239) correctly identified that
// the carve-out was a bypass. Because the -C rule matches args[0] === "-C"
// and subsequent rules all check args[0] for a subcommand, a skipped -C rule
// let `git -C /anywhere commit|push|merge` slip through untouched. Also,
// allowing -C on session_exec would let callers scope operations outside the
// session root, violating session isolation. Denied unconditionally.
//
// @see mt#1196 — extending this hook to cover session_exec after PR #717
// retrospective surfaced the loophole.

import { readInput, writeOutput } from "./types";
import type { ToolHookInput } from "./types";

// ---------------------------------------------------------------------------
// Tool context
// ---------------------------------------------------------------------------

export type HookTool = "bash" | "session_exec";

export const SESSION_EXEC_TOOL_NAME = "mcp__minsky__session_exec";

/** Derive a HookTool tag from the raw `tool_name` field. */
export function toolContextFromName(toolName: string): HookTool {
  return toolName === SESSION_EXEC_TOOL_NAME ? "session_exec" : "bash";
}

// ---------------------------------------------------------------------------
// Denial table types
// ---------------------------------------------------------------------------

export interface DenialRule {
  match: (args: string[]) => boolean;
  reason: string;
  /**
   * When true, this rule is SKIPPED when the invocation comes via
   * `mcp__minsky__session_exec`. Used for rules whose reason explicitly
   * redirects to session_exec — applying them on session_exec itself would
   * be self-contradictory.
   */
  allowedInSessionExec?: boolean;
}

// ---------------------------------------------------------------------------
// Denial tables
// ---------------------------------------------------------------------------

export const gitDenials: DenialRule[] = [
  // git -C <path> <anything> — always denied on both Bash and session_exec.
  // - On Bash: redirect to session_exec (which sets cwd automatically).
  // - On session_exec: -C is redundant (cwd is the session root) AND dangerous.
  //   Dangerous because: before the mt#1196 review fix, -C was carved out on
  //   session_exec via allowedInSessionExec. That match()-skip fired first
  //   (args[0] === "-C"); subsequent rules all check args[0] for a subcommand,
  //   so `git -C /anywhere commit` (push/merge/rebase/…) would slip through
  //   untouched — a bigger loophole than the one the carve-out was meant to
  //   preserve. Also: -C lets callers scope operations outside the session
  //   root, violating session isolation. Denying unconditionally closes both.
  {
    match: (args) => args[0] === "-C",
    reason:
      "`git -C` is not allowed. On Bash, use `mcp__minsky__session_exec(task, command)`. Inside session_exec, omit `-C` — the session cwd is already set. Session isolation: `-C` could point git at paths outside the session root.",
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
    // On session_exec itself, `git status` is the recommended path — don't block.
    allowedInSessionExec: true,
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
    match: (args) => args[0] === "reset",
    reason:
      "Use `mcp__minsky__session_exec(task, 'git reset ...')` if you genuinely need a reset in a session. This is a destructive operation — consider the revert alternative first.",
    // On session_exec itself, `git reset` is the recommended escape hatch — don't block.
    allowedInSessionExec: true,
  },
  {
    match: (args) => args[0] === "stash",
    reason:
      "No first-class MCP equivalent. If you need to stash in a session, use `mcp__minsky__session_exec(task, 'git stash')` — the call runs server-side and is not blocked by this hook.",
    // On session_exec itself, `git stash` is the recommended escape hatch — don't block.
    allowedInSessionExec: true,
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
    reason:
      "Use `mcp__minsky__session_pr_review_submit` instead of `gh pr review`. (The previous redirect pointed at `mcp__github__pull_request_review_write`, which is now banned by mt#1030.)",
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
 *
 * KNOWN LIMITATION: This splitter is NOT shell-quote-aware. Operators inside
 * quoted strings (e.g., `git commit -m "a | b"`) will cause incorrect splits.
 * This hook is designed to catch obvious agent mistakes (`git push`, `git -C ...`),
 * not to be a security boundary. The worst case is an edge-case message string
 * that happens to contain an operator AND a substring resembling an allowed
 * subcommand — the actual command may slip through. Fixing this correctly
 * requires a proper shell lexer; accepted as a pragmatic tradeoff.
 *
 * Subshell invocations like `TAG=$(git log -1)` are also not parsed; the outer
 * command is checked but the inner `git log` is not. Same tradeoff.
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
 * Check a parsed command against the denial tables, taking the invoking tool
 * context into account. Rules tagged `allowedInSessionExec` are skipped when
 * `context === "session_exec"` — their reasons redirect to session_exec, so
 * applying them on session_exec itself would be self-contradictory.
 *
 * Returns the denial reason string if denied, or null if allowed.
 */
export function checkDenial(parsed: ParsedCommand, context: HookTool = "bash"): string | null {
  const denials = parsed.binary === "git" ? gitDenials : ghDenials;
  for (const rule of denials) {
    if (context === "session_exec" && rule.allowedInSessionExec) continue;
    if (rule.match(parsed.args)) {
      return rule.reason;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Hook entry point
// ---------------------------------------------------------------------------

if (import.meta.main) {
  const input = await readInput<ToolHookInput>();
  const command = (input.tool_input.command as string) ?? "";
  const context = toolContextFromName(input.tool_name);

  const parsedCommands = parseCommands(command);

  for (const parsed of parsedCommands) {
    const reason = checkDenial(parsed, context);
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
}
