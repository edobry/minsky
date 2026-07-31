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
 * Deliverable 2 and Scope sections. Two more checks (option-label length
 * and redundant letter-prefix) were added in mt#3253.
 *
 * Pure, side-effect-free: no filesystem or network I/O. The calibration-log
 * write lives in the command-adapter layer
 * (`src/adapters/shared/commands/ask-form-lint-calibration.ts`) so this
 * module stays trivially unit-testable.
 *
 * **Advisory-in-itself, consequential at the caller (mt#3326).** This
 * module only computes matches — it never blocks and has no opinion on
 * severity. Whether a caller treats a match as informational or fatal is
 * the caller's decision. As of mt#3326, `asks.create`'s command-layer
 * `validate` hook (`validateFormLintNotViolated` in
 * `src/adapters/shared/commands/asks.ts`) hard-rejects a create whose
 * question/options produce any non-empty match set here, unless the caller
 * passes `acknowledgeFormWarnings: true`. `createAskWithFormLint` (the
 * lower-level wrapper this module feeds) remains unconditionally
 * non-blocking — the rejection happens one layer up, before
 * `createAskWithFormLint` is even called.
 *
 * **A sixth check, deliberately NOT part of the mt#3326 hard-reject
 * (mt#3436).** `missing-force-immediate` fires when an operator-only-shaped
 * Ask (`authorization.approve` / `stuck.unblock`, question reading like a
 * live incident) is created without `forceImmediate`. Unlike the five
 * mt#3326 checks, `validateFormLintNotViolated` explicitly EXCLUDES this
 * check from its blocking decision — it stays calibration-first (warn via
 * the calibration log only) because, unlike the five checks mt#3326
 * escalated, there is no calibration evidence yet that authors ignore it.
 * See `docs/rules-rationale/communication-contract.md §Severity transport
 * binding` for the originating incident (mt#3433 / mem#779).
 *
 * @see mt#2798 — this task
 * @see mt#2471 — the sibling routing detector (DONE, does not cover form)
 * @see memory `3e3f29d8` — escalation-packaging family (R1–R5)
 * @see mt#3326 — makes the first five checks consequential at the asks_create boundary
 * @see mt#3436 — adds the sixth, deliberately calibration-first (advisory) check
 */

import {
  OPTION_LABEL_BUDGET,
  hasRedundantOptionLetterPrefix,
  isOverOptionLabelBudget,
} from "@minsky/shared/ask-option-label";
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

/**
 * Vocabulary suggesting the ask describes a live, operator-only-remediable
 * incident (mt#3436) — matched case-insensitively, whole-word only, against
 * the question body. Grounded in the originating incident's actual ask text
 * (`cb89ecf1` / ask#6575: "...has been failing every review... 429 You have
 * no credits remaining..."), not a speculative list. Verbatim from the
 * mt#3436 spec's Success Criterion 2.
 *
 * **Known elevated false-positive risk on `production` (PR #2472 R1).** A
 * bare "production" fires on any routine deploy/approval ask that merely
 * mentions the environment (e.g. "approve deploying main to production"),
 * not just genuine incidents — confirmed by a pre-existing test in this
 * repo that had to be reworded once this check landed
 * (`asks.form-lint-options.test.ts`'s "an optionless ask is unaffected by
 * the option checks"). This is accepted, not a bug: the check is
 * deliberately calibration-first (warn-only, `.minsky/ask-form-lint-calibration.jsonl`),
 * the exact posture that tolerates an elevated false-positive rate while
 * real fire-rate data accumulates — the same ladder the five mt#3326 checks
 * themselves went through before any of them proved worth blocking on. If
 * `/calibration-review` later shows `production` dominating fires with low
 * signal, narrow the pattern (e.g. require it alongside another vocabulary
 * word, or drop it) then — not speculatively now.
 */
export const INCIDENT_VOCABULARY_PATTERN =
  /\b(outage|down|credits|failing|production|incident|429)\b/i;

/**
 * The AskKinds this check's severity-transport rule applies to (mt#3436):
 * both are operator-only-shaped by design (`authorization.approve` routes
 * to the operator; `stuck.unblock` per `types.ts`'s kind table escalates
 * "Opus → peer → operator"), so both are candidates for the
 * operator-only-blocker binding `communication-contract.mdc §Severity
 * pierces the register` now names.
 */
export const SEVERITY_TRANSPORT_CHECK_KINDS: readonly AskKind[] = [
  "authorization.approve",
  "stuck.unblock",
];

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * The mechanical form-lint checks: three from v1 (mt#2798) plus two on the
 * OPTION LABELS (mt#3253) — the text that renders on the decision buttons.
 *
 * The option-label pair extends v1's question-body focus to
 * `humility.mdc §Escalation packaging` Form rule 6 ("options are the buttons"):
 * a label needing 167 characters, or repeating the letter the surface already
 * renders, is not a button label.
 */
export type FormLintCheck =
  | "internal-tool-id"
  | "over-word-budget"
  | "portal-no-link"
  | "long-option-label"
  | "letter-prefixed-option-label"
  | "missing-force-immediate";

/** A single fired check, with its human-readable warning message. */
export interface FormLintMatch {
  check: FormLintCheck;
  message: string;
}

/**
 * The subset of an option this lint reads. Structurally satisfied by `AskOption`
 * (whose `value` and `description` this deliberately ignores) so callers can
 * pass their options array straight through.
 */
export interface FormLintOption {
  label: string;
}

/** Input to the form-lint checks: the fields of an Ask that matter for form. */
export interface FormLintInput {
  kind: AskKind;
  question: string;
  /**
   * The ask's options, when it has any. Optional: omitting it is not "an ask
   * with no options" but "a caller not checking options at all", and must
   * produce exactly the v1 warnings — the two option checks stay silent.
   */
  options?: readonly FormLintOption[];
  /**
   * Whether the ask was (or will be) created with `forceImmediate: true`
   * (mt#3436). Optional and defaults to falsy — a caller not passing it at
   * all is treated the same as an explicit `false`, matching `options`'
   * omission convention above; the `missing-force-immediate` check stays
   * silent only when the kind/vocabulary conditions don't fire, never
   * because this field was merely omitted.
   */
  forceImmediate?: boolean;
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
 * Compute the form-lint matches for an Ask's kind, question body, and option
 * labels.
 *
 * Checks:
 *   1. `question` contains `mcp__` -> "internal tool id in principal-facing text"
 *   2. `question` body > 150 words -> "over form budget; move justification to contextRefs"
 *   3. `kind == "authorization.approve"` AND question matches
 *      /settings|portal|console|grant|permission/i AND contains no `https?://`
 *      URL -> "portal action with no direct link"
 *   4. any option label > `OPTION_LABEL_BUDGET` chars -> "move the rationale
 *      into the option's description" (mt#3253)
 *   5. any option label opens with a redundant letter marker -> "the surface
 *      renders the letter" (mt#3253)
 *   6. `kind` is `authorization.approve` or `stuck.unblock` AND `question`
 *      matches `INCIDENT_VOCABULARY_PATTERN` AND `forceImmediate` is not
 *      true -> "operator-only incident without forceImmediate" (mt#3436)
 *
 * Checks 4 and 5 fire ONCE for the ask, not once per offending option: the fix
 * is the same edit either way, and a four-option ask would otherwise emit four
 * identical warnings. The message carries the offending count so the producer
 * knows the scope of the edit.
 *
 * This function itself never blocks — it only computes matches. As of
 * mt#3326, `asks.create`'s command layer DOES block on a non-empty result
 * (see the module-level doc comment above); a caller building its own
 * surface on top of this function is free to keep matches advisory,
 * consistent with the pre-mt#3326 contract. Check 6 (mt#3436) is EXCLUDED
 * from that hard-reject at the `asks.create` boundary regardless — see
 * `validateFormLintNotViolated` in `src/adapters/shared/commands/asks.ts`.
 */
export function computeFormLintMatches(input: FormLintInput): FormLintMatch[] {
  const { kind, question, options, forceImmediate } = input;
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

  const overBudget = (options ?? []).filter((o) => isOverOptionLabelBudget(o.label)).length;
  if (overBudget > 0) {
    matches.push({
      check: "long-option-label",
      message: `${overBudget} option label(s) over ${OPTION_LABEL_BUDGET} chars; move the rationale into the option's description`,
    });
  }

  const letterPrefixed = (options ?? []).filter((o) =>
    hasRedundantOptionLetterPrefix(o.label)
  ).length;
  if (letterPrefixed > 0) {
    matches.push({
      check: "letter-prefixed-option-label",
      message: `${letterPrefixed} option label(s) start with a redundant letter marker; the surface renders the letter`,
    });
  }

  // mt#3436: operator-only-shaped ask, incident-vocabulary question, no
  // forceImmediate. Deliberately calibration-first — see the module-level
  // doc comment for why this check is excluded from the mt#3326 hard-reject.
  if (
    SEVERITY_TRANSPORT_CHECK_KINDS.includes(kind) &&
    INCIDENT_VOCABULARY_PATTERN.test(question) &&
    !forceImmediate
  ) {
    matches.push({
      check: "missing-force-immediate",
      message:
        "question reads like an operator-only incident but forceImmediate is not set — " +
        "severity events should page the principal (communication-contract.mdc §Severity " +
        "pierces the register); pass forceImmediate: true and send a principal_notify " +
        "pointing at this ask, unless the principal is already actively responding " +
        "in-conversation",
    });
  }

  return matches;
}

/** Convenience wrapper: the plain warning-message strings, in check order. */
export function computeFormWarnings(input: FormLintInput): string[] {
  return computeFormLintMatches(input).map((m) => m.message);
}
