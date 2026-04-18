#!/usr/bin/env bun
// PostToolUse hook: INFORMATIONAL type checking after editing TypeScript files
//
// Two responsibilities:
//   1. Track which project root was edited (state file for Stop/SubagentStop hooks)
//   2. Run incremental tsc in that root, show smart-filtered errors as context
//
// Does NOT block — Stop/SubagentStop hooks enforce correctness at turn end.

import os from "os";
import { appendFileSync } from "fs";
import { readInput, writeOutput, execSync } from "./types";
import type { ToolHookInput } from "./types";

const input = await readInput<ToolHookInput>();

const filePath =
  (input.tool_input.file_path as string | undefined) ??
  (input.tool_input.path as string | undefined) ??
  (input.tool_result?.filePath as string | undefined) ??
  "";

const sessionId = input.session_id ?? "default";
const agentId = input.agent_id;

// Only run for TypeScript files
if (!/\.tsx?$/.test(filePath)) {
  process.exit(0);
}

// Determine the right project root to run tsc from.
// If the file is in a Minsky session dir, use that session's root.
// Otherwise, use the main project dir.
const sessionsDir = `${os.homedir()}/.local/state/minsky/sessions/`;
let projectRoot: string;
if (filePath.startsWith(sessionsDir)) {
  // Extract everything up to and including the UUID directory
  const afterSessions = filePath.slice(sessionsDir.length);
  const uuid = afterSessions.split("/")[0];
  projectRoot = `${sessionsDir}${uuid}`;
} else {
  projectRoot = process.env.CLAUDE_PROJECT_DIR ?? ".";
}

// Track this project root for Stop/SubagentStop to find later.
// State file is keyed by session_id and (if subagent) agent_id.
const stateFile = agentId
  ? `/tmp/claude-typecheck-roots-${sessionId}-${agentId}.txt`
  : `/tmp/claude-typecheck-roots-${sessionId}-main.txt`;

appendFileSync(stateFile, `${projectRoot}\n`);

// Run tsc with --incremental for fast feedback
const result = execSync(["bunx", "tsc", "--incremental"], { cwd: projectRoot });

if (result.exitCode !== 0) {
  const output = result.stdout || result.stderr;
  // Compute relative path from project root for matching tsc output
  const relPath = filePath.startsWith(`${projectRoot}/`)
    ? filePath.slice(projectRoot.length + 1)
    : filePath;

  // Filter: errors in the edited file vs cascade errors in other files
  const allLines = output.split("\n");
  const fileErrors = allLines.filter((line) => line.startsWith(`${relPath}(`));
  const totalErrorCount = allLines.filter((line) => line.includes("): error TS")).length;

  if (fileErrors.length > 0) {
    const fileErrorCount = fileErrors.length;
    const cascadeCount = totalErrorCount - fileErrorCount;
    const fileErrorsPreview = fileErrors.slice(0, 10).join("\n");

    if (cascadeCount > 0) {
      writeOutput({
        hookSpecificOutput: {
          hookEventName: "PostToolUse",
          additionalContext: `TypeScript errors in edited file:\n${fileErrorsPreview}\n(+ ${cascadeCount} cascade error(s) in other files)`,
        },
      });
    } else {
      writeOutput({
        hookSpecificOutput: {
          hookEventName: "PostToolUse",
          additionalContext: `TypeScript errors in edited file:\n${fileErrorsPreview}`,
        },
      });
    }
  } else {
    // Only cascade errors in other files — just summarize
    writeOutput({
      hookSpecificOutput: {
        hookEventName: "PostToolUse",
        additionalContext: `TypeScript: ${totalErrorCount} error(s) in other files (cascade from ongoing edits, checked at turn end)`,
      },
    });
  }
}

// Always exit 0 — informational only.
process.exit(0);
