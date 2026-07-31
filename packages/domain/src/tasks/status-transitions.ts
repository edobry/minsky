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
 * Per-kind restricted-transition special cases (mt#3010): the two
 * "implementation"-only exceptions — READY → IN-PROGRESS reserved for
 * session_start, and PLANNING → IN-PROGRESS needing a "go via READY" hint —
 * used to be `if (kind === "implementation")` branches here. They now live as
 * DATA on the "implementation" workflow's `restrictedTransitions` (see
 * workflows.ts), so this gate is purely a registry consultation with no
 * kind-specific control flow of its own.
 *
 * Cross-references:
 *   - mt#1812 — multi-kind workflow system
 *   - mt#3010 — moved the implementation-only special cases into registry data
 *   - packages/domain/src/tasks/workflows.ts — the registry this gate dispatches into
 */

import { ValidationError } from "../errors/index";
import { getWorkflow, DEFAULT_KIND } from "./workflows";

/**
 * Validate that a status transition is allowed for the given task kind.
 *
 * Dispatches on `kind` to select the per-kind workflow from the registry, then:
 *   1. Checks `workflow.restrictedTransitions` for a `from → to` match — these
 *      are transitions reserved for an alternate entry point (e.g.
 *      session_start), not a direct status-set call; their `message` is thrown
 *      verbatim so the caller gets a specific hint instead of the generic
 *      invalid-transition message.
 *   2. Otherwise validates `from → to` against the workflow's transition map.
 *
 * Note: READY → DONE is allowed in the "implementation" workflow's transition
 * map for external-deliverable tasks. The structural guard (hasCloseoutEvidence
 * check) is enforced in setTaskStatusFromParams before validateStatusTransition
 * is called — see .minsky/rules/task-lifecycle-external-deliverable.mdc (or the
 * compiled CLAUDE.md section).
 *
 * @param from    Current task status.
 * @param to      Desired next status.
 * @param kind    Task kind (defaults to "implementation" when unset).
 *
 * @throws {ValidationError} if the transition is not allowed by the workflow.
 */
export function validateStatusTransition(from: string, to: string, kind?: string | null): void {
  const resolvedKind = kind || DEFAULT_KIND;
  const workflow = getWorkflow(resolvedKind);

  const restricted = workflow.restrictedTransitions?.find((r) => r.from === from && r.to === to);
  if (restricted) {
    throw new ValidationError(restricted.message, undefined, undefined);
  }

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
