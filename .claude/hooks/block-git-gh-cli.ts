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
  {
    // Minsky policy: the PR-merge bypass (feedback_gh_api_bypass.md) and
    // the documented workflow (docs/pr-workflow.md) BOTH require
    // merge_method=merge — we preserve merge commits for the linear-history-
    // with-meaningful-merge-commits pattern. This rule blocks `gh api` calls
    // that would squash- or rebase-merge a PR, plus calls that omit
    // merge_method entirely (ambiguous intent; GitHub's own default is
    // merge but not explicitly saying so has burned us before).
    //
    // Filed and enforced as mt#1228 after three squash-merges landed by
    // accident in one session on 2026-04-24 despite the policy being
    // cited in every bypass commit message.
    match: (args) => {
      if (args[0] !== "api") return false;
      const method = findGhApiMethod(args);
      if (method !== "PUT") return false;
      // Scan ALL tokens for a PR-merge endpoint (bypass-proof vs quote-
      // splitting of preceding -f values). See findGhApiPrMergeEndpointToken.
      const endpoint = findGhApiPrMergeEndpointToken(args);
      if (endpoint === null) return false;
      const mergeMethod = findGhApiField(args, "merge_method");
      // Block when absent OR anything other than "merge".
      return mergeMethod !== "merge";
    },
    reason:
      "`gh api PUT .../pulls/N/merge` must use `-f merge_method=merge`. Minsky preserves " +
      "merge commits for clean linear history — see docs/pr-workflow.md §Merge method policy. " +
      "Squash-merges erase PR-branch history and invalidate review-evidence links. " +
      "If you truly need the bypass, retry with `-f merge_method=merge`.",
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

// ---------------------------------------------------------------------------
// gh api argument helpers
// ---------------------------------------------------------------------------

/**
 * Flags that consume a separate value token on `gh api` (e.g., `-X PUT`, `-H "Accept: ..."`).
 * Used by findGhApiEndpoint to skip flag-value pairs when scanning for the first positional.
 */
const GH_API_VALUE_FLAGS = new Set([
  "-X",
  "--method",
  "-H",
  "--header",
  "-f",
  "--raw-field",
  "-F",
  "--field",
  "--input",
  "-q",
  "--jq",
  "-t",
  "--template",
  "--hostname",
  "--cache",
]);

/**
 * Strip a single surrounding matched pair of single- or double-quotes from a
 * token. Needed because the upstream tokenizer is intentionally not quote-
 * aware (see splitOnShellOperators), so tokens like `"merge_method=merge"`
 * arrive with the quotes still on them.
 */
export function stripSurroundingQuotes(token: string): string {
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
 * Extract the HTTP method from `gh api` args. Defaults to "GET" when neither
 * -X nor --method is supplied. Expects `args` to start with the sub-command
 * ("api"); scans the rest for the flag.
 *
 * Handles all four method-flag shapes gh/Cobra accept:
 *   -X PUT           (separate tokens)
 *   --method PUT     (separate tokens, long form)
 *   -XPUT            (combined short form)
 *   --method=PUT     (equals form)
 *
 * Returns the method uppercased so comparisons are case-insensitive (gh
 * accepts `-X put`; the old case-sensitive comparison was a bypass vector).
 */
export function findGhApiMethod(args: string[]): string {
  for (let i = 1; i < args.length; i++) {
    const arg = args[i];
    // Separate-tokens form: -X VALUE / --method VALUE
    if (arg === "-X" || arg === "--method") {
      return (args[i + 1] ?? "GET").toUpperCase();
    }
    // Equals form: --method=VALUE
    if (arg.startsWith("--method=")) {
      return arg.slice("--method=".length).toUpperCase();
    }
    // Combined short form: -XVALUE (e.g., -XPUT)
    if (arg.startsWith("-X") && arg.length > 2) {
      return arg.slice(2).toUpperCase();
    }
  }
  return "GET";
}

/**
 * Extract the endpoint path from `gh api` args — the first positional argument
 * after flag/value pairs are stripped. Returns the unquoted token, or null if
 * no positional is found.
 *
 * NOTE: This is a first-positional extractor for general use. The PR-merge
 * denial rule does NOT rely on it for enforcement (see
 * findGhApiPrMergeEndpointToken) because quote-splitting by the upstream
 * tokenizer can pull the positional out of alignment. This helper is retained
 * for cases where identifying the first positional in a well-formed
 * invocation is useful.
 */
export function findGhApiEndpoint(args: string[]): string | null {
  let i = 1; // skip "api"
  while (i < args.length) {
    const arg = args[i];
    if (arg.startsWith("-")) {
      // Value-taking flag with separate value token: -f merge_method=merge
      if (GH_API_VALUE_FLAGS.has(arg)) {
        i += 2;
        continue;
      }
      // Equals-form flag (e.g., --method=PUT): single token, no separate value.
      i += 1;
      continue;
    }
    return stripSurroundingQuotes(arg);
  }
  return null;
}

/**
 * Extract the value of a named `-f KEY=VALUE` / `--field KEY=VALUE` /
 * `--raw-field KEY=VALUE` from `gh api` args. Returns null if the field is
 * not present.
 *
 * Tokens are quote-stripped before matching, so `-f "merge_method=merge"`
 * (where the upstream tokenizer kept the quotes on the token) is still
 * recognized. Without this, a perfectly valid quoted invocation would be
 * treated as if `merge_method` were absent and over-blocked.
 */
export function findGhApiField(args: string[], key: string): string | null {
  const prefix = `${key}=`;
  for (const arg of args) {
    const stripped = stripSurroundingQuotes(arg);
    if (stripped.startsWith(prefix)) {
      return stripped.slice(prefix.length);
    }
  }
  return null;
}

/**
 * Matches `repos/OWNER/REPO/pulls/N/merge` — the PR merge endpoint. Does NOT
 * match `/merges`, `/merge-upstream`, or any sub-resource.
 */
const PR_MERGE_ENDPOINT_RE = /(^|\/)pulls\/\d+\/merge$/;

/**
 * Scan ALL tokens for one that matches the PR-merge endpoint pattern (after
 * unquoting). Returns the matched token (unquoted) or null.
 *
 * This is deliberately broader than findGhApiEndpoint: the policy question
 * ("does this command target a PR-merge endpoint?") does not require
 * perfectly locating which token is the positional. A quoted -f value like
 * `-f commit_title="My PR"` can confuse positional extraction because the
 * upstream tokenizer is not quote-aware and splits `"My PR"` into multiple
 * tokens — but the actual endpoint token is still present somewhere in the
 * arg list, and scanning all tokens finds it.
 *
 * Exported for tests.
 */
export function findGhApiPrMergeEndpointToken(args: string[]): string | null {
  for (const arg of args) {
    const stripped = stripSurroundingQuotes(arg);
    if (PR_MERGE_ENDPOINT_RE.test(stripped)) {
      return stripped;
    }
  }
  return null;
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
