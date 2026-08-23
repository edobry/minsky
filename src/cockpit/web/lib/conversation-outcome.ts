/**
 * The shared terminal-condition taxonomy for conversations (mt#3132 Scope item 3).
 *
 * Before this module the two conversation pipelines classified their endings
 * independently: the driven channel had its own status enum rendered by
 * `DrivenSessionStatusBar`, and the observed transcript path had a single
 * `isApiErrorText()` string-match as its ONLY terminal signal. Two vocabularies
 * for one question is the drift this task exists to remove — a conversation's
 * ending should not be described differently depending on which pipeline
 * happened to deliver it.
 *
 * ## Why this lives in the render layer
 *
 * Not an oversight, and not a place to "promote to domain later": the run-state
 * substrate explicitly assigns this mapping here. `conversation_run_state`
 * stores `last_error_type` VERBATIM from the harness, and says why in two
 * places — `packages/domain/src/storage/schemas/conversation-run-state-schema.ts`
 * (lines 22 and 142) and `packages/domain/src/conversation-run-state/event-mapping.ts`
 * (line 144): *"the Rate-limited-vs-Errored split in the mt#3130 vocabulary is
 * the render layer's mapping, not ours"*, kept revisable without a migration.
 * Putting the classifier in the domain would contradict a decision already
 * recorded in the substrate this module consumes.
 *
 * ## The vocabulary, and who evidences each value
 *
 * mt#3130's Outcome register has six values. Each has exactly one source of
 * evidence, and this module claims a value ONLY from that source:
 *
 * | Value          | Evidenced by                                              |
 * | -------------- | --------------------------------------------------------- |
 * | `Interrupted`  | transcript — a tool-result carrying `isInterruptionRejection` |
 * | `Errored`      | transcript — an anchored `API Error:` assistant turn       |
 * | `Rate-limited` | transcript — the same anchored turn, throttle-shaped       |
 * | `Completed`    | session driver — the channel reported a clean exit               |
 * | `Crashed`      | session driver — the channel reported a crash / unrecoverable    |
 * | `Stalled`      | **presence, not this module** — see below                  |
 *
 * `Stalled` is part of the vocabulary but is never returned by
 * {@link classifyOutcome}. It is derived from `conversation_run_state` at read
 * time and already rendered by `ConversationPresenceChip` as a presence VALUE
 * (`STALLED`); claiming it here too would put the same fact on screen twice
 * from two derivations. It stays in the type because the taxonomy is shared —
 * one vocabulary for both pipelines is the point — not because this function
 * is expected to grow an arm for it.
 *
 * Likewise, a transcript turn with nothing remarkable returns `null`, never
 * `Completed`. That discipline is inherited verbatim from the `turnOutcome`
 * docblock this module absorbed: labeling a turn `Completed` without a
 * completion signal asserts completion for turns that were actually cut off,
 * and an absent chip ("nothing to report") is the honest rendering.
 *
 * @see mt#3130 — the Outcome register this vocabulary implements
 * @see mt#3260 — the transcript-evidenced arm's original derivation
 * @see ./conversation-presence-display.ts — the presence readout that owns `Stalled`
 */

// ---------------------------------------------------------------------------
// The vocabulary
// ---------------------------------------------------------------------------

export type ConversationOutcome =
  | "Completed"
  | "Interrupted"
  | "Errored"
  | "Rate-limited"
  | "Crashed"
  | "Stalled";

/**
 * Tone classes per outcome.
 *
 * `Interrupted` and `Rate-limited` are amber, never red: `docs/design-system.md`'s
 * red-scarcity rule reserves the destructive tone for genuine failures, and
 * neither of these is one — an operator cancelling a tool call is a choice, and
 * a throttle is transient and self-clearing. mt#3130 calls out the first
 * distinction explicitly ("amber, NOT red — distinct from error"); the second
 * follows the same reasoning.
 *
 * `Completed` is muted rather than a success tone: a run ending normally is the
 * unremarkable case, and colouring it would compete with the two conditions on
 * this list that actually want the operator's eye.
 */
export const OUTCOME_TONE: Record<ConversationOutcome, string> = {
  Completed: "bg-muted text-muted-foreground",
  Interrupted: "bg-warn-amber/15 text-warn-amber",
  Errored: "bg-destructive/15 text-destructive",
  "Rate-limited": "bg-warn-amber/15 text-warn-amber",
  Crashed: "bg-destructive/15 text-destructive",
  Stalled: "bg-warn-amber/15 text-warn-amber",
};

// ---------------------------------------------------------------------------
// Transcript evidence
// ---------------------------------------------------------------------------

/**
 * Harness-emitted failure text sometimes lands as an ordinary assistant text
 * turn (e.g. "API Error: Connection closed mid-response.") rather than as a
 * tool-result error, where it renders identically to normal prose and is easy
 * to scroll past (mt#2793).
 *
 * Detection is deliberately conservative: an ANCHORED prefix match on the
 * turn's trimmed text, never a substring match — a turn that merely discusses
 * "the API Error" elsewhere in its prose stays unclassified.
 */
const API_ERROR_PREFIX = "API Error:";

/**
 * Throttle markers, matched only INSIDE an already-anchored `API Error:` turn.
 *
 * Scoping them to that prefix is what keeps this conservative: `429` and "rate
 * limit" are both things an agent writes about in ordinary prose all the time,
 * and matching them anywhere would misclassify a conversation ABOUT rate limits
 * as one that WAS rate-limited.
 */
const RATE_LIMIT_MARKERS = ["429", "rate limit", "rate_limit", "rate-limit", "too many requests"];

/**
 * Whether an assistant text turn is a harness-emitted API-error turn.
 *
 * Kept exported because the element renderer needs the same question answered
 * for STYLING (a destructive-toned alert block) independently of outcome
 * classification — but there is now exactly one implementation of the check
 * rather than a renderer-local copy and a classifier-local copy.
 */
export function isApiErrorText(text: string): boolean {
  return text.trimStart().startsWith(API_ERROR_PREFIX);
}

/**
 * Split an API-error turn into `Rate-limited` vs `Errored` — the exact mapping
 * the run-state schema defers to the render layer (see the module docblock).
 * Returns `null` for text that is not an API-error turn at all.
 */
function classifyErrorText(text: string): ConversationOutcome | null {
  if (!isApiErrorText(text)) return null;
  const haystack = text.toLowerCase();
  return RATE_LIMIT_MARKERS.some((marker) => haystack.includes(marker))
    ? "Rate-limited"
    : "Errored";
}

// ---------------------------------------------------------------------------
// Session driver evidence
// ---------------------------------------------------------------------------

/**
 * The session driver statuses that are TERMINAL — the browser-side mirror of
 * `isTerminalStatus` in `src/cockpit/driven-session-host.ts`, which this bundle
 * cannot import (`custom/no-node-import-in-cockpit-web` bans server-side value
 * imports here).
 *
 * This is the SINGLE definition of "terminal" for the cockpit bundle, not just
 * an outcome-classification detail: `conversation-address.ts`'s
 * `sessionDriverMayStillLink` delegates to it rather than keeping its own list. It
 * held a private denylist of `exited`/`crashed` once, which silently
 * mis-answered for `unrecoverable`; PR #2502 R1 caught it. One definition is
 * what keeps that from recurring per consumer.
 *
 * `useDrivenSession`'s `DrivenSessionStatus` also carries `connecting`,
 * `reconnecting` and `live` — those are TRANSPORT lifecycle, not outcomes, and
 * folding them into this vocabulary would be the same category error the
 * two-axis model exists to prevent (a channel reconnecting says nothing about
 * how the conversation ended). The status bar keeps rendering them itself.
 */
export type TerminalSessionDriverStatus = "exited" | "crashed" | "unrecoverable";

export function isTerminalSessionDriverStatus(
  status: string
): status is TerminalSessionDriverStatus {
  return status === "exited" || status === "crashed" || status === "unrecoverable";
}

// ---------------------------------------------------------------------------
// The classifier
// ---------------------------------------------------------------------------

/**
 * Evidence for one classification, discriminated by which pipeline observed it.
 *
 * A discriminated union rather than one wide options bag: each pipeline can
 * only supply the evidence it actually has, so a caller cannot accidentally ask
 * the transcript arm to answer a session driver question.
 */
export type OutcomeEvidence =
  | {
      source: "transcript";
      /** A tool-result in this turn carried `isInterruptionRejection`. */
      interrupted: boolean;
      /** The turn's assistant text elements, in order. */
      texts: readonly string[];
    }
  | { source: "sessionDriver"; status: TerminalSessionDriverStatus };

/**
 * The single terminal-condition classifier for both pipelines.
 *
 * Returns `null` when the evidence supports no outcome — the common case for
 * transcript turns, and the honest answer (see the module docblock on why an
 * unremarkable turn is not `Completed`).
 */
export function classifyOutcome(evidence: OutcomeEvidence): ConversationOutcome | null {
  if (evidence.source === "sessionDriver") {
    return evidence.status === "exited" ? "Completed" : "Crashed";
  }

  // Interruption WINS over error, and the precedence is load-bearing: the
  // harness marks a cancelled tool call `isError`, but the operator cancelling
  // is not a failure. Reporting it as `Errored` is exactly the miscount mt#3131
  // removed from the tallies — this keeps the RENDER consistent with those
  // already-corrected counts.
  if (evidence.interrupted) return "Interrupted";

  // A rate-limit turn anywhere in the turn wins over a plain error turn: it is
  // the more specific reading of the same evidence, and it is the one that
  // tells the operator the condition will clear on its own.
  let errored: ConversationOutcome | null = null;
  for (const text of evidence.texts) {
    const classified = classifyErrorText(text);
    if (classified === "Rate-limited") return "Rate-limited";
    if (classified !== null) errored = classified;
  }
  return errored;
}
