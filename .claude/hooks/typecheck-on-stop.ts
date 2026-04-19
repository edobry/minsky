#!/usr/bin/env bun
// Stop AND SubagentStop hook: full type check on all project roots edited during this turn.
//
// This is the correctness/truthfulness gate — Claude cannot stop with
// type errors. Exit 2 forces Claude to continue and fix the errors.
//
// Consolidates: typecheck-on-stop.sh, typecheck-on-subagent-stop.sh, typecheck-tracked-roots.sh

import { existsSync, readFileSync, unlinkSync } from "fs";
import { readInput, execSync } from "./types";
import type { StopHookInput } from "./types";

const input = await readInput<StopHookInput>();

const sessionId = input.session_id ?? "default";
const agentId = input.agent_id;
// Determine state file: keyed by session_id and (if subagent) agent_id
const stateFile = agentId
  ? `/tmp/claude-typecheck-roots-${sessionId}-${agentId}.txt`
  : `/tmp/claude-typecheck-roots-${sessionId}-main.txt`;

// Collect unique project roots from state file
let roots: string[] = [];
if (existsSync(stateFile)) {
  const content = readFileSync(stateFile, "utf-8");
  const lines = content.split("\n").filter(Boolean);
  roots = [...new Set(lines)];
}

// Fallback: if no tracked roots, use cwd or CLAUDE_PROJECT_DIR
if (roots.length === 0) {
  const fallback = input.cwd || process.env.CLAUDE_PROJECT_DIR;
  if (fallback) roots = [fallback];
}

// Check each root
let allErrors = "";
let totalCount = 0;
const failedRoots: string[] = [];

for (const root of roots) {
  if (!existsSync(root)) continue;
  if (!existsSync(`${root}/tsconfig.json`)) continue;

  // Run full tsc (NO --incremental — correctness gate)
  const result = execSync(["bunx", "tsc"], { cwd: root });
  if (result.exitCode !== 0) {
    const output = result.stdout || result.stderr;
    const count = output.split("\n").filter((line) => line.includes("): error TS")).length;
    totalCount += count;
    failedRoots.push(root);
    allErrors = allErrors
      ? `${allErrors}\n\n=== ${root} ===\n${output}`
      : `=== ${root} ===\n${output}`;
  }
}

if (failedRoots.length > 0) {
  const preview = allErrors.split("\n").slice(0, 60).join("\n");
  // Stop hooks use decision/reason schema, NOT hookSpecificOutput
  const output = {
    decision: "block",
    reason: `TypeScript errors must be fixed before completing:\n${preview}\n\nTotal: ${totalCount} error(s). Fix all type errors before returning.`,
  };
  process.stdout.write(JSON.stringify(output));
  process.exit(2);
}

// All checks passed — clean up state file
if (existsSync(stateFile)) {
  unlinkSync(stateFile);
}
process.exit(0);
