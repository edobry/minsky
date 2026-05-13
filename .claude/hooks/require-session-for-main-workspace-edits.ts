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
// Carve-out (mt#1806): if the target file currently contains git conflict
// markers (<<<<<<< / ======= / >>>>>>>), the edit is stripping those markers
// as part of conflict resolution, not new code work. In that case the edit
// is permitted with a stderr audit line.
//
// @see mt#1103 — structural fix for main-workspace edit violations
// @see mt#1806 — conflict-resolution carve-out

import { readFileSync } from "fs";
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

/** Production file-reader used by checkFilePathDenial. */
export function defaultReadFile(filePath: string): string {
  return readFileSync(filePath, "utf-8");
}

/**
 * Return true if the file content currently contains git conflict markers,
 * indicating a stash-pop or merge conflict that the agent is resolving.
 * Requires all three marker forms to be present.
 *
 * This is a pure string check — callers pass the file content.
 * Fail-closed: exceptions from the upstream readFile call should be handled
 * by the caller.
 */
export function contentHasConflictMarkers(content: string): boolean {
  return (
    content.includes("<<<<<<< ") && content.includes("=======") && content.includes(">>>>>>> ")
  );
}

/**
 * Decide whether a tool call targeting `filePath` should be denied as a
 * main-workspace edit. Absolute paths only (Edit/Write enforce this).
 *
 * @param readFile Injectable file reader for testing (defaults to readFileSync).
 *   Must throw when the file doesn't exist so the carve-out fails closed.
 */
export function checkFilePathDenial(
  toolName: string,
  filePath: string | undefined,
  readFile: (path: string) => string = defaultReadFile
): DenialDecision {
  if (!FILE_EDITING_TOOLS.has(toolName)) return { denied: false };
  if (!filePath) return { denied: false };
  if (!filePath.startsWith("/")) return { denied: false };

  // Session workspaces live under SESSION_WORKSPACE_ROOT. Allow anything there.
  if (filePath.startsWith(`${SESSION_WORKSPACE_ROOT}/`)) return { denied: false };

  // Main workspace edits are denied — unless the file contains conflict markers,
  // in which case the edit is conflict resolution (stripping <<<<<<</=======/>>>>>>>
  // lines), not new code work. Permit with a stderr audit line.
  if (filePath === MAIN_WORKSPACE || filePath.startsWith(`${MAIN_WORKSPACE}/`)) {
    // Attempt to read the file; fail closed on any error (file missing, permission, etc.)
    let hasMarkers = false;
    try {
      hasMarkers = contentHasConflictMarkers(readFile(filePath));
    } catch {
      // File unreadable or doesn't exist — treat as no conflict markers (deny).
      hasMarkers = false;
    }
    if (hasMarkers) {
      process.stderr.write(`[require-session] conflict-resolution carve-out: ${filePath}\n`);
      return { denied: false };
    }
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
