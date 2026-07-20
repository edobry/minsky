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
// Machine-agnostic derivation (mt#2928): MAIN_WORKSPACE and
// SESSION_WORKSPACE_ROOT used to be hardcoded machine- and user-specific
// absolute-path literals — correct only on the original author's own
// machine. Both are now derived at runtime; see
// deriveMainWorkspace/deriveSessionWorkspaceRoot below.
//
// @see mt#1103 — structural fix for main-workspace edit violations
// @see mt#1806 — conflict-resolution carve-out
// @see mt#2928 — machine-agnostic MAIN_WORKSPACE/SESSION_WORKSPACE_ROOT derivation

import { readFileSync } from "fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { readInput, writeOutput, findRepoRoot, DEFAULT_FS } from "./types";
import type { ToolHookInput, MergeDetectFs } from "./types";
import { recordFireLogEntry } from "./fire-log";

/** This guard's fire-log identifier (mt#2597, evaluation-loop Phase 1). */
const GUARD_NAME = "require-session-for-main-workspace-edits";

// ---------------------------------------------------------------------------
// Policy (exported for tests)
// ---------------------------------------------------------------------------

/**
 * Resolve the MAIN workspace root at runtime instead of hardcoding an
 * absolute path (mt#2928 — "Minsky beyond Minsky" portability sweep;
 * memory `ae514f10`). `.minsky/hooks/*.ts` (and its compiled mirror
 * `.claude/hooks/*.ts`) is checked into the main-workspace repo itself, so
 * walking up from THIS FILE's own directory via the shared `findRepoRoot`
 * helper (mt#2710, `.minsky/hooks/types.ts`) always lands on the real
 * main-workspace root — regardless of machine, user account, or checkout
 * location.
 *
 * Deliberately NOT `input.cwd` (the pattern every other `findRepoRoot`
 * caller uses — see `check-branch-fresh.ts`, `skill-staleness-detector.ts`,
 * etc.): those callers want "whatever repo the hook happens to be running
 * in, right now" to resolve a repo-relative STATE path. This hook instead
 * needs one fixed answer to "where is THE main workspace" so it can
 * classify an unrelated edit target — a value that must not drift with the
 * invoking process's shell cwd.
 *
 * Exported as a pure function (startDir/fs both injectable) so tests can
 * verify a repo checked out at a different absolute path resolves
 * correctly without touching the real filesystem.
 */
export function deriveMainWorkspace(
  startDir: string = import.meta.dir,
  fs: MergeDetectFs = DEFAULT_FS
): string {
  return findRepoRoot(startDir, fs);
}

/**
 * Resolve the session-workspace root at runtime: `<state-dir>/sessions`.
 * Precedence mirrors `src/cockpit/lifecycle.ts`'s `getStateDir()` (mt#1925
 * R2): the `MINSKY_STATE_DIR` env override first, else the XDG Base
 * Directory convention (`XDG_STATE_HOME`, falling back to
 * `<home>/.local/state`) plus the `minsky` namespace segment.
 * `.minsky/hooks/` stays dependency-free (no `packages/` or `src/`
 * imports, per `SPEC.md`), so this is inlined rather than importing
 * `packages/shared/src/paths.ts:getSessionsDir()` — the same inlining
 * precedent as `mcp-daemon-staleness-detector.ts`'s `getDaemonStatePath()`.
 *
 * Exported as a pure function (env/home both injectable) so tests can
 * verify a different HOME resolves the session-workspace root correctly.
 */
export function deriveSessionWorkspaceRoot(
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir()
): string {
  const stateDir = env.MINSKY_STATE_DIR
    ? env.MINSKY_STATE_DIR
    : join(env.XDG_STATE_HOME || join(env.HOME || home, ".local", "state"), "minsky");
  return join(stateDir, "sessions");
}

export const MAIN_WORKSPACE = deriveMainWorkspace();
export const SESSION_WORKSPACE_ROOT = deriveSessionWorkspaceRoot();
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
 * Standard git conflict markers are 7 chevrons (`<<<<<<<`, `=======`, `>>>>>>>`)
 * optionally followed by a description (HEAD, branch name, etc.). The check
 * uses substring matching on the 7-chevron form WITHOUT requiring a trailing
 * space — `<<<<<<< HEAD`, `<<<<<<< Updated upstream`, and the bare `<<<<<<<`
 * all match.
 *
 * This is a pure string check — callers pass the file content.
 * Fail-closed: exceptions from the upstream readFile call should be handled
 * by the caller.
 */
export function contentHasConflictMarkers(content: string): boolean {
  return content.includes("<<<<<<<") && content.includes("=======") && content.includes(">>>>>>>");
}

/**
 * Decide whether a tool call targeting `filePath` should be denied as a
 * main-workspace edit. Absolute paths only (Edit/Write enforce this).
 *
 * @param readFile Injectable file reader for testing (defaults to readFileSync).
 *   Must throw when the file doesn't exist so the carve-out fails closed.
 * @param mainWorkspace Injectable main-workspace root (mt#2928 — defaults to
 *   the runtime-derived MAIN_WORKSPACE; tests can inject a different
 *   absolute path to verify classification is not tied to this machine's
 *   checkout location).
 * @param sessionWorkspaceRoot Injectable session-workspace root (mt#2928 —
 *   defaults to the runtime-derived SESSION_WORKSPACE_ROOT; tests can
 *   inject a different absolute path to verify classification is not tied
 *   to this machine's HOME).
 */
export function checkFilePathDenial(
  toolName: string,
  filePath: string | undefined,
  readFile: (path: string) => string = defaultReadFile,
  mainWorkspace: string = MAIN_WORKSPACE,
  sessionWorkspaceRoot: string = SESSION_WORKSPACE_ROOT
): DenialDecision {
  if (!FILE_EDITING_TOOLS.has(toolName)) return { denied: false };
  if (!filePath) return { denied: false };
  if (!filePath.startsWith("/")) return { denied: false };

  // Session workspaces live under sessionWorkspaceRoot. Allow anything there.
  if (filePath.startsWith(`${sessionWorkspaceRoot}/`)) return { denied: false };

  // Main workspace edits are denied — unless the file contains conflict markers,
  // in which case the edit is conflict resolution (stripping <<<<<<</=======/>>>>>>>
  // lines), not new code work. Permit with a stderr audit line.
  if (filePath === mainWorkspace || filePath.startsWith(`${mainWorkspace}/`)) {
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
  const startMs = Date.now();
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

  // mt#2597 (evaluation-loop Phase 1): fire-log every evaluation, including
  // the common "not a file-editing tool" / "session workspace" silent-allow
  // paths — this guard has no documented override env-var, so no override
  // fields are populated.
  recordFireLogEntry({
    guardName: GUARD_NAME,
    event: "PreToolUse",
    decision: decision.denied ? "deny" : "allow",
    durationMs: Date.now() - startMs,
    toolName: input.tool_name,
    sessionId: input.session_id,
  });

  process.exit(0);
}
