#!/usr/bin/env bun
// PreToolUse hook: block tasks_status_set to DONE if the task spec has
// acceptance tests that haven't been acknowledged.
//
// When a task spec contains an "## Acceptance Tests" section with bash
// commands, this hook blocks the DONE transition and reminds the agent
// to run the acceptance tests first.
//
// This is a STRUCTURAL enforcement — it prevents the failure mode where
// umbrella tasks are marked DONE based on subtask completion without
// running the spec's own acceptance test commands against the codebase.
//
// @see retrospective: mt#811 premature completion (2026-04-19)

import { readInput, writeOutput } from "./types";
import type { ToolHookInput } from "./types";

const input = await readInput<ToolHookInput>();

// Only check when setting status to DONE
const status = input.tool_input.status as string | undefined;
if (status !== "DONE") process.exit(0);

const taskId = input.tool_input.taskId as string | undefined;
if (!taskId) process.exit(0);

// Fetch the task spec via minsky CLI
// Use full PATH to find minsky binary (hooks run in a minimal shell env)
const envPATH = `${process.env.HOME}/.bun/bin:/usr/local/bin:/usr/bin:/bin:${process.env.PATH || ""}`;
const specProc = Bun.spawnSync(["minsky", "tasks", "spec", "get", taskId, "--non-interactive"], {
  cwd: input.cwd,
  env: { ...process.env, PATH: envPATH },
  stdout: "pipe",
  stderr: "pipe",
});
const specResult = {
  exitCode: specProc.exitCode,
  stdout: specProc.stdout.toString().trim(),
  stderr: specProc.stderr.toString().trim(),
};

if (specResult.exitCode !== 0) {
  // Can't fetch spec — allow but warn
  writeOutput({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      additionalContext: `⚠️ Could not fetch spec for ${taskId} to check acceptance tests. Proceeding, but verify manually.`,
    },
  });
  process.exit(0);
}

const spec = specResult.stdout;

// Check if spec has an Acceptance Tests section
const acceptanceMatch = spec.match(/## Acceptance Tests\s*\n([\s\S]*?)(?=\n## |\n---|$)/i);

if (!acceptanceMatch) {
  // No acceptance tests section — allow
  process.exit(0);
}

const acceptanceSection = acceptanceMatch[1];

// Check if the section contains bash/shell commands (lines starting with grep, bun, etc.)
const hasCommands = /```(?:bash|sh|shell)?\n[\s\S]*?```|^\s*(?:grep|bun |npm |yarn )/m.test(
  acceptanceSection
);

if (!hasCommands) {
  // Acceptance tests exist but no executable commands — allow
  process.exit(0);
}

// Block the DONE transition — acceptance tests need to be run
writeOutput({
  hookSpecificOutput: {
    hookEventName: "PreToolUse",
    permissionDecision: "deny",
    permissionDecisionReason:
      `Task ${taskId} has acceptance tests in its spec that must be executed before marking DONE.\n\n` +
      `Run each acceptance test command from the spec's "## Acceptance Tests" section and verify they pass.\n` +
      `Then re-attempt marking DONE — include the acceptance test results in your message.`,
  },
});
