/**
 * Interpreting a post-merge state-sync outcome for the caller (mt#4381).
 *
 * `applyPostMergeStateSync` returns a `PostMergeStateSyncResult` with deliberate
 * three-way semantics. Reading it correctly is not obvious, and the merge path got
 * it wrong in both of the two ways available:
 *
 *   1. It propagated only `sessionCleanup` into `SessionMergeResult`, so a caller
 *      whose task-status write FAILED received `success: true`, full merge metadata,
 *      and no field to check. A task stranded at IN-REVIEW after a real merge was
 *      undetectable rather than merely unreported.
 *   2. Its CLI branch tested `taskStatusUpdated` alone, so the "attempted and failed"
 *      case fell into the `else if` and printed "Task is already marked as DONE" —
 *      the reassuring reading of the two, and the opposite of the truth.
 *
 * Both are decisions about the same value, so they live here as ONE pure function
 * rather than two inline branches: input in, report out, no IO. That also makes the
 * three outcomes testable without driving a real merge (git + GitHub + DB), which is
 * what kept them untested before.
 *
 * @see packages/domain/src/session/session-merge-status-sync.ts — the result type,
 *   whose own docblock says callers should consult `partialFailure` rather than the
 *   flags alone (PR #1121 R1 BLOCKING #3).
 * @see src/adapters/shared/commands/session/apply-post-merge-state-sync-command.ts —
 *   the sibling command that has propagated these fields correctly since mt#1841.
 */

import type { PostMergeStateSyncResult } from "./session-merge-status-sync";

/**
 * The three distinguishable outcomes of the task-status half of a post-merge sync.
 *
 * `already-terminal` and `write-failed` BOTH present as `taskStatusUpdated: false`;
 * only the error field separates them. Collapsing them is the mt#4381 defect, so they
 * are named separately here to make the distinction impossible to lose downstream.
 */
export type TaskSyncOutcome = "updated" | "already-terminal" | "write-failed" | "no-task";

/** The sync fields `SessionMergeResult` carries, mirroring the sibling command's set. */
export interface MergeSyncFields {
  taskStatusUpdated?: boolean;
  taskTerminalStatus?: string;
  sessionStatusUpdated?: boolean;
  pullRequestRecordUpdated?: boolean;
  taskUpdateError?: string;
  sessionUpdateError?: string;
  partialFailure?: boolean;
}

export interface MergeSyncReport {
  /** Fields to merge into `SessionMergeResult` — the JSON/MCP surface. */
  fields: MergeSyncFields;
  /** Which of the three task outcomes occurred. */
  outcome: TaskSyncOutcome;
  /** Human-readable lines for the CLI surface, in order. Empty in JSON mode. */
  lines: string[];
}

/**
 * Classify the task-status half of a sync result.
 *
 * Order matters and is the whole point: the error is checked FIRST, because a failed
 * write also leaves `taskStatusUpdated` false and would otherwise be read as
 * "already at the terminal status".
 */
export function classifyTaskSyncOutcome(result: PostMergeStateSyncResult): TaskSyncOutcome {
  if (result.taskUpdateError !== undefined) return "write-failed";
  if (result.taskStatusUpdated) return "updated";
  if (result.taskId !== undefined) return "already-terminal";
  return "no-task";
}

/**
 * Build the caller-facing report for a post-merge sync result.
 *
 * Pure: no IO, no clock, no logging. The caller decides whether to print `lines`.
 */
export function buildMergeSyncReport(result: PostMergeStateSyncResult): MergeSyncReport {
  const outcome = classifyTaskSyncOutcome(result);
  const terminal = result.taskTerminalStatus ?? "DONE";
  const lines: string[] = [];

  switch (outcome) {
    case "write-failed":
      lines.push(
        `⚠️  Task status NOT updated — the write was attempted and failed: ${result.taskUpdateError}`
      );
      lines.push(`   The merge landed; the task is still at its pre-merge status.`);
      break;
    case "updated":
      lines.push(`✅ Task status updated to ${terminal}`);
      break;
    case "already-terminal":
      lines.push(`ℹ️  Task is already marked as ${terminal}`);
      break;
    case "no-task":
      break;
  }

  if (result.sessionUpdateError !== undefined) {
    lines.push(`⚠️  Session record NOT updated: ${result.sessionUpdateError}`);
  }

  if (result.sessionCleanup?.directoriesRemoved.length) {
    lines.push(
      `✅ Cleaned up ${result.sessionCleanup.directoriesRemoved.length} session directories`
    );
  }
  if (result.sessionCleanup?.errors.length) {
    lines.push(`⚠️  ${result.sessionCleanup.errors.length} cleanup errors occurred`);
  }

  return {
    outcome,
    lines,
    fields: {
      taskStatusUpdated: result.taskStatusUpdated,
      taskTerminalStatus: result.taskTerminalStatus,
      sessionStatusUpdated: result.sessionStatusUpdated,
      pullRequestRecordUpdated: result.pullRequestRecordUpdated,
      taskUpdateError: result.taskUpdateError,
      sessionUpdateError: result.sessionUpdateError,
      partialFailure: result.partialFailure,
    },
  };
}
