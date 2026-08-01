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

// `## Findings` and `## Outcome` are accepted as synonyms (mt#455): they read
// naturally for investigation-shaped (state-ops) tasks whose deliverable IS the
// findings section, while "Closeout evidence" remains the canonical name.
/**
 * The heading pattern for the closeout evidence section (case-insensitive).
 * Exported so tests and callers can reference it without duplicating the regex.
 *
 * A trailing qualifier is accepted only when a DELIMITER introduces it — an opening
 * parenthesis or bracket, an em/en dash, or a colon (mt#3443):
 *
 *   `## Findings (planning investigation, 2026-07-31)`   accepted
 *   `## Outcome — recommendation`                        accepted
 *   `## Closeout evidence: deployed 2026-07-31`          accepted
 *   `## Findings from the reviewer that we rejected`     rejected
 *   `## Findings summary` / `## Outcomes`                rejected
 *
 * A bare prose continuation stays rejected because it is a different noun phrase, not a
 * qualified one: `## Findings summary` is a plausible heading for a section that is NOT
 * the closeout evidence. Widening to accept it would trade this false negative for a new
 * false-positive class (the argument mt#3311 makes for the sibling superseding-AT matcher).
 * A plain hyphen is likewise not a delimiter here — it is ordinary prose punctuation, the
 * same call mt#3511 made for the negative-control matcher.
 */
export const CLOSEOUT_EVIDENCE_HEADING =
  /^##\s+(?:closeout\s+evidence|findings|outcome)\s*(?:[:.]\s*(?:\S.*)?|[—–]\s*\S.*|[([]\s*\S.*)?\s*$/i;

/**
 * Headings that OPEN with an accepted noun but that {@link CLOSEOUT_EVIDENCE_HEADING}
 * still rejects — `## Findings summary`, `## Outcomes`, `## Findings from the reviewer`.
 *
 * Deliberately NOT a widening: this only lets the refusal say "your heading is the
 * problem" instead of "your section has no content," which is the diagnostic that cost a
 * source read on mt#3431.
 *
 * Its noun alternation must stay identical to {@link CLOSEOUT_EVIDENCE_HEADING}'s — the
 * near-miss pattern is that one with the tail dropped, so every accepted heading must also
 * match here. `every accepted heading is also a near-miss match` is pinned by a test.
 */
export const CLOSEOUT_EVIDENCE_NEAR_MISS_HEADING =
  /^##\s+(?:closeout\s+evidence|findings|outcome)/i;

/**
 * Error message returned when an evidence-gated transition to DONE is attempted
 * without a valid closeout-evidence section in the spec (READY → DONE for any
 * kind; any → DONE for state-ops, mt#455).
 *
 * Exported so callers (mutation-commands.ts) and tests can reference it without
 * duplicating the string.
 */
const EVIDENCE_GATED_PATHS =
  "Transitioning to DONE on this path (READY → DONE, or any transition to DONE for " +
  "state-ops kind) requires a";

const CLOSEOUT_EVIDENCE_RULE_POINTER =
  "See the External-deliverable closeout rule in .minsky/rules/task-lifecycle-external-deliverable.mdc " +
  "(or the compiled CLAUDE.md section) for details.";

export const READY_TO_DONE_MISSING_EVIDENCE_MESSAGE =
  `${EVIDENCE_GATED_PATHS} '## Closeout evidence' (or '## Findings' / '## Outcome') ` +
  `section in the spec with non-empty content. ${CLOSEOUT_EVIDENCE_RULE_POINTER}`;

/**
 * The heading forms the gate accepts, phrased for the author who just hit a refusal.
 * Named in the near-miss message only — the absent message has no heading to correct.
 */
const CLOSEOUT_EVIDENCE_ACCEPTED_FORMS =
  "Accepted headings (case-insensitive): '## Closeout evidence', '## Findings', '## Outcome'. " +
  "A trailing qualifier is accepted when a delimiter introduces it — '## Findings (2026-07-31)', " +
  "'## Outcome — recommendation', '## Closeout evidence: deployed'. A bare continuation is not: " +
  "'## Findings summary' and '## Outcomes' read as different sections, so rename the heading or " +
  "add a separate one.";

/**
 * Refusal for the case where an accepted heading IS present but its section is empty.
 * Split out from {@link READY_TO_DONE_MISSING_EVIDENCE_MESSAGE} so the author is not told
 * to add a section that already exists (mt#3443), and names WHICH heading is empty — in a
 * spec with several accepted headings, that is the whole question.
 */
export function closeoutEvidenceEmptySectionMessage(emptyHeadings: string[]): string {
  const list = emptyHeadings.map((heading) => `  ${heading}`).join("\n");
  return (
    `${EVIDENCE_GATED_PATHS} closeout-evidence section with non-empty content. The heading is ` +
    `present but its section is EMPTY — write the findings, outcome, or evidence beneath it:\n` +
    `${list}\n${CLOSEOUT_EVIDENCE_RULE_POINTER}`
  );
}

/**
 * Refusal for the case where the spec carries a heading that OPENS with an accepted noun
 * but that the pattern rejects. Names the offending heading verbatim, because the fix is a
 * two-word edit to that line and the old message pointed at content instead (mt#3443).
 */
export function closeoutEvidenceNearMissMessage(nearMissHeadings: string[]): string {
  const list = nearMissHeadings.map((heading) => `  ${heading}`).join("\n");
  return (
    `${EVIDENCE_GATED_PATHS} closeout-evidence section. The spec carries a section whose ` +
    "heading nearly matches, so this is a HEADING problem, not missing content:\n" +
    `${list}\n` +
    `${CLOSEOUT_EVIDENCE_ACCEPTED_FORMS} ${CLOSEOUT_EVIDENCE_RULE_POINTER}`
  );
}

/**
 * The refusal text for a given check result, or `null` when the section is present and
 * populated. Callers select the message through this rather than reaching for a specific
 * constant, so the three causes cannot drift back into one undifferentiated string.
 */
export function closeoutEvidenceFailureMessage(result: CloseoutEvidenceResult): string | null {
  switch (result.state) {
    case "present":
      return null;
    case "empty-section":
      return closeoutEvidenceEmptySectionMessage(result.emptyHeadings);
    case "near-miss":
      return closeoutEvidenceNearMissMessage(result.nearMissHeadings);
    case "absent":
      return READY_TO_DONE_MISSING_EVIDENCE_MESSAGE;
  }
}

/**
 * Why the closeout-evidence check failed — or that it did not.
 *
 * The three failure states used to be one boolean, so all three threw the same
 * content-focused refusal (mt#3443). `near-miss` in particular was reported as if the
 * section were absent, which sent authors looking for missing content while the actual
 * problem was two words in a heading.
 */
export type CloseoutEvidenceState = "present" | "empty-section" | "near-miss" | "absent";

/** Result of {@link checkCloseoutEvidence}. All headings are verbatim and trimmed. */
export interface CloseoutEvidenceResult {
  state: CloseoutEvidenceState;
  /** Accepted headings whose section had no content. Populated only for `empty-section`. */
  emptyHeadings: string[];
  /**
   * Headings that opened with an accepted noun but that the pattern rejected.
   * Populated only for `near-miss`; empty for every other state.
   */
  nearMissHeadings: string[];
}

/**
 * Classify a task spec's closeout-evidence section.
 *
 * Rules:
 *   - The heading must match {@link CLOSEOUT_EVIDENCE_HEADING} — `## Closeout evidence`,
 *     `## Findings`, or `## Outcome`, case-insensitive, optionally with a
 *     delimiter-introduced trailing qualifier.
 *   - The section must contain at least one non-blank line of content after the heading
 *     and before the next `##`-level heading or end-of-spec.
 *
 * State precedence: any populated accepted section wins (`present`); otherwise an accepted
 * but empty heading wins over a near miss (`empty-section`), because the author DID use an
 * accepted heading and the content is the real gap.
 *
 * @param specContent  Raw spec markdown string.
 */
export function checkCloseoutEvidence(specContent: string): CloseoutEvidenceResult {
  if (!specContent) {
    return { state: "absent", emptyHeadings: [], nearMissHeadings: [] };
  }

  const lines = specContent.split("\n");
  const acceptedHeadings: string[] = [];
  const nearMissHeadings: string[] = [];
  let inSection = false;

  for (const line of lines) {
    const trimmed = line.trim();

    // A ##-level heading ends any section it follows, and may itself open a new one —
    // with multiple accepted headings (mt#455), a later section can still carry the
    // evidence even when an earlier one was empty.
    if (/^##\s/.test(trimmed)) {
      inSection = CLOSEOUT_EVIDENCE_HEADING.test(trimmed);
      if (inSection) {
        acceptedHeadings.push(trimmed);
      } else if (CLOSEOUT_EVIDENCE_NEAR_MISS_HEADING.test(trimmed)) {
        nearMissHeadings.push(trimmed);
      }
      continue;
    }

    if (inSection && trimmed.length > 0) {
      return { state: "present", emptyHeadings: [], nearMissHeadings: [] };
    }
  }

  // Reaching here means no accepted section held content, so every one collected is empty.
  if (acceptedHeadings.length > 0) {
    return { state: "empty-section", emptyHeadings: acceptedHeadings, nearMissHeadings: [] };
  }
  if (nearMissHeadings.length > 0) {
    return { state: "near-miss", emptyHeadings: [], nearMissHeadings };
  }
  return { state: "absent", emptyHeadings: [], nearMissHeadings: [] };
}

/**
 * Whether a task spec contains a populated closeout-evidence section.
 *
 * Kept as the boolean predicate for callers that only need the verdict;
 * {@link checkCloseoutEvidence} is what a caller selecting a refusal message wants.
 */
export function hasCloseoutEvidence(specContent: string): boolean {
  return checkCloseoutEvidence(specContent).state === "present";
}
