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
 * **Graduation re-evaluated and DECLINED at mt#3595 — the argument for it
 * does not survive the design that shipped.** mt#3595's spec anticipated
 * graduating this check to blocking on the reasoning that `forceImmediate`
 * would come to control TRANSPORT rather than merely windowing, which would
 * raise the stakes of missing it. That premise is false as built: mt#3595
 * introduced a SEPARATE `severity` field to drive the notification precisely
 * so paging would not be a side effect of a scheduling flag the
 * service-window reaper sets autonomously (mem#268). `forceImmediate` still
 * means only "do not hold this for the next window", so the stakes of this
 * check are unchanged and the original calibration-first rationale stands.
 *
 * The check that WOULD carry transport stakes is a severity-aware successor —
 * incident vocabulary present, `severity` absent. It is deliberately not
 * added here: it would have zero calibration history on day one, and the
 * ladder that governs this family (ADR-024, and the five mt#3326 checks'
 * own history) says a new check earns a blocking leg from measured fires,
 * not from an author's confidence at authoring time.
 *
 * **A seventh check, blocking from the start (mt#3477).**
 * `missing-decision-options` fires when a decision-shaped ask
 * (`direction.decide`) is created with no options — absent array or empty
 * array alike. It skips the calibration-first ladder the sixth check is on,
 * for two reasons. First, it has no false-positive class to calibrate: an
 * optionless `direction.decide` renders zero response buttons by
 * construction (`AskDetail.tsx` derives `optionCount` from the options array
 * and supplies a kind-based fallback only for `authorization.approve` /
 * `quality.review`), so the defect is structural rather than a judgment call
 * about wording — unlike `missing-force-immediate`, whose `production`
 * keyword carries a documented elevated FP risk. Second, the escalation
 * threshold the family set for itself has already been met: mem#760 records
 * "a third form-failure incident in this family within 30 days means the
 * manual discipline has failed and the ask-form-lint detector must gain a
 * blocking leg" — ask 6807fb14 (2026-07-15), ask#6448 (2026-07-29) and
 * ask#6589 (2026-07-31) are three inside 16 days. A genuinely
 * free-text-shaped decide ask remains creatable via the auditable
 * `acknowledgeFormWarnings: true` escape hatch.
 *
 * @see mt#2798 — this task
 * @see mt#2471 — the sibling routing detector (DONE, does not cover form)
 * @see memory `3e3f29d8` — escalation-packaging family (R1–R5)
 * @see mt#3326 — makes the first five checks consequential at the asks_create boundary
 * @see mt#3436 — adds the sixth, deliberately calibration-first (advisory) check
 * @see mt#3477 — adds the seventh (option presence), blocking from the start
 */

import {
  OPTION_LABEL_BUDGET,
  hasRedundantOptionLetterPrefix,
  isOverOptionLabelBudget,
} from "@minsky/shared/ask-option-label";
import { linkifyExternalRefs } from "./external-refs";
import type { AskKind } from "./types";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Matches an internal MCP tool id (e.g. `mcp__minsky__setup_github-app`). */
export const MCP_TOOL_ID_PATTERN = /\bmcp__/;

/**
 * Domain jargon that is NOT an MCP tool id (mt#4516).
 *
 * `MCP_TOOL_ID_PATTERN` above catches `mcp__*` and nothing else, so it is silent
 * on the vocabulary that actually reaches the principal. ask#9864 carried
 * `direction.decide`, `stuck.unblock`, `ADR-038` and `isSyncKind` in its body
 * and lint said nothing; the principal replied that he did not understand it.
 *
 * Three deliberately narrow patterns rather than one general
 * "dotted identifier" rule. A general one would match filenames
 * (`form-lint.ts`), version strings and hostnames — and the failure mode of a
 * noisy check is documented in mem#719: a detector emitting unmatchable output
 * erodes trust in its correct output. Each pattern below is a CLOSED or
 * syntactically unambiguous set:
 *
 * 1. The seven `AskKind` values. Enumerated, not inferred — they are the
 *    subsystem's own routing vocabulary and have no meaning to a reader who has
 *    not read `types.ts`. Kept in sync by `form-lint.test.ts`, which asserts the
 *    pattern covers every member of the union.
 * 2. `ADR-<n>` / `RFC-<n>` — an in-repo decision-record citation. The record may
 *    be worth linking in `contextRefs`; its NUMBER is not a thing to read.
 * 3. A backticked camelCase symbol (`isSyncKind`, `hasElicitation`). Backticks
 *    plus an internal capital is a code identifier by construction — prose does
 *    not produce that shape by accident.
 *
 * ALL THREE ARE ADVISORY, and this is the reason they are a separate check
 * rather than a widening of `internal-tool-id`: that check BLOCKS at the
 * `asks.create` / `asks.edit` boundary — it is absent from
 * `filterBlockingFormLintMatches`'s exclusion list — so widening it would ship
 * new hard rejects with no measured fire history behind them, the inverse of
 * the calibration-first ladder every other check here went through (mt#2263).
 *
 * Splitting the difference inside one check is not available:
 * `filterBlockingFormLintMatches` keys on `m.check`, so every match carrying
 * the name `internal-tool-id` blocks or none does. A separate check name IS
 * the mechanism for "widen coverage without widening blocking."
 *
 * mt#4516's SC4 originally said to widen `internal-tool-id`, and was AMENDED
 * to this shape during implementation after PR #3291 R1 flagged the
 * divergence — see that criterion's own text for the reconciliation. The
 * criterion, not this comment, is the record.
 */
export const ASK_KIND_JARGON_PATTERN =
  /\b(?:capability\.escalate|information\.retrieve|authorization\.approve|direction\.decide|coordination\.notify|quality\.review|stuck\.unblock)\b/;

/** In-repo decision-record citation by number — see `ASK_KIND_JARGON_PATTERN` (mt#4516). */
export const DECISION_RECORD_REF_PATTERN = /\b(?:ADR|RFC)-\d+/;

/** Backticked camelCase code symbol — see `ASK_KIND_JARGON_PATTERN` (mt#4516). */
export const BACKTICKED_SYMBOL_PATTERN = /`[a-z][a-zA-Z0-9]*[A-Z][a-zA-Z0-9]*`/;

/**
 * An inline gloss immediately following a term (mt#4901): a parenthetical, or a
 * matched dash-pair apposition.
 *
 * CLOSURE is what keeps this bounded. An opener alone — "ADR-042 required
 * measuring its trigger first" — is ordinary sentence punctuation rather than a
 * definition, so accepting one would suppress the warning on exactly the shape
 * it exists to catch.
 *
 * Deliberately STRUCTURAL, not semantic. `META_LEDE_PATTERN` below records the
 * constraint this module works under: an unbounded natural-language surface is
 * the axis ADR-024 assigns to embedding rather than regex. "Is this clause
 * really a definition?" is that axis and does not belong here; "is the term
 * followed by a closed apposition?" is punctuation, and decidable.
 */
export const INLINE_GLOSS_PATTERN = /^\s*(?:\(\s*[^)\n]{3,}?\)|[—–]\s*[^—–\n]{3,}?[—–])/;

/**
 * Whether `pattern`'s FIRST match in `question` is left unglossed — i.e.
 * whether the jargon warning should fire for that class (mt#4901).
 *
 * First use, not any use: an author who defines a term where they introduce it
 * has already done what the warning asks for, and the later bare uses that
 * follow are ordinary prose. ask#10650 opened *"Decide whether ADR-042 — the
 * record of which planning gates get a mechanical backstop — should be marked
 * Accepted"* and was warned anyway; its author's rebuttal is recorded in the
 * ask's own `metadata.formWarningDisposition`.
 */
export function firesUnglossed(question: string, pattern: RegExp): boolean {
  pattern.lastIndex = 0;
  const match = pattern.exec(question);
  if (!match) return false;
  return !INLINE_GLOSS_PATTERN.test(question.slice(match.index + match[0].length));
}

/**
 * Meta-commentary OPENING the question body (mt#4516).
 *
 * The edit path is reached because something was already wrong, so the sentence
 * that wants to come first is about the ask's own history rather than the
 * question. ask#9864's rewrite opened *"Correction, 2026-08-24: this ask was
 * filed on a misquote…"* — bookkeeping in the field that must carry the
 * decision.
 *
 * Anchored to the START of the body, deliberately: "correction" appearing
 * mid-paragraph is ordinary prose and must not fire. The label must also be
 * followed by punctuation, so a body legitimately beginning "Note that the
 * deploy…" does not match while "Note:" does.
 *
 * Recall is partial by construction. Unlike the three patterns above, this one
 * matches natural language, whose surface forms are unbounded — the axis
 * ADR-024 assigns to embedding rather than regex. It is advisory for that
 * reason and should not be answered by accumulating phrasings; if it misses
 * often enough to matter, that is evidence for a different mechanism, not a
 * longer alternation.
 */
export const META_LEDE_PATTERN =
  /^\s*(?:[-*+]\s+)?(?:\*\*)?(?:correction|note|update|revised|amended|errata)\b\s*(?:\*\*)?\s*[:,—–-]/i;

/** A bare ISO date opening the body — the other common meta-lede shape (mt#4516). */
export const DATE_LEDE_PATTERN = /^\s*(?:\*\*)?\d{4}-\d{2}-\d{2}\b/;

/**
 * The body's first sentence talking ABOUT the ask (mt#4516).
 *
 * The third meta-lede shape, and the one that needs no label: *"This ask was
 * filed on a misquote"* opens with the subject rather than a marker, so neither
 * pattern above sees it. Scoped to the FIRST SENTENCE for the same reason those
 * are anchored — an ask that mentions itself in passing further down is not
 * leading with bookkeeping.
 */
export const SELF_REFERENTIAL_LEDE_PATTERN = /\bthis ask\b/i;

/** Characters that end the opening sentence, for `SELF_REFERENTIAL_LEDE_PATTERN`'s scope. */
const SENTENCE_END = /[.?!]/;

/**
 * The body's opening sentence — the window `SELF_REFERENTIAL_LEDE_PATTERN` reads.
 *
 * Capped at 200 characters so a body with no terminal punctuation at all cannot
 * turn the "first sentence" check into a whole-body one.
 */
export function firstSentenceOf(question: string): string {
  const head = question.trimStart().slice(0, 200);
  const end = head.search(SENTENCE_END);
  return end === -1 ? head : head.slice(0, end + 1);
}

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
 * Prose by which an incident ask asserts its condition will NOT clear on its
 * own (mt#4315) — matched case-insensitively against the question body.
 *
 * ## Why the trigger is the ASSERTION, not a missing observation window
 *
 * mt#4315 was specced to fire on an assertion made WITHOUT stating how long the
 * author watched, on the theory that seeing "I watched this for 5 minutes"
 * beside "it will not clear on its own" would prompt the author to reconsider.
 * Planning measured that against the corpus and it does not hold: both
 * originating asks stated their window, adjacently and prominently, and
 * escalated anyway.
 *
 * - ask#9278: *"already held ~14 min with no sign of clearing"*
 * - ask#9279: *"count held at exactly 16 across ~5 minutes while ages advanced
 *   576s->858s"*
 *
 * Both conditions drained on their own roughly twenty minutes later. Neither
 * claim was careless — each was accurate about the window measured and wrong as
 * a PREDICTION, because the drain timescale exceeded the observation. A check
 * keyed on the missing window would have fired on neither, which is a measured
 * fire rate of 0 across every incident ask that has ever existed.
 *
 * So this fires on the assertion itself and says the thing the window was
 * supposed to prompt: it is a prediction beyond any window you can have
 * measured, and `work-completion.mdc §External self-resolving waits` calls that
 * category (b) — arm a watcher, keep working, do not escalate.
 *
 * ## Corpus and fire rate (measured 2026-08-19, re-runnable)
 *
 * Corpus: all 12 asks with `severity: "incident"`, 2026-08-05 → 2026-08-19 —
 * every one that has ever existed. This pattern matches **2 of 12**: ask#9278
 * and ask#9279. The other 10 do not make the claim at all, and they span
 * `authorization.approve`, `capability.escalate`, `direction.decide` and
 * `coordination.notify`.
 *
 * **Read the ask#9278 fire precisely — it is not what it looks like.** Its
 * STORED question is the RESOLVED rewrite, and the phrase that matches there is
 * the correction quoting its own earlier claim: *I said the wedged connections
 * showed "no sign of clearing."* The original assertion is gone from the record
 * (edited twice BEFORE mt#4329 added value retention, so its `editHistory` kept
 * field names and not prior values — an ask edited today keeps its original in
 * `metadata.originalContent`), so the live
 * sweep's ask#9278 fire is coincidental. The pinned fixture in
 * `form-lint.self-resolving-claim.test.ts` carries the real original, recovered
 * from the authoring transcript, and it fires on `will not reap`.
 *
 * That coincidence names a real false-positive class: **an ask that QUOTES a
 * prior persistence claim in order to RETRACT it will fire.** Accepted rather
 * than patched — the check is advisory, a retraction is exactly where the
 * category-(b) reminder is harmless, and a "unless it appears inside a quote"
 * carve-out is the arms-race move this docblock argues against below.
 *
 * **The 2 positives are partly circular** — the pattern was written from those
 * two cases, so their recall is fitted rather than predicted. The 10 negatives
 * are the load-bearing half: they are the no-over-fire evidence. Re-measure
 * rather than trusting these numbers:
 * `bun scripts/verify-self-resolving-claim-check.ts`.
 *
 * ## Known false-negative class, stated rather than discovered later
 *
 * `held steady` was in this set and was REMOVED (PR #3158 R2), on the evidence
 * rather than on the reviewer's say-so. It contributed 0 of the 2 corpus fires —
 * both matched other terms — while describing a flat measurement, which is a
 * shape benign incident prose takes constantly ("rate held steady at 2/s for
 * three minutes"). A term carrying no recall and a real false-positive surface
 * is exactly what the paragraph below says not to accumulate. Note where it came
 * from: ask#9279's *withdrawal* says "16 held steady", its escalation does not —
 * the term was sampled from a retraction and never earned its place.
 *
 * An author who asserts persistence WITHOUT this vocabulary — by implication,
 * or by describing a flat measurement and letting the reader conclude it —
 * produces no match. That is deliberate: the alternative is a phrase set that
 * grows one family per miss, which is the arms race ADR-024 §Context describes.
 * ADR-024 does not GOVERN this surface (its ladder scopes to `UserPromptSubmit`
 * guidance hooks, and this is a domain check at `asks.create`), so its rungs are
 * not available here — but its reasoning is why this set is deliberately small
 * and why a miss should be answered by re-measuring, not by appending.
 */
export const NOT_SELF_RESOLVING_PATTERN =
  /\b(wedged,?\s+not\s+(transient|draining)|not\s+(self.?resolving|transient|draining|clearing)|no\s+sign\s+of\s+clearing|will\s+not\s+(reap|clear|resolve|drain)|won'?t\s+(reap|clear|resolve|drain)|do(es)?\s+not\s+self.?clear)\b/i;

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

/**
 * The AskKinds that cannot be answered without options, and so must carry
 * them (mt#3477).
 *
 * Derived from two facts, not from an intuition about which kinds "feel"
 * decision-shaped — the criterion is: the ask resolves by SELECTING among
 * enumerable alternatives, AND the surface offers no built-in affordance for
 * that selection.
 *
 * - `direction.decide` — `types.ts`'s kind table defines it as a
 *   "Preference-bound choice — architectural, scope-level", so its resolution
 *   IS a selection; and `AskDetail.tsx`'s `hasOptions` is false for it without
 *   an options array, so the surface renders `No response options —
 *   defer/escalate or resolve via CLI.` instead of buttons. Both hold, so it
 *   is listed.
 * - `authorization.approve` and `quality.review` resolve by selection too, but
 *   `AskDetail.tsx` admits both to `hasOptions` unconditionally and renders two
 *   built-in buttons (Approve/Deny, Approve/Request-changes) when options are
 *   absent. They are answerable without options, so they are NOT listed —
 *   listing them would also reject the large optionless commit-authorization
 *   ask class (mt#2944 §Context).
 * - `capability.escalate`, `information.retrieve` and `stuck.unblock` resolve
 *   by supplying an ARTIFACT or an ANSWER (a bigger model's output, a fact, an
 *   unblock), not by picking from a list; `coordination.notify` is
 *   fire-and-forget and expects no response at all. None is a selection, so
 *   none is listed.
 */
export const OPTIONS_REQUIRED_CHECK_KINDS: readonly AskKind[] = ["direction.decide"];

/**
 * Words by which an option label carves an EXCEPTION out of the behavior it
 * authorizes (mt#4148).
 *
 * Every other check in this module asks whether the ask can be READ and
 * ANSWERED. This one is the first to ask about the option's CONTENT, and it is
 * deliberately the weakest thing that can be asked mechanically: no matcher can
 * know whether an exemption set is complete — that needs a model of the system
 * the option describes. What a matcher CAN see is that an exception was
 * written, which is the moment worth prompting the author to state the rule it
 * carves out of.
 *
 * Lower-cased at the call site rather than with an `i` flag, so the per-word
 * test stays free of `lastIndex` state.
 *
 * **`only` is deliberately NOT in this set**, though it is the word ask#8509's
 * option DESCRIPTION used ("exempting only clicks landing on an EntityRef").
 * A first draft included it and immediately failed an existing test: mt#3477's
 * repaired-shape replay asserts the label "Alias now, read-only until mt#3325"
 * is clean, and `\bonly\b` matches inside `read-only` because a hyphen is a
 * word boundary. That is a true false positive of exactly the kind mem#719
 * warns about — noise here would train authors to discount the check's correct
 * fires. The four words that remain are unambiguously carve-out constructions,
 * and `except` catches the originating incident's LABEL on its own, so nothing
 * is lost by the narrowing.
 *
 * Originating incident: ask#8509 (2026-08-13), whose recommended option read
 * "Close on outside click, except on an entity ref … exempting ONLY clicks
 * landing on an EntityRef." It passed all seven checks above, the completeness
 * checklist, and the form contract. The exemption set was still wrong — it
 * omitted every sibling peek pane, which would have destroyed the held-pair
 * comparison view — and the principal caught it on read rather than any
 * mechanism. See mem#258 R7.
 */
export const OPTION_EXCEPTION_WORD_PATTERN = /\b(except|unless|other than|apart from)\b/;

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
  | "missing-force-immediate"
  | "missing-decision-options"
  | "unlinkified-reference"
  | "unscoped-option-exception"
  | "duplicate-open-incident"
  | "asserted-not-self-resolving"
  | "domain-jargon"
  | "meta-lede";

/**
 * Markers that only appear in a question when the tool call's own parameter
 * encoding leaked into the value (mt#3936).
 *
 * None of these is legitimate prose. `</question>` is the closing tag of the
 * parameter the text is being stored INTO — if it survived into the value, the
 * value swallowed everything after it, including sibling parameters.
 *
 * Observed in production: ask#7484 (`capability.escalate`, severity incident,
 * about prod being four days stale) stored a question ending
 * `…Evidence in mt#3890.</question>\n<parameter name="options">[{…}]`. Its
 * three well-formed options never became data, so the surface rendered no
 * buttons on the one ask that most needed them. Three such rows exist,
 * 2026-07-26 through 2026-08-09.
 */
const SERIALIZED_PARAMETER_MARKERS = [
  "</question>",
  "<parameter name=",
  "</parameter>",
  "<function_calls>",
  "</invoke>",
] as const;

/**
 * The first serialization marker present in `question`, or `null`.
 *
 * Pure and exported so the boundary can reject on it BEFORE the
 * `acknowledgeFormWarnings` escape — unlike every other check here, this one
 * describes content that is definitionally broken rather than merely
 * ill-formed, so there is nothing for an author to legitimately acknowledge.
 */
export function findSerializedParameterArtifact(question: string): string | null {
  for (const marker of SERIALIZED_PARAMETER_MARKERS) {
    if (question.includes(marker)) return marker;
  }
  return null;
}

/**
 * The counterweight to `missing-force-immediate` (mt#4312).
 *
 * `34a937f0` ("Companion principles: attention, humility, and noticing"), the
 * page the Ask subsystem was designed from, names two attention failures and
 * requires both to be prevented:
 *
 *   > **Waste** is the system asking when it shouldn't have. … It bothered the
 *   > principal instead.
 *   > **Usurp** is the system deciding when it shouldn't have. … The principal
 *   > doesn't see this failure happen.
 *   > Any design that protects attention has to prevent both, not just one.
 *
 * Usurpation was mechanized first, and the record says why — it is SILENT, so
 * it has no other signal. Waste had nothing at any tier: `missing-force-immediate`
 * above prompts an author TOWARD paging, the `turn-end-unescalated-incident`
 * Stop-observer fires when a turn ends without one, and nothing anywhere asked
 * whether a page was warranted.
 *
 * Originating incident (2026-08-19): ask#9278 at 03:01:32Z and ask#9279 at
 * 03:02:12Z — two `authorization.approve` asks, both `severity: "incident"`,
 * both `forceImmediate`, both paging the principal 40 seconds apart, both
 * asking permission to `pg_terminate_backend` the same wedged Postgres
 * backends. Neither agent could see the other's ask. Both premises expired
 * within ~20 minutes when the backends drained on their own.
 */

/**
 * Minimum length for a signature token. Mirrors the hooks tree's
 * `MIN_SUBJECT_TOKEN_LENGTH` — same corpus, same problem, same answer.
 */
export const INCIDENT_SIGNATURE_MIN_TOKEN_LENGTH = 8;

/**
 * How many shared tokens make two incident asks the same incident.
 *
 * TWO, not one: a single shared identifier is how two genuinely different
 * incidents in one subsystem look. Both originating asks shared THREE
 * (`pg_terminate_backend`, `wait_event`, `ClientRead`), so the bar is met with
 * margin on the case this exists for.
 */
export const MIN_SHARED_SIGNATURE_TOKENS = 2;

/**
 * Identifier-shaped runs of >= 8 chars, lowercased.
 *
 * IDENTIFIER-shaped, not merely long, and that restriction is the whole
 * discriminator. A token qualifies only if it carries an underscore, a digit,
 * or an interior capital — so `pg_terminate_backend`, `ECHECKOUTTIMEOUT` and
 * `ClientRead` are signatures, while `production`, `connection`, `authorization`
 * and `principal` are not. Those prose words are exactly what two UNRELATED
 * incident asks share, and admitting them would make the check fire on any two
 * incidents at once.
 *
 * Exact substring matching, no stemming and no similarity metric — mem#819
 * records that similarity does not discriminate at the distances real
 * duplicates sit at in this corpus.
 *
 * **Known false-negative class, stated rather than implied:** an incident ask
 * written in plain prose — "the reviewer webhook is returning 502 and
 * crash-looping" — yields NO signature tokens at all, so it is never compared
 * against anything and this check can never fire for it. Found while writing
 * the tests, where exactly that string turned out to be an inert fixture. The
 * failure direction is the safe one (a missed duplicate, not a suppressed
 * incident), and widening toward prose words is the trade this check exists to
 * refuse — but a reader should not infer from silence that no duplicate exists.
 */
export function extractIncidentSignatureTokens(text: string): Set<string> {
  const out = new Set<string>();
  for (const raw of text.match(/[A-Za-z_][A-Za-z0-9_]*/g) ?? []) {
    if (raw.length < INCIDENT_SIGNATURE_MIN_TOKEN_LENGTH) continue;
    const isIdentifierShaped = raw.includes("_") || /\d/.test(raw) || /[A-Z]/.test(raw.slice(1));
    if (!isIdentifierShaped) continue;
    out.add(raw.toLowerCase());
  }
  return out;
}

/** An already-open incident ask, as the overlap check needs to see it. */
export interface OpenIncidentAskRef {
  /** Human-readable id for the warning message (e.g. `ask#9278`). */
  shortId: string;
  question: string;
}

/** One open incident ask this question overlaps, and the tokens they share. */
export interface IncidentOverlap {
  shortId: string;
  sharedTokens: string[];
}

/**
 * Open incident asks whose question shares >= {@link MIN_SHARED_SIGNATURE_TOKENS}
 * signature tokens with this one.
 *
 * Subject-keyed rather than task-keyed on purpose: ask#9278 carried
 * `parentTaskId: mt#4190` and ask#9279 carried none, so `getOpenAskForTask`
 * would not have linked the originating pair. Their entire overlap lived in the
 * question text.
 */
export function findOverlappingIncidentAsks(
  question: string,
  openIncidentAsks: readonly OpenIncidentAskRef[]
): IncidentOverlap[] {
  const mine = extractIncidentSignatureTokens(question);
  if (mine.size === 0) return [];
  const out: IncidentOverlap[] = [];
  for (const other of openIncidentAsks) {
    const shared = [...extractIncidentSignatureTokens(other.question)].filter((t) => mine.has(t));
    if (shared.length >= MIN_SHARED_SIGNATURE_TOKENS) {
      out.push({ shortId: other.shortId, sharedTokens: shared.sort() });
    }
  }
  return out;
}

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
   * The ask's options, when it has any. Optional: for the two option-LABEL
   * checks, omitting it is not "an ask with no options" but "a caller not
   * checking options at all", and must produce exactly the v1 warnings — those
   * two checks stay silent. That convention is unchanged by mt#3477.
   *
   * `missing-decision-options` (mt#3477) is the one check that reads absence,
   * and it treats an absent array and an empty one identically: neither can
   * render a button. That is sound because it asks a different question — not
   * "are these labels well-shaped?" (unanswerable without labels) but "does an
   * answer affordance exist at all?", which absence answers directly. It is
   * also safe in practice: both production call sites (`asks.create`'s
   * `validate` hook and `createAskWithFormLint`, in
   * `src/adapters/shared/commands/asks.ts`) pass the ask's REAL options
   * through, so an absent array here means the created Ask genuinely has none.
   * A future caller that wants only the question checks should not reach for
   * omission to get them — pass a decision-shaped kind's real options, or a
   * non-decision kind.
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
  /**
   * Whether this create carries `severity: "incident"` (mt#4312) — the marker
   * that pages the principal. Optional; absent is treated as not-an-incident,
   * matching the omission convention above.
   */
  severity?: string | undefined;
  /**
   * Open incident asks to check this one against (mt#4312).
   *
   * Passed IN rather than queried here, so this module stays a pure function of
   * its input and the DB read lives in the imperative shell at
   * `asks.create`. Omitting it is "the caller is not checking for duplicates",
   * not "there are none" — the check stays silent, exactly as `options`'
   * omission silences the label checks.
   */
  openIncidentAsks?: readonly OpenIncidentAskRef[];
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
 *   7. `kind` is in `OPTIONS_REQUIRED_CHECK_KINDS` AND `options` is absent or
 *      empty -> "decision-shaped ask with no response options" (mt#3477)
 *   8. any option label matches `OPTION_EXCEPTION_WORD_PATTERN` -> "state the
 *      rule the exception carves out of" (mt#4148). The first check here about
 *      an option's CONTENT rather than its readability, and permanently
 *      advisory for that reason — see the constant's doc comment.
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
 * Check 7 (mt#3477) is NOT excluded: it blocks alongside the original five.
 */
export function computeFormLintMatches(input: FormLintInput): FormLintMatch[] {
  const { kind, question, options, forceImmediate, severity, openIncidentAsks } = input;
  const matches: FormLintMatch[] = [];

  if (MCP_TOOL_ID_PATTERN.test(question)) {
    matches.push({
      check: "internal-tool-id",
      message: "internal tool id in principal-facing text",
    });
  }

  // mt#4516: the three jargon classes `internal-tool-id` cannot see. Reported
  // as ONE match naming which classes fired, not one per class — the fix is a
  // single rewrite pass either way, and the check's own origin is an ask that
  // carried all three at once.
  const jargonClasses: string[] = [];
  // mt#4901: a term GLOSSED inline at its first use has already satisfied the
  // warning's own first remedy ("say what it means"), so firing on it asks for
  // something the author did. See `firesUnglossed`.
  if (firesUnglossed(question, ASK_KIND_JARGON_PATTERN)) jargonClasses.push("ask-kind name");
  if (firesUnglossed(question, DECISION_RECORD_REF_PATTERN)) jargonClasses.push("ADR/RFC number");
  if (firesUnglossed(question, BACKTICKED_SYMBOL_PATTERN)) jargonClasses.push("code symbol");
  if (jargonClasses.length > 0) {
    matches.push({
      check: "domain-jargon",
      message: `domain jargon in principal-facing text (${jargonClasses.join(", ")}) — say what it means, or move the reference to contextRefs`,
    });
  }

  // mt#4516: the body opens with commentary about the ask rather than the
  // question. Anchored to the start; mid-body occurrences are ordinary prose.
  if (
    META_LEDE_PATTERN.test(question) ||
    DATE_LEDE_PATTERN.test(question) ||
    SELF_REFERENTIAL_LEDE_PATTERN.test(firstSentenceOf(question))
  ) {
    matches.push({
      check: "meta-lede",
      message:
        "body opens with commentary about the ask instead of the question — the prior wording is already preserved under metadata.originalContent",
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
        "pass forceImmediate: true so it is not held for the next service window, and " +
        'severity: "incident" so the substrate notifies the principal once (mt#3595). ' +
        "Do NOT also send a separate principal_notify — the ask carries its own " +
        "notification now. Skip both only when the principal is already actively " +
        "responding in-conversation (communication-contract.mdc §Severity transport binding)",
    });
  }

  // mt#3477: a decision-shaped ask that carries nothing to decide between.
  // Absent and empty are the same defect here — neither renders a button.
  if (OPTIONS_REQUIRED_CHECK_KINDS.includes(kind) && (options?.length ?? 0) === 0) {
    matches.push({
      check: "missing-decision-options",
      message:
        "a decision-shaped ask with no response options — the surface renders " +
        "no buttons, so the principal cannot answer it without dropping to the " +
        "CLI; supply an options array with one entry per choice, rather than " +
        "writing the choices as [a]/[b]/[c] prose in the question body " +
        "(humility.mdc Escalation packaging, Form rule 6: options are the buttons)",
    });
  }

  // mt#2918: an external artifact the reader needs, cited in a form they
  // cannot click. Reports only that the reference could not be linkified —
  // never that a destination was checked; see `external-refs.ts` for why no
  // probe runs here. Advisory by construction: it is on
  // `filterBlockingFormLintMatches`'s exclusion list at the asks.create
  // boundary, so an unlinkifiable citation warns and still creates.
  const { unlinkified } = linkifyExternalRefs(question);
  if (unlinkified.length > 0) {
    matches.push({
      check: "unlinkified-reference",
      message:
        `${unlinkified.length} artifact reference(s) could not be turned into a link ` +
        `(${unlinkified.join("; ")}) — the reader cannot open them from the ask. ` +
        `Supply the full URL. Note this says the reference was not linkified, not ` +
        `that a destination was checked: nothing here probes reachability`,
    });
  }

  // mt#4148: an option label that carves an exception, with no statement of the
  // rule it carves out of. Advisory by construction — it is on
  // `filterBlockingFormLintMatches`'s exclusion list, because unlike every
  // other check here it cannot be satisfied mechanically: the author has to
  // decide whether the exemption set is right, and a hard-reject would just
  // train them to reword the label rather than re-derive the set.
  const exceptionLabels = (options ?? []).filter((o) =>
    OPTION_EXCEPTION_WORD_PATTERN.test(o.label.toLowerCase())
  ).length;
  if (exceptionLabels > 0) {
    matches.push({
      check: "unscoped-option-exception",
      message:
        `${exceptionLabels} option label(s) carve an exception ` +
        `("except"/"unless"/"other than"/"apart from") — ` +
        `state the RULE the exception carves out of, not just the exception, and say where ` +
        `the exception set came from: derived from the system's structure, or taken from the ` +
        `one case that prompted this ask. An exemption written from the case in hand is how ` +
        `ask#8509 authorized a change that would have broken the feature (mem#258 R7)`,
    });
  }

  // mt#4312: an incident-marked ask whose subject already has an OPEN incident
  // ask. Advisory permanently, and on `filterBlockingFormLintMatches`'s
  // exclusion list for a reason this check owns rather than inherits: a
  // suppressed real incident is strictly worse than a duplicate page, so the
  // failure direction is chosen deliberately toward permitting. The fire is a
  // prompt to READ the other ask, not a refusal.
  if (severity === "incident" && openIncidentAsks && openIncidentAsks.length > 0) {
    const overlaps = findOverlappingIncidentAsks(question, openIncidentAsks);
    if (overlaps.length > 0) {
      const rendered = overlaps
        .map((o) => `${o.shortId} (shared: ${o.sharedTokens.join(", ")})`)
        .join("; ");
      matches.push({
        check: "duplicate-open-incident",
        message:
          `an incident ask is already open on what looks like this subject — ${rendered}. ` +
          `Read it before paging again: a second page for one incident spends the ` +
          `principal's attention twice and tells them nothing new. If it IS the same ` +
          `incident, add to that ask instead. If the condition is external and ` +
          `self-resolving — a pool draining, a service restarting, CI finishing — arm a ` +
          `watcher and keep working rather than escalating at all ` +
          `(work-completion.mdc §External self-resolving waits). If it is genuinely a ` +
          `different incident, say so and proceed`,
      });
    }
  }

  // mt#4315: an incident-marked ask asserting its condition will not clear on
  // its own. Sibling of the check above and its other half — that one asks "has
  // this already been raised?", this one asks "is the basis for raising it
  // sound?". Advisory permanently, on the same direction-of-error argument: a
  // suppressed real incident is worse than a warning the author overrides.
  //
  // Deliberately NOT conditioned on whether a window is stated. See
  // NOT_SELF_RESOLVING_PATTERN's docblock — both originating asks stated one and
  // escalated anyway, so keying on its absence measures 0 across the corpus.
  if (severity === "incident" && NOT_SELF_RESOLVING_PATTERN.test(question)) {
    matches.push({
      check: "asserted-not-self-resolving",
      message:
        `this ask asserts the condition will not clear on its own. That is a PREDICTION, and it ` +
        `reaches past any window you can have measured — the two asks that produced this check ` +
        `each stated theirs (~14 minutes and ~5 minutes), and both conditions drained on their ` +
        `own about twenty minutes later. Stating a longer window does not answer this; the drain ` +
        `timescale is simply not observable from inside the outage. If the condition is external ` +
        `and could resolve without you — a pool draining, a service restarting, CI finishing, a ` +
        `rate limit resetting — that is category (b) in work-completion.mdc §External ` +
        `self-resolving waits: arm a watcher and keep working rather than escalating. If you ` +
        `have already armed one, or the condition genuinely cannot self-resolve (a revoked ` +
        `credential, an exhausted quota, a permission that was never granted), say which in the ` +
        `question and proceed`,
    });
  }

  return matches;
}

/** Convenience wrapper: the plain warning-message strings, in check order. */
export function computeFormWarnings(input: FormLintInput): string[] {
  return computeFormLintMatches(input).map((m) => m.message);
}
