#!/usr/bin/env bun
// PreToolUse hook: block GitHub MCP PR-write tools in favor of their Minsky equivalents.
//
// Rationale: Minsky provides MCP tools for all identity-bearing PR write operations
// that route through TokenProvider, record provenance, and apply tier-aware routing.
// Using the GitHub MCP server's write tools bypasses all of this and produces the
// silent identity drift documented in mt#1030. This hook intercepts the GitHub
// write tool calls and denies them with a pointer to the Minsky equivalent.
//
// @see mt#1030 — ban GitHub MCP PR-write tools
// @see Position: Identity, Signing, and Provenance in the Agentic Engineering Age

import { readInput, writeOutput } from "./types";
import type { ToolHookInput } from "./types";

// ---------------------------------------------------------------------------
// Denial table
// ---------------------------------------------------------------------------

export interface ToolDenialRule {
  toolName: string;
  reason: string;
}

export const toolDenials: ToolDenialRule[] = [
  {
    toolName: "mcp__github__create_pull_request",
    reason:
      "Use `mcp__minsky__session_pr_create` instead. The Minsky tool routes through TokenProvider (bot identity), records provenance, and applies authorship labels. Using the GitHub MCP tool bypasses all of this. See mt#1030.",
  },
  {
    toolName: "mcp__github__update_pull_request",
    reason:
      "Use `mcp__minsky__session_pr_edit` instead. The Minsky tool routes through TokenProvider and keeps provenance state consistent. See mt#1030.",
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

// ---------------------------------------------------------------------------
// Lookup (exported for tests)
// ---------------------------------------------------------------------------

export function checkToolDenial(toolName: string): string | null {
  const rule = toolDenials.find((r) => r.toolName === toolName);
  return rule ? rule.reason : null;
}

// ---------------------------------------------------------------------------
// Hook entry point
// ---------------------------------------------------------------------------

// Only invoke the hook body when run as a script, not when imported by tests.
if (import.meta.main) {
  const input = await readInput<ToolHookInput>();
  const reason = checkToolDenial(input.tool_name);

  if (reason) {
    writeOutput({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: reason,
      },
    });
  }

  process.exit(0);
}
