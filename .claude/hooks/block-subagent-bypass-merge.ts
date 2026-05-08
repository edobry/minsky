#!/usr/bin/env bun
// PreToolUse hook: block subagent invocations of `gh api PUT /repos/.../pulls/.../merge`.
//
// ## Detection signal
//
// The `agent_id` field in `ToolHookInput` is set by the Claude Code harness whenever
// this hook runs inside a subagent (spawned via the `Agent` tool). When the main agent
// invokes Bash or session_exec, `agent_id` is null/undefined. This is the most reliable
// structural signal available:
//
//   - It does NOT require reading the prompt at runtime (the `<!-- minsky:prompt:v1 -->`
//     watermark approach would require stdin access at a different lifecycle point).
//   - It does NOT require a harness env var (no `CLAUDE_AGENT_MODE` exists in the harness).
//   - It IS a field in the official `ClaudeHookInput` / `ToolHookInput` shape already
//     exported from `./types.ts`.
//
// Chosen over env var and prompt inspection because it is harness-native, typed,
// and does not depend on the agent honoring a convention.
//
// ## Scope
//
// Matches on `Bash` AND `mcp__minsky__session_exec` — same surface as `block-git-gh-cli.ts`
// per CLAUDE.md "§session_exec is not a git/gh escape hatch" (mt#1196).
//
// Only blocks `gh api -X PUT .../pulls/.../merge` (the raw REST bypass). Other `gh api`
// calls (GETs, PATCH refs, etc.) are allowed through — this hook has a single narrow
// concern: the merge bypass.
//
// The existing `block-git-gh-cli.ts` already enforces `merge_method=merge` on the same
// endpoint; this hook adds the orthogonal agent-context restriction. Both hooks run and
// both denials are possible — the context denial fires first (order of hooks in matcher).
//
// ## Override
//
// No programmatic override is provided. The bypass-merge escape valve belongs to the
// main agent only, per CLAUDE.md §Verification surfaces. If the main agent needs to
// invoke `gh api PUT /merge`, it runs without an `agent_id` and this hook allows it.
//
// @see mt#1671 — tracking task
// @see feedback_self_authored_pr_merge_constraints — when bypass is warranted
// @see CLAUDE.md §Hook Files §Subagent bypass-merge guard
// @see block-git-gh-cli.ts — sibling hook (enforces merge_method; complementary, not redundant)

import { readInput, writeOutput } from "./types";
import type { ToolHookInput } from "./types";

// ---------------------------------------------------------------------------
// Subagent context detection
// ---------------------------------------------------------------------------

/**
 * Returns true when the hook is running inside a subagent (Agent tool dispatch).
 *
 * The `agent_id` field is set by the Claude Code harness on every subagent
 * invocation. It is null/undefined when the main agent invokes the tool.
 */
export function isSubagentContext(input: ToolHookInput): boolean {
  return typeof input.agent_id === "string" && input.agent_id.length > 0;
}

// ---------------------------------------------------------------------------
// Command parsing — gh api PUT /merge detection
// ---------------------------------------------------------------------------

/**
 * Matches the PR merge endpoint pattern. Two forms are accepted:
 *
 * Form A: full path  — `repos/OWNER/REPO/pulls/N/merge` (absolute or relative)
 * Form B: tail only  — `.../pulls/N/merge` (env-var URL substitution where the
 *         base URL is in a shell variable like `$REPO_BASE`; the literal tail
 *         `/pulls/N/merge` is still visible in the unexpanded token)
 *
 * Does NOT match /merges, /merge-upstream, or any sub-resource.
 */
const PR_MERGE_ENDPOINT_RE = /\/pulls\/\d+\/merge$/;

/**
 * Scan a token list for the gh api method (-X PUT, --method PUT, -XPUT, --method=PUT).
 * Returns the uppercased method string, or "GET" if not found.
 */
function findGhApiMethod(args: string[]): string {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "-X" || arg === "--method") {
      return (args[i + 1] ?? "GET").toUpperCase();
    }
    if (arg.startsWith("--method=")) {
      return arg.slice("--method=".length).toUpperCase();
    }
    if (arg.startsWith("-X") && arg.length > 2) {
      return arg.slice(2).toUpperCase();
    }
  }
  return "GET";
}

/**
 * Strip a single surrounding matched pair of quotes from a token.
 */
function stripSurroundingQuotes(token: string): string {
  if (token.length >= 2) {
    const first = token[0];
    const last = token[token.length - 1];
    if ((first === '"' || first === "'") && first === last) {
      return token.slice(1, -1);
    }
  }
  return token;
}

/**
 * Scan ALL tokens in `args` for one that matches the PR-merge endpoint pattern.
 * Returns the unquoted matched token, or null if not found.
 *
 * Scanning all tokens (rather than extracting just the first positional) is
 * deliberately broad — the upstream tokenizer is not quote-aware, so a
 * quoted -f value can confuse positional extraction. The actual endpoint token
 * is always present somewhere in the arg list.
 */
function findPrMergeEndpointToken(args: string[]): string | null {
  for (const arg of args) {
    const stripped = stripSurroundingQuotes(arg);
    if (PR_MERGE_ENDPOINT_RE.test(stripped)) {
      return stripped;
    }
  }
  return null;
}

/**
 * Split a shell command on common shell operators (`&&`, `||`, `;`, `|`) and return
 * non-empty trimmed segments.
 *
 * KNOWN LIMITATION: not shell-quote-aware. Operators inside quoted strings will
 * produce incorrect splits. This is a pragmatic tradeoff — the hook is designed
 * to catch obvious agent bypasses, not serve as a security boundary.
 */
function splitOnShellOperators(command: string): string[] {
  return command
    .replace(/&&/g, "\x00")
    .replace(/\|\|/g, "\x00")
    .replace(/;/g, "\x00")
    .replace(/\|/g, "\x00")
    .split("\x00")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * Strip leading `NAME=value` env-var assignments from a token list.
 */
const ENV_VAR_RE = /^[A-Z_][A-Z0-9_]*=\S*/;
function stripEnvVarAssignments(tokens: string[]): string[] {
  let i = 0;
  while (i < tokens.length && ENV_VAR_RE.test(tokens[i] ?? "")) {
    i++;
  }
  return tokens.slice(i);
}

/**
 * True when the shell segment is a `gh api PUT .../pulls/.../merge` invocation.
 *
 * Matches:
 *   gh api -X PUT /repos/owner/repo/pulls/123/merge
 *   gh api --method PUT repos/owner/repo/pulls/123/merge
 *   gh api -XPUT /repos/owner/repo/pulls/123/merge
 *   gh api -X PUT /repos/owner/repo/pulls/123/merge -f merge_method=merge
 *   URL_BASE=... gh api -X PUT "$URL_BASE/pulls/123/merge"  (env-var URL)
 *
 * NOTE: env-var URL substitution is detected only when the unresolved token
 * still contains `pulls/<N>/merge` literally. A fully-resolved URL (where
 * the shell expands the var before exec) cannot be detected at parse time —
 * this is an accepted limitation (structural signal-level check, not a
 * full runtime execution trace).
 */
export function isGhApiPutMerge(segment: string): boolean {
  const tokens = segment.split(/\s+/).filter((t) => t.length > 0);
  const stripped = stripEnvVarAssignments(tokens);

  // Must start with `gh`
  if (stripped[0] !== "gh") return false;
  // Must have `api` as the first arg
  if (stripped[1] !== "api") return false;

  const args = stripped.slice(1); // "api" onward
  // Must be a PUT (any casing)
  if (findGhApiMethod(args) !== "PUT") return false;
  // Must target a PR-merge endpoint
  if (findPrMergeEndpointToken(args) === null) return false;

  return true;
}

/**
 * Check an entire command string (possibly chained with &&, ;, |, etc.)
 * for any `gh api PUT .../merge` segment.
 *
 * Returns the first matching segment string, or null if none.
 */
export function findGhApiPutMergeSegment(command: string): string | null {
  const segments = splitOnShellOperators(command);
  for (const seg of segments) {
    if (isGhApiPutMerge(seg)) return seg;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Denial message
// ---------------------------------------------------------------------------

const DENIAL_MESSAGE =
  "Subagents cannot bypass-merge PRs via `gh api PUT /merge`. " +
  "Merge handling is the main agent's responsibility per CLAUDE.md " +
  "`## Verification surfaces`. " +
  "Report the PR URL + bot status to the parent and exit. " +
  "If you believe the bypass is warranted, surface to the user with the conditions per " +
  "`feedback_self_authored_pr_merge_constraints` " +
  "(R≥1 substantive review rounds + reviewer convergence failure).";

// ---------------------------------------------------------------------------
// Hook entry point
// ---------------------------------------------------------------------------

if (import.meta.main) {
  const input = await readInput<ToolHookInput>();

  // Only act on Bash and session_exec — the two surfaces that accept a `command` string
  if (input.tool_name !== "Bash" && input.tool_name !== "mcp__minsky__session_exec") {
    process.exit(0);
  }

  // Allow main-agent invocations — only restrict subagents
  if (!isSubagentContext(input)) {
    process.exit(0);
  }

  const command = (input.tool_input.command as string | undefined) ?? "";

  const matchingSegment = findGhApiPutMergeSegment(command);
  if (matchingSegment === null) {
    // No PR-merge bypass detected — allow
    process.exit(0);
  }

  writeOutput({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: DENIAL_MESSAGE,
    },
  });
  process.exit(0);
}
