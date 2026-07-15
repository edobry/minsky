/**
 * Ask form-lint — advisory (warn-only) mechanical checks on Ask content
 * (mt#2798).
 *
 * Companion to `humility.mdc §Escalation packaging`'s "Form" sub-checklist
 * (ask 6807fb14, R5 of the escalation-packaging family): an Ask can be
 * correctly ROUTED (mt#2471) and content-COMPLETE per the original 5-item
 * checklist, yet still be unusable in FORM — action buried, internal tool
 * ids leaking into principal-facing text, a portal action with no direct
 * link.
 *
 * v1 is deliberately mechanical-only. Three checks, no fuzzier heuristics
 * (unnamed-referent detection, etc.) — those are explicitly out of scope
 * until calibration data justifies adding them. See the task spec's
 * Deliverable 2 and Scope sections.
 *
 * Pure, side-effect-free: no filesystem or network I/O. The calibration-log
 * write lives in the command-adapter layer
 * (`src/adapters/shared/commands/ask-form-lint-calibration.ts`) so this
 * module stays trivially unit-testable.
 *
 * @see mt#2798 — this task
 * @see mt#2471 — the sibling routing detector (DONE, does not cover form)
 * @see memory `3e3f29d8` — escalation-packaging family (R1–R5)
 */

import type { AskKind } from "./types";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Matches an internal MCP tool id (e.g. `mcp__minsky__setup_github-app`). */
export const MCP_TOOL_ID_PATTERN = /\bmcp__/;

/**
 * Word-count budget for the question body (spec Deliverable 2: "> 150
 * words"). This is the MECHANICAL lint threshold, not the authoring target.
 *
 * `humility.mdc §Escalation packaging`'s Form checklist separately tells
 * AUTHORS to aim for "~120 words" — an aspirational target that leaves
 * margin before this automated check fires. The two numbers are
 * intentionally different (120 < 150), by design, not a drift bug: firing
 * the warning right at the authoring target would make it noisy for asks
 * that are merely a little over the aspiration but still reasonably
 * concise; 150 is the point past which the body is unambiguously too long
 * and the fix ("move justification to contextRefs") is clearly warranted.
 */
export const FORM_LINT_WORD_BUDGET = 150;

/** Keywords suggesting the action happens in a portal/UI. */
export const PORTAL_KEYWORD_PATTERN = /\b(settings|portal|console|grant|permission)\b/i;

/** Matches any http(s) URL. */
export const URL_PATTERN = /https?:\/\//i;

/** The AskKind this check's portal/link rule applies to. */
export const PORTAL_LINK_CHECK_KIND: AskKind = "authorization.approve";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** The three v1 mechanical form-lint checks. */
export type FormLintCheck = "internal-tool-id" | "over-word-budget" | "portal-no-link";

/** A single fired check, with its human-readable warning message. */
export interface FormLintMatch {
  check: FormLintCheck;
  message: string;
}

/** Input to the form-lint checks: the fields of an Ask that matter for form. */
export interface FormLintInput {
  kind: AskKind;
  question: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Count whitespace-delimited words in a string. Empty/whitespace-only -> 0. */
export function countWords(text: string): number {
  const trimmed = text.trim();
  return trimmed.length === 0 ? 0 : trimmed.split(/\s+/).length;
}

// ---------------------------------------------------------------------------
// Checks (v1 — exactly three, mechanical only)
// ---------------------------------------------------------------------------

/**
 * Compute the form-lint matches for an Ask's kind + question body.
 *
 * Checks (spec Deliverable 2, exact):
 *   1. `question` contains `mcp__` -> "internal tool id in principal-facing text"
 *   2. `question` body > 150 words -> "over form budget; move justification to contextRefs"
 *   3. `kind == "authorization.approve"` AND question matches
 *      /settings|portal|console|grant|permission/i AND contains no `https?://`
 *      URL -> "portal action with no direct link"
 *
 * Advisory only — callers must never block Ask creation on these matches.
 */
export function computeFormLintMatches(input: FormLintInput): FormLintMatch[] {
  const { kind, question } = input;
  const matches: FormLintMatch[] = [];

  if (MCP_TOOL_ID_PATTERN.test(question)) {
    matches.push({
      check: "internal-tool-id",
      message: "internal tool id in principal-facing text",
    });
  }

  if (countWords(question) > FORM_LINT_WORD_BUDGET) {
    matches.push({
      check: "over-word-budget",
      message: "over form budget; move justification to contextRefs",
    });
  }

  if (
    kind === PORTAL_LINK_CHECK_KIND &&
    PORTAL_KEYWORD_PATTERN.test(question) &&
    !URL_PATTERN.test(question)
  ) {
    matches.push({
      check: "portal-no-link",
      message: "portal action with no direct link",
    });
  }

  return matches;
}

/** Convenience wrapper: the plain warning-message strings, in check order. */
export function computeFormWarnings(input: FormLintInput): string[] {
  return computeFormLintMatches(input).map((m) => m.message);
}
