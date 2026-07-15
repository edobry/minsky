/**
 * Task status transition validation
 *
 * Validates status transitions by dispatching on the task's `kind` field to
 * select the appropriate workflow definition from the registry. This allows
 * each task kind to enforce its own state machine without changes to the gate.
 *
 * Backward compatibility: tasks with no `kind` field default to "implementation",
 * which encodes the existing state machine identically to the previous behaviour.
 *
 * Cross-references:
 *   - mt#1812 — multi-kind workflow system
 *   - src/domain/tasks/workflows.ts — the registry this gate dispatches into
 */

import { TaskStatus } from "./taskConstants";
import { ValidationError } from "../errors/index";
import { getWorkflow, DEFAULT_KIND } from "./workflows";

/**
 * Valid status transitions for the "implementation" kind (backward-compat export).
 *
 * This constant is retained for callers that import VALID_TRANSITIONS directly
 * (e.g. existing tests). It encodes the same transitions as the "implementation"
 * workflow in the registry. New code should use `getWorkflow(kind).transitions`.
 *
 * Note: PLANNING → IN-PROGRESS and READY → IN-PROGRESS are intentionally excluded
 * here — those transitions can only occur via `session_start`, not via direct
 * `tasks_status_set`.
 *
 * Note: READY → DONE is listed here for external-deliverable tasks. The structural
 * guard (hasCloseoutEvidence check) is enforced in setTaskStatusFromParams before
 * validateStatusTransition is called. See .minsky/rules/task-lifecycle-external-deliverable.mdc
 * (or the compiled CLAUDE.md section).
 */
export const VALID_TRANSITIONS: Record<TaskStatus, TaskStatus[]> = {
  [TaskStatus.TODO]: [TaskStatus.PLANNING, TaskStatus.CLOSED],
  [TaskStatus.PLANNING]: [TaskStatus.READY, TaskStatus.TODO, TaskStatus.BLOCKED, TaskStatus.CLOSED],
  // IMPORTANT: The READY → DONE entry below is a state-machine rule only. The actual gate
  // (spec must contain a non-empty `## Closeout evidence` section) is enforced in
  // setTaskStatusFromParams (mutation-commands.ts). Any new high-level entry point that calls
  // validateStatusTransition for a READY → DONE transition MUST replicate the
  // hasCloseoutEvidence check before doing so, or the gate will be bypassed.
  [TaskStatus.READY]: [TaskStatus.PLANNING, TaskStatus.BLOCKED, TaskStatus.CLOSED, TaskStatus.DONE],
  [TaskStatus.IN_PROGRESS]: [
    TaskStatus.IN_REVIEW,
    TaskStatus.BLOCKED,
    TaskStatus.PLANNING,
    TaskStatus.CLOSED,
  ],
  [TaskStatus.IN_REVIEW]: [
    TaskStatus.IN_PROGRESS,
    TaskStatus.DONE,
    TaskStatus.BLOCKED,
    TaskStatus.CLOSED,
  ],
  [TaskStatus.DONE]: [TaskStatus.CLOSED],
  [TaskStatus.BLOCKED]: [TaskStatus.TODO, TaskStatus.PLANNING, TaskStatus.READY, TaskStatus.CLOSED],
  [TaskStatus.CLOSED]: [TaskStatus.TODO],
};

/**
 * Validate that a status transition is allowed for the given task kind.
 *
 * Dispatches on `kind` to select the per-kind workflow from the registry,
 * then validates the `from → to` transition against that workflow's transition map.
 *
 * Special cases that apply ONLY to the "implementation" kind:
 *   - READY → IN-PROGRESS is reserved for session_start (not allowed via status_set).
 *   - PLANNING → IN-PROGRESS must go through READY first.
 *
 * @param from    Current task status.
 * @param to      Desired next status.
 * @param kind    Task kind (defaults to "implementation" when unset).
 *
 * @throws {ValidationError} if the transition is not allowed by the workflow.
 */
export function validateStatusTransition(from: string, to: string, kind?: string | null): void {
  const resolvedKind = kind || DEFAULT_KIND;

  // Special cases for the "implementation" kind only
  if (resolvedKind === "implementation") {
    // READY → IN-PROGRESS is reserved for session_start
    if (from === TaskStatus.READY && to === TaskStatus.IN_PROGRESS) {
      throw new ValidationError(
        "Use session_start to transition from READY to IN-PROGRESS",
        undefined,
        undefined
      );
    }

    // PLANNING → IN-PROGRESS must go through READY first
    if (from === TaskStatus.PLANNING && to === TaskStatus.IN_PROGRESS) {
      throw new ValidationError(
        "Cannot transition directly from PLANNING to IN-PROGRESS. Set status to READY first, then use session_start.",
        undefined,
        undefined
      );
    }
  }

  const workflow = getWorkflow(resolvedKind);
  const allowed = workflow.transitions[from] ?? [];

  if (!allowed.includes(to)) {
    const validList = allowed.join(", ");
    const kindLabel = resolvedKind !== DEFAULT_KIND ? ` (kind: ${resolvedKind})` : "";
    throw new ValidationError(
      `Cannot transition from ${from} to ${to}${kindLabel}. Valid transitions from ${from}: ${validList || "none"}`,
      undefined,
      undefined
    );
  }
}

/**
 * The heading pattern for the closeout evidence section (case-insensitive).
 * Exported so tests and callers can reference it without duplicating the regex.
 */
// `## Findings` and `## Outcome` are accepted as synonyms (mt#455): they read
// naturally for investigation-shaped (state-ops) tasks whose deliverable IS the
// findings section, while "Closeout evidence" remains the canonical name.
export const CLOSEOUT_EVIDENCE_HEADING =
  /^##\s+(closeout\s+evidence|findings|outcome)\s*[:.]?\s*$/i;

/**
 * Error message returned when an evidence-gated transition to DONE is attempted
 * without a valid closeout-evidence section in the spec (READY → DONE for any
 * kind; any → DONE for state-ops, mt#455).
 *
 * Exported so callers (mutation-commands.ts) and tests can reference it without
 * duplicating the string.
 */
export const READY_TO_DONE_MISSING_EVIDENCE_MESSAGE =
  "Transitioning to DONE on this path (READY → DONE, or any transition to DONE for " +
  "state-ops kind) requires a '## Closeout evidence' (or '## Findings' / '## Outcome') " +
  "section in the spec with non-empty content. " +
  "See the External-deliverable closeout rule in .minsky/rules/task-lifecycle-external-deliverable.mdc " +
  "(or the compiled CLAUDE.md section) for details.";

/**
 * Check whether a task spec contains a populated closeout-evidence section.
 *
 * Rules:
 *   - The heading must match `## Closeout evidence`, `## Findings`, or
 *     `## Outcome` (case-insensitive, with or without trailing punctuation).
 *   - The section must contain at least one non-blank line of content after the
 *     heading and before the next `##`-level heading or end-of-spec.
 *
 * @param specContent  Raw spec markdown string.
 * @returns `true` when the section is present and non-empty; `false` otherwise.
 */
export function hasCloseoutEvidence(specContent: string): boolean {
  if (!specContent) {
    return false;
  }

  const lines = specContent.split("\n");
  let inSection = false;

  for (const line of lines) {
    if (!inSection) {
      if (CLOSEOUT_EVIDENCE_HEADING.test(line.trim())) {
        inSection = true;
      }
    } else {
      // We are inside an evidence section. Another ##-level heading ends it,
      // but keep scanning — with multiple accepted headings (mt#455), a later
      // section may still carry the evidence. The ending heading may itself
      // open a new evidence section.
      if (/^##\s/.test(line)) {
        inSection = CLOSEOUT_EVIDENCE_HEADING.test(line.trim());
        continue;
      }
      // If we find a non-blank line, the section is non-empty — success.
      if (line.trim().length > 0) {
        return true;
      }
    }
  }

  // Reached end-of-spec without finding a non-blank content line.
  return false;
}
