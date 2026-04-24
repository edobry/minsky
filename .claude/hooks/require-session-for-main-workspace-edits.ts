#!/usr/bin/env bun
// PreToolUse hook: block Edit/Write/NotebookEdit on main-workspace files.
//
// Rationale: all code edits must happen in a session workspace via the Minsky
// session_edit_file / session_write_file MCP tools. Direct tool use against
// the main workspace bypasses session provenance, commit hooks tied to tasks,
// and the session-based PR workflow. mt#1099 smoke testing surfaced this
// pattern: urgency-override led to main-workspace Edit calls that had to be
// reverted and redone through a session.
//
// This hook enforces the rule structurally by denying Edit/Write/NotebookEdit
// whose `file_path` resolves inside the main workspace and outside any session
// workspace.
//
// @see mt#1103 — structural fix for main-workspace edit violations

import { readInput, writeOutput } from "./types";
import type { ToolHookInput } from "./types";

// ---------------------------------------------------------------------------
// Policy (exported for tests)
// ---------------------------------------------------------------------------

export const MAIN_WORKSPACE = "/Users/edobry/Projects/minsky";
export const SESSION_WORKSPACE_ROOT = "/Users/edobry/.local/state/minsky/sessions";
export const FILE_EDITING_TOOLS = new Set(["Edit", "Write", "NotebookEdit"]);

export interface DenialDecision {
  denied: boolean;
  reason?: string;
}

/**
 * Decide whether a tool call targeting `filePath` should be denied as a
 * main-workspace edit. Absolute paths only (Edit/Write enforce this).
 */
export function checkFilePathDenial(
  toolName: string,
  filePath: string | undefined
): DenialDecision {
  if (!FILE_EDITING_TOOLS.has(toolName)) return { denied: false };
  if (!filePath) return { denied: false };
  if (!filePath.startsWith("/")) return { denied: false };

  // Session workspaces live under SESSION_WORKSPACE_ROOT. Allow anything there.
  if (filePath.startsWith(`${SESSION_WORKSPACE_ROOT}/`)) return { denied: false };

  // Main workspace edits are denied.
  if (filePath === MAIN_WORKSPACE || filePath.startsWith(`${MAIN_WORKSPACE}/`)) {
    return {
      denied: true,
      reason:
        `Main workspace edit blocked: ${filePath}\n\n` +
        `All code edits must happen in a session workspace. Use:\n` +
        `  mcp__minsky__session_edit_file(sessionId, path, ...)\n` +
        `  mcp__minsky__session_write_file(sessionId, path, ...)\n\n` +
        `If no session is active yet: mcp__minsky__session_start({ task: "mt#<N>" }).\n\n` +
        `Background: the urgency-override pattern (edit now, commit later) bypasses ` +
        `session provenance, task-linked commits, and the session PR workflow. mt#1099 ` +
        `smoke testing surfaced this; mt#1103 enforces it structurally. ` +
        `See also feedback_hooks_enforcement.`,
    };
  }

  return { denied: false };
}

// ---------------------------------------------------------------------------
// Hook entry point
// ---------------------------------------------------------------------------

if (import.meta.main) {
  const input = await readInput<ToolHookInput>();
  const filePath = input.tool_input.file_path as string | undefined;
  const decision = checkFilePathDenial(input.tool_name, filePath);

  if (decision.denied) {
    writeOutput({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: decision.reason,
      },
    });
  }

  process.exit(0);
}
