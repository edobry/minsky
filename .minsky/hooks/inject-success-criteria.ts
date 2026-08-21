#!/usr/bin/env bun
// Surface the bound task's `## Success Criteria` at PR-creation time — mt#3350.
//
// PreToolUse on `session_pr_create`. Emits the criteria verbatim into `additionalContext` so
// they are CONFRONTED at the moment of shipping rather than recalled from having written them.
//
// ## Why this surface, and what it cannot do
//
// mem#736's recorded escalation trigger names the CLASS — "changing WHERE the check fires
// (e.g. surfacing the success criteria at `session_pr_create` time rather than relying on the
// agent to re-fetch them mid-checklist)". `session_pr_create` is that memory's EXAMPLE, and it
// is the last mechanically-fired point before the PR exists, so it is what mt#3350 chose.
//
// The honest limit, recorded in the spec rather than discovered later: PreToolUse fires with
// the create call ALREADY IN FLIGHT. The injection cannot shape the body being submitted — it
// prompts a follow-up `session_pr_edit`. The merge-time cross-reference in
// `success-criteria-coverage.ts` is the backstop that makes that acceptable.
//
// ## Why prose could not do this job
//
// `/implement-task` §7 item 5 ("re-read the spec's Success Criteria; confirm the implementation
// reflects each") is the prose check for exactly this class, and it has a measured 14x
// recurrence across 13 PRs. Green typecheck/lint/test signals are mechanically invoked and
// occupy the same "verification is done" attention slot the criteria should occupy; the
// criteria, wired to no runner, lose that slot by default. This hook takes the slot back.
//
// Fail-open and silent by construction: no task id, no spec, an unparseable response, or a
// missing `## Success Criteria` section all exit 0 with no output. An injection hook that
// complains about its own inputs would be noise on every PR that legitimately has no criteria.
//
// @see mt#3350 — this task
// @see .minsky/hooks/success-criteria-coverage.ts — the merge-time half, and this file's parser
// @see mem#736 — the R2 escalation this implements
// @see docs/architecture/hooks/execution-evidence-merge-gate.md — the durable record

import { execWithPath, readInput, writeOutput } from "./types";
import type { ToolHookInput } from "./types";
import { resolveMergeGateTaskId } from "./merge-gate-task-resolution";
import { extractSuccessCriteriaSection } from "./success-criteria-coverage";

/** Budget for the spec fetch. Mirrors the AT path's 15s allowance for the same CLI call. */
const SPEC_FETCH_TIMEOUT_MS = 15000;

/**
 * Fetches the bound task's spec markdown via the `minsky` CLI.
 *
 * Shells the CLI rather than importing `packages/domain` directly. (The reason
 * recorded here was `.minsky/hooks/SPEC.md`'s self-containment invariant, retired
 * by mt#4373; the independent reason immediately below — not dragging the merge
 * gate's module graph into a hook that fires on every `session_pr_create` — is
 * the one that still holds.) The same pattern
 * `fetchTaskSpecForAtCoverage` uses in the evidence gate. Deliberately NOT imported from that
 * module: this hook runs on every `session_pr_create`, and importing the merge gate would drag
 * its whole dependency tree (`pr-context`, the fire log, the guard registry) into a hot path
 * that needs none of it.
 *
 * Returns null on ANY failure — non-zero exit, timeout, unparseable JSON, missing content.
 */
export function fetchSpecContent(
  task: string,
  cwd: string,
  exec: typeof execWithPath = execWithPath
): string | null {
  try {
    const result = exec(["minsky", "tasks", "spec", "get", task, "--json"], {
      cwd,
      timeout: SPEC_FETCH_TIMEOUT_MS,
    });
    if (result.exitCode !== 0) return null;
    const parsed = JSON.parse(result.stdout) as { content?: unknown };
    return typeof parsed.content === "string" ? parsed.content : null;
  } catch {
    return null;
  }
}

/**
 * Builds the injected context for a spec, or null when there is nothing worth injecting.
 *
 * Pure and exported so the acceptance tests can assert the TEXT without spawning a process.
 */
export function buildSuccessCriteriaContext(task: string, specContent: string): string | null {
  const section = extractSuccessCriteriaSection(specContent);
  if (section === null) return null;
  const trimmed = section.trim();
  if (trimmed.length === 0) return null;

  return (
    `📋 [success-criteria] You are creating the PR for ${task}. Its \`## Success Criteria\`, ` +
    `verbatim from the spec — read them against what you actually built, do not recall them ` +
    `from having written them:\n\n${trimmed}\n\n` +
    `Any criterion that names a command and an expected result is its own check: RUN it and ` +
    `paste the output into the PR body's \`Execution evidence:\` block. If one genuinely ` +
    `cannot run before merge, add an explicit \`[scN-deferred: mt#NNNN]\` marker for that ` +
    `criterion instead — prose explaining the skip reads as coverage to a human and as ` +
    `nothing to the gate. The PR body is editable after creation via \`session_pr_edit\`.`
  );
}

if (import.meta.main) {
  const input = await readInput<ToolHookInput>();

  const resolution = resolveMergeGateTaskId(input);
  if (!resolution.taskId) process.exit(0);

  const specContent = fetchSpecContent(resolution.taskId, input.cwd);
  if (specContent === null) process.exit(0);

  const context = buildSuccessCriteriaContext(resolution.taskId, specContent);
  if (context === null) process.exit(0);

  writeOutput({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      additionalContext: context,
    },
  });
  process.exit(0);
}
