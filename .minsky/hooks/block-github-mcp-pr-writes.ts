#!/usr/bin/env bun
// PreToolUse hook: block GitHub MCP PR-write tools in favor of their Minsky equivalents.
//
// Rationale: Minsky provides MCP tools for all identity-bearing PR write operations
// that route through TokenProvider, record provenance, and apply tier-aware routing.
// Using the GitHub MCP server's write tools bypasses all of this and produces the
// silent identity drift documented in mt#1030. This hook intercepts the GitHub
// write tool calls and denies them with a pointer to the Minsky equivalent.
//
// The decision lives in `packages/domain/src/detectors/github-mcp-pr-write-denial.ts`
// (mt#4374's first extraction wave). This file is the thin binding: parse the
// payload, call the decision, relay the verdict.
//
// @see mt#1030 — ban GitHub MCP PR-write tools
// @see mt#4374 — the extraction wave that moved the decision out
// @see Position: Identity, Signing, and Provenance in the Agentic Engineering Age

import { readInput, writeOutput } from "./types";
import type { ToolHookInput } from "./types";
import { checkToolDenial } from "@minsky/domain/detectors/github-mcp-pr-write-denial";

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
