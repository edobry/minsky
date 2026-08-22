/**
 * Decision: should a GitHub MCP PR-write tool call be denied in favour of its
 * Minsky equivalent? (mt#1030)
 *
 * Lifted from `.minsky/hooks/block-github-mcp-pr-writes.ts` by mt#4374's first
 * extraction wave. The hook module is now parse → call → relay; this module is
 * the verdict.
 *
 * ADR-026 tier 2: a leaf function with no dependencies, so it takes no `deps`
 * parameter — there is nothing to inject. No `process.env` read, no filesystem
 * access, no clock read.
 *
 * @see docs/architecture/adr-026-dependency-injection-convention.md — rule 2
 * @see mt#1030 — ban GitHub MCP PR-write tools
 */

export interface ToolDenialRule {
  toolName: string;
  reason: string;
}

/**
 * The denial table. Each entry names the Minsky tool that routes through
 * TokenProvider, records provenance, and applies tier-aware routing — the
 * machinery the GitHub MCP write tools bypass.
 */
export const toolDenials: ToolDenialRule[] = [
  {
    toolName: "mcp__github__create_pull_request",
    reason:
      "Use `mcp__minsky__session_pr_create` instead. The Minsky tool routes through TokenProvider (bot identity), records provenance, and applies authorship labels. Using the GitHub MCP tool bypasses all of this. See mt#1030.",
  },
  {
    toolName: "mcp__github__update_pull_request",
    reason:
      "Use `mcp__minsky__session_pr_edit` (for title / body updates) or `mcp__minsky__session_pr_close` (for state-flip to closed; mt#1955) instead. The Minsky tools route through TokenProvider and keep provenance state consistent. See mt#1030.",
  },
  {
    toolName: "mcp__github__merge_pull_request",
    reason:
      "Use `mcp__minsky__session_pr_merge` instead. The Minsky tool applies tier-aware token routing (see mt#992) and updates authorship labels at merge time. If the Minsky merge path is failing with a permission error, that is a bug in the tier-routing logic — file it rather than working around it. See mt#1030.",
  },
  {
    toolName: "mcp__github__pull_request_review_write",
    reason:
      "Use `mcp__minsky__session_pr_review_submit` instead. The Minsky tool routes through TokenProvider so the review posts under the configured bot identity (or the user identity when appropriate). Using the GitHub MCP tool always uses the user PAT, producing the identity drift that motivated mt#1030.",
  },
];

/**
 * The verdict: a denial reason for `toolName`, or `null` when the call is
 * permitted.
 */
export function checkToolDenial(toolName: string): string | null {
  const rule = toolDenials.find((r) => r.toolName === toolName);
  return rule ? rule.reason : null;
}
