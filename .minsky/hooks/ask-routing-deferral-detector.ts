#!/usr/bin/env bun
// UserPromptSubmit hook: detect when the prior assistant turn DEFERRED a
// decision to the principal via chat prose without routing it through the Ask
// substrate (asks_create) — or surfaced a deferral menu around items that a
// cheap lookup / standing default would resolve. Per mt#2471.
//
// LIVE-INJECTING since 2026-07-08 (mt#2694): shipped calibration-first
// (mirrors causal-premise-detector mt#2216) with INJECTION_ENABLED=false;
// the gate was flipped after the 2026-07-06/07-08 calibration reviews
// confirmed a ~5-10% FP rate across 44 fires (see the INJECTION_ENABLED
// doc below). Matches now inject the additionalContext reminder AND log a
// calibration record (post-flip FP monitoring, mt#2483 loop).
//
// TWO sub-classes (the spec's R4 + the 2026-06-11 post-closeout incident):
//   - PRINCIPAL-RESERVED ("needs your call", "that decision is his", "you
//     decide"): the fix is to package the decision per humility.mdc and file
//     it via `asks_create` (kind direction.decide).
//   - DEFERRAL-MENU ("what's your call?", "say the word", "stop here" as a
//     recommendation): the fix is to route through `/classify-before-deferring`
//     FIRST — most options are Class A (run the lookup now) / Class B (apply
//     the standing default), and only a genuine Class C reaches the ask.
//
// Suppressed when the same assistant turn already contains an
// `mcp__minsky__asks_create` tool_use (the agent already routed the decision).
//
// @see .claude/hooks/retrospective-trigger-scanner.ts — sibling structure
// @see .claude/hooks/causal-premise-detector.ts — calibration-first pattern
// @see 3e3f29d8 (escalation-packaging family R1–R4); 6abe89c6 (post-closeout
//      register-shift sub-class); both name mt#2471 as the live structural target
// @see mt#2263 — future consolidation of the regex-scanner family into a
//      unified (possibly embedding-based) matcher; this hook is a framework sibling
// @see mt#2652 — ADR-028 Phase 2a: this file's exported `run()` is the
//      dispatcher-compatible entry point invoked in-process by
//      `./dispatch-userpromptsubmit.ts`; `main()` / the CLI entrypoint below
//      is unchanged.

import { readInput } from "./types";
import type { ClaudeHookInput, HookOutput } from "./types";
import {
  resolveParentTranscriptLinesForPath,
  extractLastAssistantTurn,
  extractAssistantText,
  extractToolUseNames,
} from "./transcript";
import type { TranscriptLine } from "./transcript";
import { logCalibrationRecord } from "./dispatcher";
import type { DispatchContext, GuardOutcome } from "./registry";
import { elideQuotedContexts, elideDoubleQuotedSpans } from "./elision";
import {
  CAPTURE_SCHEMA_FIELD,
  CAPTURE_SCHEMA_VERSION,
  extractMatchContext,
} from "./judged-input-capture";
import { createHash } from "node:crypto";
import { cappedEvidenceLines, truncateToRenderedLength } from "./guard-feedback-format";
import { STOP_INJECTED_OVERLAP_FAMILY, overlapTurnKey, readFlagged } from "./turn-end-scan-store";
import { nominate } from "../../packages/domain/src/detectors/embedding-nomination";
import type {
  ExemplarSet,
  NominationDeps,
} from "../../packages/domain/src/detectors/embedding-nomination";
import { resolveNominationDeps } from "../../packages/domain/src/detectors/embedding-nomination-factory";
import { ensureHookDomainBootstrap } from "./domain-bootstrap";

// ---------------------------------------------------------------------------
// Public API: exported constants
// ---------------------------------------------------------------------------

/**
 * Injection gate. FLIPPED TO TRUE 2026-07-08 (mt#2694, operator-approved):
 * the 2026-07-06 calibration review (disposition ask 483dbcb0, mt#2619)
 * classified all 43 fires in its window as genuine (~5-10% FP rate, both
 * sub-classes), and the single fire since (2026-07-07) was also a real
 * positive (2026-07-08 review, ask 0147caa5). Calibration logging continues
 * unchanged for post-flip FP monitoring (mt#2483 loop).
 *
 * v1 (mt#2471) shipped FALSE (calibration-first: log only, inject nothing).
 */
export const INJECTION_ENABLED = true;

export const OVERRIDE_ENV_VAR = "MINSKY_ACK_ASK_ROUTING_DEFERRAL";

/** The tool whose presence in the same turn suppresses a match. */
export const ASKS_CREATE_TOOL = "mcp__minsky__asks_create";

const CALIBRATION_LOG_NAME = "ask-routing-deferral";

/**
 * Reason string for this detector's ONE suppression gate — the turn already
 * routed a decision through `asks_create` (mt#3207).
 *
 * Before mt#3207 this gate skipped DETECTION entirely and exited before the
 * calibration write, so a suppressed deferral produced no record at all and
 * the sweep counted the gate as costless. Detection now runs unconditionally
 * and the suppressed fire is recorded; the injection decision is unchanged.
 */
export const SUPPRESSION_ASKS_CREATE_THIS_TURN = "asks-create-this-turn";

/**
 * The Stop-event untaken-action guard already injected about this same closing
 * sentence (mt#3620), so this guard stays quiet — one sentence, one injection,
 * spoken by the guard that runs BEFORE the principal reads it.
 */
export const SUPPRESSION_STOP_GUARD_ALREADY_INJECTED = "deduped-by-untaken-action-stop";

/**
 * Reason string for the mt#4201 suppression: the matched sentence CITES an ask
 * that is already filed, so the message is REPORTING a routed decision rather
 * than deferring one in prose.
 *
 * This is the inversion mem#719 names in its sharpest form — the fire lands on
 * the compliant behaviour, so the reader most likely to see it is the one who
 * did the right thing, and the remedy it emits ("file an ask") is already done.
 * Measured across three independent windows: 2 of 2 `principal-reserved` matches
 * (2026-08-10, via the subsumed mt#3932), 2 of 3 false (2026-08-17), and 1 of 10
 * injected (2026-08-20).
 */
export const SUPPRESSION_CITES_FILED_ASK = "cites-filed-ask";

/**
 * Reason string for the mt#4175 suppression: the offer FOLLOWS a decision this
 * agent already took, so it is a revisability offer rather than a deferral.
 *
 * Same inversion as {@link SUPPRESSION_CITES_FILED_ASK} one class over. The
 * matched phrase here is produced by `humility.mdc §Stakes filter` being
 * FOLLOWED — *"if the wrong answer costs a 30-second edit, decide it, take a
 * reasonable default, and say what you picked"* — so an agent doing exactly what
 * the always-loaded corpus requires gets warned for it. That is worse than
 * ordinary noise: it pushes toward silent decisions (drop the revisability
 * offer) or genuine deferral (ask first), both worse than the behaviour being
 * penalised.
 *
 * Measured across four independent windows before this shipped: 3 of 11 injected
 * (2026-08-16), 2 of 10 (2026-08-20), 3 of 14 (2026-08-18), and the one
 * offer-shape fire left standing on the sibling surface after mt#4311
 * (2026-08-21).
 */
export const SUPPRESSION_SETTLED_DECISION = "settled-decision";

/**
 * Reason string for the Rung-2 half of the same suppression (mt#4404).
 *
 * Deliberately DISTINCT from {@link SUPPRESSION_SETTLED_DECISION} rather than
 * reusing it. The two rungs answer the same question by different means, and a
 * calibration sweep needs to tell them apart: "Rung 1 caught it" and "the
 * embedding caught what the patterns could not" are the two numbers that decide
 * whether the climb was worth making, and a shared reason string would erase
 * exactly that difference.
 */
export const SUPPRESSION_SETTLED_DECISION_RUNG2 = "settled-decision-rung2";

// ---------------------------------------------------------------------------
// Rung 2 — embedding nomination for the settled-decision suppressor (mt#4404)
// ---------------------------------------------------------------------------

/**
 * Why this detector climbed instead of widening its regex a fourth time.
 *
 * `SETTLED_DECISION_PATTERNS` reaches one grammatical rendering of a settled
 * decision: a finite-past first-person declarative (`I picked`, `I filed`,
 * `I'm taking`). Three consecutive calibration windows each measured a DIFFERENT
 * rendering of the same behaviour still firing, and each proposed adding another
 * pattern family for it:
 *
 * - 2026-08-21 — participial lead: *"Picking X over Y … cheap to reverse if
 *   you'd rather I start elsewhere."*
 * - 2026-08-25 — conditional mood (*"I'd go with the backfill … if you'd rather
 *   stop the bleeding first"*) and default-plus-escape continuation (*"I'll keep
 *   going on the backlog diagnosis unless you'd rather I stop"*).
 * - 2026-08-26 — the participial form again, plus present progressive (*"so I'm
 *   proceeding rather than stopping to ask — say the word if you'd rather…"*).
 *
 * ADR-024 §Context names that trajectory by name: *"Each miss has historically
 * been answered by adding another regex family (R1 → R5) — an arms race."* It
 * assigns the recall/paraphrase axis to **Rung 2 — embedding recall-widening,
 * "only if paraphrase misses recur"**. Three windows is that gate, met.
 *
 * **This is the SUPPRESSOR side of the ladder, and the fail-open direction
 * inverts safely.** Every shipped Rung-2 consumer nominates to widen recall of a
 * TRIGGER; this one widens recall of a suppressor. ADR-024's cross-cutting
 * invariant — *"the hook degrades to the deterministic Rung-1 result and still
 * injects (lower precision, no missed trigger)"* — therefore needs no
 * adaptation: a degraded nomination suppresses nothing, so the false positive
 * returns rather than a genuine deferral being silenced. Injecting is the safe
 * failure for both directions, which is why the same invariant covers both.
 */
const SETTLED_DECISION_FAMILY = "settled-decision";

/**
 * Curated exemplars for the settled-decision family.
 *
 * Drawn from the measured corpus — the three calibration windows recorded on
 * mt#4404 plus `scripts/replay-settled-decision.ts`'s AT1 list — with one
 * entry per observed grammatical rendering rather than one per recorded fire.
 *
 * **Phrased WITHOUT task ids or concrete identifiers, deliberately.** The
 * embedding scores the sentence's GRAMMAR — an agent stating a choice it has
 * made and why — and seeding `mt#4391` into an exemplar would bias every score
 * toward turns that happen to cite task ids, which is most of this corpus. Same
 * reasoning as `IDENTITY_CLAIM_EXEMPLARS` in the sibling detector.
 *
 * **Each exemplar states a decision AND its reason, and none carries an
 * offer.** That asymmetry is the whole discrimination: the fires this
 * suppresses contain both a decision clause and an offer clause, and the
 * genuine deferrals in the AT2 regression floor contain only the offer. Because
 * `splitCandidateSegments` scores sentence-level segments, the decision clause
 * is scored on its own — an exemplar that included an offer would score against
 * the offer clause too and start reaching the floor.
 */
export const SETTLED_DECISION_EXEMPLARS: readonly string[] = [
  // Participial / gerund lead — no subject at all (2026-08-21, 2026-08-26).
  "Picking the first task over the second because its blocker is already cleared",
  "Proceeding on the revised shape, since it is directionally right and contained",
  "Starting the next item now; the ordering is mine and cheap to reverse",
  "Going with the smaller change first, because the larger one needs its own measurement",
  // Present progressive — subject present, tense outside the pattern list (2026-08-26).
  "I'm proceeding rather than stopping to ask, since the call is a contained one",
  "I'm stopping the watcher cycle here rather than re-arming it overnight",
  // Conditional mood — the position stated without claiming the act is done (2026-08-25).
  "I'd go with the backfill; it is quick, reversible, and moves the work forward",
  "I'd leave the merged document alone, because it reads correctly either way",
  // Default-plus-escape continuation — future tense by construction (2026-08-25).
  "I'll keep going on the diagnosis rather than stopping here",
  "I'll fix the next one after this lands, since picking the next task is mine to do",
  // Finite past — already covered by Rung 1, included so the band is measured
  // against the shape the patterns DO reach rather than only against the misses.
  "I chose the cheaper option because the expensive one needs a decision I do not have",
  "I filed the remainder separately rather than putting untested work behind an urgent fix",
];

/** The exemplar set handed to `nominate`. */
export const SETTLED_DECISION_EXEMPLAR_SET: ExemplarSet = {
  family: SETTLED_DECISION_FAMILY,
  exemplars: [...SETTLED_DECISION_EXEMPLARS],
};

/**
 * At most this many distinct match contexts are scored per turn.
 *
 * Each one costs its own `nominate` round-trip, because the suppression is
 * per-MATCH and `nominate` reports only its single best segment per family —
 * so a batched call could not say WHICH match was nominated. Measured over the
 * three windows recorded on mt#4404: every record carries one or two matches,
 * so this cap is headroom rather than a live constraint.
 */
const RUNG2_MAX_CONTEXTS = 4;

/**
 * Similarity threshold for the settled-decision family.
 *
 * **Measured on THIS corpus, not inherited.** `DEFAULT_SIMILARITY_THRESHOLD`
 * (0.455) was derived from the retrospective-trigger exemplar band, and mt#4280
 * records it under-scoring 1 of 4 ground-truth fixtures on a second corpus
 * already — a constant that has now mis-fit two corpora it was not measured on.
 * `decision-defaults.mdc §Thresholds` asks for observed cadence rather than an
 * inherited round number; `scripts/replay-settled-decision.ts --rung2` is the
 * measurement, and its output is recorded in mt#4404's spec.
 *
 * The value must separate two populations that SHARE most of their vocabulary:
 * AT1 (a decision taken, with an offer attached — must suppress) and AT2 (an
 * offer with no decision — must keep firing). Both talk about tasks, choices and
 * next steps, so the band between them is narrower than a trigger-family band
 * and the measurement matters more, not less.
 *
 * **Measured 2026-08-26** (`bun scripts/replay-settled-decision.ts --rung2`,
 * openai provider, full output in mt#4404's spec):
 *
 * - AT2 ceiling — the highest-scoring GENUINE deferral: **0.4387** (AT2.1).
 * - AT1 floor among what a floor-safe threshold reaches: **0.5901** (AT1.11).
 * - Floor-safe band therefore `0.4387 .. 0.5901`; this value is its **midpoint**,
 *   which is where the margin is equal on both sides (~0.076 each way).
 *
 * The margin is what makes the midpoint the right pick rather than a value near
 * either edge: re-running the measurement moves individual scores by ~0.006
 * (embedding nondeterminism — AT1.11 read 0.5964 then 0.5901 minutes apart), so
 * a threshold hugging either bound would flip verdicts between runs. 0.076 is an
 * order of magnitude clear of that jitter.
 *
 * **What it does NOT reach, reported rather than designed away:** four AT1 cases
 * score below the AT2 ceiling — AT1.1 (0.3072, the PASSIVE marker PR #3224 R1
 * deliberately refused to reach), AT1.5 (0.3374), AT1.6 (0.3250), and AT1.12
 * (0.4141, a subject-less past participle one word from a neutral status line).
 * Lowering the threshold to reach them would cross the AT2 floor and silence a
 * real deferral, which is the failure this detector exists to prevent. Three of
 * the four were already mt#4175's documented residual; the mechanism did not
 * make them worse.
 */
export const SETTLED_DECISION_RUNG2_THRESHOLD = 0.5144;

/**
 * Opt-in for the Rung-2 nomination path.
 *
 * Ships DISABLED, matching mt#3408's precedent for the sibling families: the
 * mechanism lands, and the threshold that decides it is measured against the
 * calibration corpus before it is allowed to change a verdict. Registered in
 * `HOOK_ONLY_ENV_VAR_CATEGORIES`.
 */
export const RUNG2_NOMINATION_ENV_VAR = "MINSKY_ARD_RUNG2_NOMINATION";

/** True when the operator has opted into the Rung-2 nomination path. */
export function isRung2NominationEnabled(): boolean {
  const raw = process.env[RUNG2_NOMINATION_ENV_VAR];
  return raw === "1" || raw?.toLowerCase() === "true" || raw?.toLowerCase() === "yes";
}

/** Outcome of scoring ONE match context against the settled-decision exemplars. */
export type SettledNominationOutcome =
  | { kind: "settled"; score: number }
  | { kind: "none" }
  | { kind: "degraded"; reason: string };

/**
 * Scores one match context. Injected in tests; built by
 * {@link createSettledDecisionNominator} in both production entrypoints.
 */
export type SettledDecisionNominator = (context: string) => Promise<SettledNominationOutcome>;

/**
 * Build the real-wired nominator.
 *
 * Deps resolve lazily and a failure LATCHES: once degraded, later calls return
 * degraded without re-attempting, so one wedged provider costs one round-trip
 * per process rather than one per turn.
 *
 * The try/catch is load-bearing rather than defensive habit. A hook is its own
 * entry point: it inherits neither the reflect polyfill nor the process-global
 * configuration, and `resolveNominationDeps` reaches the embedding factory,
 * which needs both. An escaping throw would take out the whole detector verdict
 * — the silent skip ADR-024 forbids — instead of degrading visibly.
 */
export function createSettledDecisionNominator(): SettledDecisionNominator {
  let deps: NominationDeps | null | undefined;
  let latchedFailure: string | undefined;

  return async (context: string): Promise<SettledNominationOutcome> => {
    if (latchedFailure !== undefined) return { kind: "degraded", reason: latchedFailure };

    if (deps === undefined) {
      try {
        const bootstrap = await ensureHookDomainBootstrap();
        if (!bootstrap.ok) {
          latchedFailure = "bootstrap-failed";
          return { kind: "degraded", reason: latchedFailure };
        }
        deps = await resolveNominationDeps();
      } catch (err) {
        latchedFailure = `resolve-threw: ${err instanceof Error ? err.message : String(err)}`;
        return { kind: "degraded", reason: latchedFailure };
      }
    }
    if (deps === null) {
      latchedFailure = "provider-unconfigured";
      return { kind: "degraded", reason: latchedFailure };
    }

    // PR #3395 R1. `nominate` ALREADY refuses a non-semantic provider before it
    // computes any vector (`embedding-nomination.ts`: `if (!deps.semantic)
    // return { degraded: true, degradedReason: "non-semantic-provider" }`), so
    // the reviewer's stated failure — hash-stub cosines crossing the threshold
    // and silencing a genuine deferral — cannot occur: no scores are produced
    // at all. This guard is therefore defense-in-depth, not a bug fix, and it
    // is worth the four lines for two reasons.
    //
    // It LATCHES. Without it a non-semantic provider re-enters `nominate` on
    // every turn for the life of the process, each time to be refused; with it
    // the refusal is remembered like every other failure here. And it puts the
    // safety property in the function a reader audits, rather than one layer
    // down in a shared primitive — which is where the reviewer looked for it
    // and reasonably expected to find it.
    if (!deps.semantic) {
      latchedFailure = "non-semantic-provider";
      return { kind: "degraded", reason: latchedFailure };
    }

    const result = await nominate(context, [SETTLED_DECISION_EXEMPLAR_SET], deps, {
      threshold: SETTLED_DECISION_RUNG2_THRESHOLD,
    });
    if (result.degraded) {
      latchedFailure = result.degradedReason ?? "unknown";
      return { kind: "degraded", reason: latchedFailure };
    }
    const best = result.nominations[0];
    if (best === undefined) return { kind: "none" };
    return { kind: "settled", score: best.score };
  };
}

/**
 * Drop `deferral-menu` matches whose window an embedding reads as a settled
 * decision (mt#4404) — the Rung-2 half of {@link resolveSettledDecision}.
 *
 * Runs over what Rung 1 LEFT, never instead of it: the patterns are cheaper,
 * deterministic, and already measured, so anything they catch never reaches a
 * provider round-trip. That ordering is also what makes PR #3224 R1's
 * first-person-subject contract hold by construction — this function does not
 * touch `SETTLED_DECISION_PATTERNS`, so nothing that review removed can return
 * through it.
 *
 * The `cls` guard is inherited from Rung 1 for the same load-bearing reason: a
 * settled decision does not make *"rotating that token is your call"* any less
 * the principal's, and mt#4175's `## Scope` cedes the `principal-reserved` class
 * to mt#4201.
 *
 * Never throws. A degraded nomination returns `matches` UNCHANGED with the
 * reason recorded — ADR-024's fail-to-Rung-1 invariant, which on this surface
 * means the false positive returns rather than a genuine deferral being
 * silenced.
 */
export async function resolveSettledDecisionRung2(
  matches: DeferralMatch[],
  nominator: SettledDecisionNominator | undefined
): Promise<{ remaining: DeferralMatch[]; suppressedAll: boolean; degradedReason?: string }> {
  const unchanged = { remaining: matches, suppressedAll: false };
  if (nominator === undefined || matches.length === 0) return unchanged;

  const eligible = matches.filter((m) => m.cls === "deferral-menu");
  if (eligible.length === 0) return unchanged;

  // Distinct contexts only: two phrases matched in the same sentence share a
  // window, and scoring it twice would buy nothing for a second round-trip.
  const contexts = [...new Set(eligible.map((m) => m.context))].slice(0, RUNG2_MAX_CONTEXTS);
  const settledContexts = new Set<string>();
  let degradedReason: string | undefined;

  for (const context of contexts) {
    let outcome: SettledNominationOutcome;
    try {
      outcome = await nominator(context);
    } catch (err) {
      degradedReason = `nominator-threw: ${err instanceof Error ? err.message : String(err)}`;
      break;
    }
    if (outcome.kind === "degraded") {
      degradedReason = outcome.reason;
      // The nominator latches, so every later context would return the same
      // reason. Stop rather than paying for that.
      break;
    }
    if (outcome.kind === "settled") settledContexts.add(context);
  }

  // A degradation mid-loop leaves a partial verdict. Discard it: suppressing
  // the contexts that happened to be scored before the provider failed would
  // make the outcome depend on match ordering, and this surface's safe failure
  // is to suppress nothing.
  if (degradedReason !== undefined) return { ...unchanged, degradedReason };
  if (settledContexts.size === 0) return unchanged;

  const remaining = matches.filter(
    (m) => !(m.cls === "deferral-menu" && settledContexts.has(m.context))
  );
  return { remaining, suppressedAll: remaining.length === 0 };
}

/** Short sha1, matching the Stop guard's key derivation. */
function sha1Short(input: string): string {
  return createHash("sha1").update(input).digest("hex").slice(0, 16);
}

// ---------------------------------------------------------------------------
// Sub-class types
// ---------------------------------------------------------------------------

export type DeferralClass = "principal-reserved" | "deferral-menu";

export interface DeferralMatch {
  cls: DeferralClass;
  matchedPhrase: string;
  /**
   * The sentence or clause containing `matchedPhrase` (mt#3607).
   *
   * SEPARATE from `matchedPhrase`, for the reason `pre-narration`'s equivalent
   * field records: `extractDistinctPhrases`
   * (`src/domain/calibration/calibration-sweep.ts`) keys this log's diversity
   * axis on `matches[].phrase`, and sentences are near-unique, so widening THAT
   * field would make every record distinct and destroy the count that decides
   * when this log gets reviewed.
   *
   * What it buys: ask#7052's finding was that a real deferral and a courtesy
   * offer are INDISTINGUISHABLE from the bare phrase. `"your call?"` appears
   * verbatim in both "I can't decide this — your call?" and "I've done X; want
   * Y too, or your call?" — one is the fire this detector exists for, the other
   * is the dominant false positive, and only the surrounding sentence separates
   * them.
   */
  context: string;
  /**
   * JUST the sentence containing the match (mt#4201, PR #3205 R1).
   *
   * Captured here, at match time, where `m.index` is known — NOT re-derived
   * later by searching {@link context} for {@link matchedPhrase}. The reviewer
   * caught why that mattered: a phrase recurring in the captured window makes a
   * substring search select the WRONG occurrence's sentence, and `context`
   * deliberately carries a lead sentence (`leadSentences: 1`) for exactly the
   * kind of prose where a deferral phrase repeats. Same extractor, one fewer
   * lead sentence, zero ambiguity.
   *
   * SEPARATE from `context` rather than replacing it: `context` is what a
   * calibration reviewer classifies from and its width was chosen deliberately
   * (see above). This is the narrower window the ask-citation suppression tests,
   * and only that.
   */
  sentence: string;
}

// ---------------------------------------------------------------------------
// PRINCIPAL-RESERVED patterns — a decision is being handed to the principal in
// prose. The right fix is asks_create (kind direction.decide).
// ---------------------------------------------------------------------------

export const PRINCIPAL_RESERVED_PATTERNS: RegExp[] = [
  /\bneeds?\s+your\s+call\b/i,
  /\bthat\s+decision\s+is\s+(yours|his|hers|theirs|the\s+principal[''’]?s|eugene[''’]?s)\b/i,
  /\b(reserved|that[''’]?s)\s+(for\s+)?(you|eugene|the\s+principal)\s+to\s+(decide|call)\b/i,
  /\breserved\s+for\s+(eugene|the\s+principal|you)\b/i,
  /\b(you|eugene)\s+(decide|should\s+decide|need\s+to\s+decide)\b/i,
  /\bwaiting\s+on\s+your\s+(decision|call|answer|input)\b/i,
  /\b(surface|surfacing|escalate|escalating)\s+(this\s+)?to\s+(you|eugene|the\s+principal)\b/i,
  /\b(your|the\s+principal[''’]?s)\s+(decision|call)\s+to\s+make\b/i,
  /\bbefore\s+(encoding|committing\s+to|locking\s+in)\b[^.]*\bdecision\s+is\s+(yours|his|the\s+principal[''’]?s)\b/i,
];

/**
 * Complements that NEGATE a principal-reserved phrase in place (mt#4483).
 *
 * Every pattern above matches a noun-phrase claim ("needs your call", "your
 * decision to make"). English lets the very next words invert it — "needs your
 * call ON NOTHING" asserts the opposite of what the matcher reports — and each
 * pattern looks no further than its own span, so the negated and un-negated
 * forms are indistinguishable to it. Measured at 2026-08-23T18:34:29Z: the fire
 * on `mt#4458 needs your call on nothing — it needs the daemon.` was recorded
 * with no suppression, and re-running the shipped matcher during mt#4483's
 * planning reproduced it and its un-negated control identically.
 *
 * COVERED, deliberately: the three prepositional complements the corpus
 * produced — `on nothing`, `for nothing`, `about nothing`.
 *
 * NOT covered, also deliberately — each needs a different mechanism, and none
 * has been observed in this log:
 *   - Sentence-level negation ("this does NOT need your call"): the negator
 *     PRECEDES the phrase, so no forward look can see it.
 *   - Quantifier complements ("on none of this", "on neither"): a wider
 *     complement grammar, not a token swap.
 *   - Negation separated by an intervening clause.
 *
 * Widening to any of those wants its own measured window first, per ADR-024
 * clause (b)'s "0 known-FP AND <=5% new false-negative" bar.
 *
 * PR #3330 R1: the separator class admits an em/en dash, hyphen, comma or colon
 * as well as whitespace. Anchoring on `\s*` alone left `needs your call—on
 * nothing` firing, which is the same defect this constant exists to fix and is
 * a live shape rather than a hypothetical — this corpus's prose is em-dash-heavy
 * (the originating fire itself reads `... on nothing — it needs the daemon`).
 * `.` and `;` stay OUT: they end the clause, so what follows is a new assertion
 * rather than this phrase's complement.
 *
 * This does not widen what COUNTS as a negation — `on|for|about` + `nothing` is
 * unchanged — so it cannot suppress a genuine deferral that was firing before.
 */
const NEGATING_COMPLEMENT_RE = /^[\s\-—–,:]*(?:on|for|about)\s+nothing\b/i;

/** Trailing chars a complement can occupy — `" about nothing"` is 14. */
const COMPLEMENT_LOOKAHEAD_CHARS = 24;

/**
 * The first occurrence of `pattern` in `scanned` whose immediate complement does
 * NOT negate it (mt#4483).
 *
 * Scans every occurrence rather than testing `exec`'s first. A turn can carry a
 * negated mention AND a genuine one — "needs your call on nothing here, but
 * mt#4460 needs your call on the daemon" — and moving straight to the next
 * PATTERN on a negated first hit would drop the genuine second one, trading this
 * false positive for a false negative. Returns the same `RegExpExecArray` the
 * caller already consumes, so `m.index` still addresses `scanned`.
 */
function firstUnnegatedMatch(pattern: RegExp, scanned: string): RegExpExecArray | null {
  const flags = pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`;
  const scan = new RegExp(pattern.source, flags);
  let m: RegExpExecArray | null;
  while ((m = scan.exec(scanned)) !== null) {
    const end = m.index + m[0].length;
    if (!NEGATING_COMPLEMENT_RE.test(scanned.slice(end, end + COMPLEMENT_LOOKAHEAD_CHARS))) {
      return m;
    }
    // Zero-length-match guard: without it an empty match spins forever.
    if (m.index === scan.lastIndex) scan.lastIndex += 1;
  }
  return null;
}

// ---------------------------------------------------------------------------
// DEFERRAL-MENU patterns — option-menus / "do nothing" recommendations /
// hand-back-to-desk shapes around items that are often Class A/B. The right
// fix is /classify-before-deferring FIRST, not unconditionally an ask.
// ---------------------------------------------------------------------------

/**
 * Declared ONCE and referenced from both `DEFERRAL_MENU_PATTERNS` and
 * {@link MENU_SHAPE_REQUIRED_PATTERNS}, so the gate matches by object IDENTITY
 * (PR #2359 R1). An earlier cut duplicated the literal in both arrays and
 * compared `RegExp.source` strings — editing one copy and not the other would
 * have silently detached the gate with nothing failing.
 */
const PAUSE_STOP_SELF_REPORT = /\b(I[''’]?ll|I\s+can)\s+(stop|pause)\s+here\b/i;

export const DEFERRAL_MENU_PATTERNS: RegExp[] = [
  /\bwhat[''’]?s\s+your\s+call\b/i,
  /\byour\s+call\?/i,
  /\bsay\s+the\s+word\b/i,
  PAUSE_STOP_SELF_REPORT,
  /\b(recommend|suggest)\s+(we\s+)?stop\s+here\b/i,
  /\b(want\s+me\s+to|should\s+I)\b[^.?]*\bor\b[^.?]*\?/i,
  /\bnothing\s+is\s+dropped\s+if\s+we\s+do\s+nothing\b/i,
  /\blet\s+me\s+know\s+(which|how)\s+(you[''’]?d\s+like|to\s+proceed)\b/i,
];

/**
 * The agent has ALREADY TAKEN the decision the offer would reverse (mt#4175).
 *
 * The discriminator is a completed or in-progress FIRST-PERSON action of the
 * agent's own, in the same window as the offer. The sibling
 * `operator-deferral-detector`'s `SETTLED_DECISION_PATTERNS` records the line
 * both detectors agree on: *"a completed or firmly-stated decision of the
 * agent's own is not a decision being handed over; a proposed next step is."*
 * mt#3801 owns the second half there; this array is the first half here.
 *
 * **Deliberately NOT shared with that array, and the planning note that said to
 * lift it was wrong.** Two reasons, both found by reading it: its content is
 * tuned to the SIBLING's corpus (resourcing reasons — `with fresh context`,
 * `this turn has run long`) which this corpus does not contain, so a lift would
 * have to be a merge; and mt#4175's `## Scope` puts "any other detector" out of
 * scope, so editing that file to extract the array is out of bounds for this
 * task. If the two converge later, mt#4070 is the task that argues for hoisting
 * decoration-tolerant matchers into one primitive — that is where the merge
 * belongs, with both corpora in hand.
 *
 * Matched against {@link DeferralMatch.context} — the matched sentence plus ONE
 * lead sentence — not against {@link DeferralMatch.sentence}. That scope is the
 * whole discrimination and it has a cost in both directions:
 *
 * - Too NARROW (the sentence alone) misses the measured shape where the
 *   decision sits in the preceding sentence: *"I filed mt#4243 as tracking
 *   rather than walking it to implementation … Say the word if you want it
 *   built now."*
 * - Too WIDE (the whole turn) suppresses a genuine deferral that merely shares a
 *   turn with an unrelated decision — and a long turn almost always contains
 *   one, so the wide scope silences the class this detector exists for.
 *
 * `context` is also the window a calibration reviewer classifies from, so the
 * suppression is tested at the same scope the class was MEASURED at rather than
 * at a scope chosen after the fact.
 *
 * **EVERY pattern requires a first-person subject, and that is a contract this
 * array must keep (PR #3224 R1).** A first cut carried
 * `/\b(both\s+)?recorded\s+in\b/i` to reach the one AT1 context whose marker is
 * PASSIVE — *"the reasoning and the alternative are both recorded in mt#3268."*
 * That contradicted this docblock, and the failure it bought is concrete: a
 * neutral status line in the lead sentence (*"Meeting notes recorded in
 * mt#3268."*) would silence a genuine deferral following it (*"Next. Say the
 * word and I'll plan it."*) — an AT2-floor shape suppressed by a token that
 * says nothing about who decided anything.
 *
 * It was DROPPED rather than tightened: `I recorded` is already in the
 * alternation, so nothing first-person was lost, and what WAS lost is that one
 * context, which moves into the measured residual. Reaching one more case by
 * suppressing on a subject-less token is not a trade SC1' asks for — it permits
 * a partial result, not a wrong one. A test pins the contract behaviourally
 * (passive and third-person narration must not suppress), so a future addition
 * that forgets the `I` fails rather than merely disagreeing with this comment.
 */
export const SETTLED_DECISION_PATTERNS: RegExp[] = [
  // Shared with the sibling's array by content, not by import — see above.
  /\bI\s+(picked|chose|selected|went\s+with)\b/i,
  // Measured shapes this corpus actually produced.
  /\bI[''’]?m\s+taking\b/i,
  /\bI\s+(filed|implemented|shipped|recorded|wrote)\b/i,
  /\bI\s+haven[''’]?t,?\s+since\b/i,
];

const CLASS_PATTERNS: Array<{ cls: DeferralClass; patterns: RegExp[] }> = [
  { cls: "principal-reserved", patterns: PRINCIPAL_RESERVED_PATTERNS },
  { cls: "deferral-menu", patterns: DEFERRAL_MENU_PATTERNS },
];

/**
 * Pause/stop phrases that fire ONLY alongside a menu shape in the same
 * paragraph (mt#3271). `"I'll pause here"` at the end of a turn is a completion
 * signal — the agent reporting it has finished a unit of work — not a deferral
 * of a live decision. Bare, it is the detector's most common false positive.
 *
 * Justified by what the phrases MEAN, deliberately not by the observed FP ratio:
 * that ratio is computed over calibration records whose matched text may be
 * attributed to the wrong turn (mt#3280), so it is not a sound basis for a tune.
 */
export const MENU_SHAPE_REQUIRED_PATTERNS: readonly RegExp[] = [PAUSE_STOP_SELF_REPORT];

/**
 * `recommend/suggest we stop here` is deliberately NOT gated. It is a
 * recommendation handed to the principal — the "do nothing recommendation"
 * this sub-class was built to catch — not a report that work finished. Only the
 * self-report shapes (`I'll pause here`) are completion signals. The
 * disposition named those two phrasings specifically; gating anything wider was
 * an over-reach, caught by this file's own pre-existing cases.
 */

/**
 * The four constituents of a menu shape, declared ONCE so {@link hasMenuShape}
 * and {@link findOfferShape} cannot drift apart (mt#3801) — the same
 * declare-once discipline {@link PAUSE_STOP_SELF_REPORT} carries above, for the
 * same reason.
 *
 * Each leg carries a stable LABEL instead of reporting its own matched text.
 * That is a calibration-log constraint, not cosmetics: the sweep's diversity
 * axis keys on `matches[].phrase` (see {@link DeferralMatch.context}), and the
 * disjunction leg's match — `"mt3799 or I"` — is near-unique per turn.
 * Reporting it would make every record distinct and destroy the count that
 * decides when this log gets reviewed.
 */
/**
 * Each leg additionally carries how much OFFER it supplies on its own (mt#4311).
 *
 * `unless` and `if you'd rather` NAME the reader's alternative — they cannot
 * appear without offering one, which is why mt#3801 promoted them. A bare `?`
 * or a bare `X or Y` supplies only GRAMMAR: English uses both constantly for
 * caveats, negations and technical description. Measured over three calibration
 * windows, the weak two accounted for every false fire this task was filed on.
 *
 * The distinction is consumed ONLY by {@link findOfferShape}. {@link hasMenuShape}
 * deliberately still treats all four alike, because it is a different surface
 * with the opposite direction of error — see its docblock.
 */
type MenuLegStrength = "explicit-offer" | "grammatical";

const MENU_SHAPE_LEGS: ReadonlyArray<{
  label: string;
  pattern: RegExp;
  strength: MenuLegStrength;
}> = [
  { label: "offer-shape:question", pattern: /\?/, strength: "grammatical" },
  { label: "offer-shape:or", pattern: /\b\w+\s+or\s+\w+/i, strength: "grammatical" },
  { label: "offer-shape:unless", pattern: /\bunless\b/i, strength: "explicit-offer" },
  {
    label: "offer-shape:if-you-rather",
    pattern: /\bif\s+you(['’]d|\s+would)?\s+(rather|prefer|want)\b/i,
    strength: "explicit-offer",
  },
];

/**
 * A menu shape: an explicit question, or any construction offering the reader
 * an alternative. Scoped to ONE LINE so a question elsewhere in a long report
 * cannot license a pause phrase that stands alone.
 *
 * `unless` / `if you'd rather` are included because they offer a choice without
 * a question mark or a disjunction — `"I'll stop here unless you want more"`
 * hands the continue/stop decision over just as squarely as asking would.
 *
 * KNOWN MISS, recorded rather than closed (mt#3801): the disjunction leg needs
 * a bare space before `or`, so `"Next step is mt#3799, or I can go straight at
 * it."` is not recognized — a comma breaks the `\s+`. Widening it is not a free
 * recall win, because this predicate is ALSO the suppression gate for
 * {@link MENU_SHAPE_REQUIRED_PATTERNS}, where a wider menu shape suppresses
 * LESS and therefore fires MORE. That is the false-positive direction on a
 * live-injecting guard (see {@link lineAt}, which records the same asymmetry),
 * so it needs its own evidence rather than riding along with a recall change.
 */
export function hasMenuShape(paragraph: string): boolean {
  return MENU_SHAPE_LEGS.some(({ pattern }) => pattern.test(paragraph));
}

/**
 * A first-person clause proposing an action the AGENT would take.
 *
 * The second constituent of the offer shape, and the reason
 * {@link hasMenuShape} cannot be promoted to a trigger on its own: it is TRUE
 * for `"The migration ran cleanly unless a row was locked, in which case it
 * retried."` — a factual qualifier with no offer in it and no actor at all.
 * Measured against the live matcher on 2026-08-17, not reasoned about.
 *
 * Every form here is NON-PAST by construction, which is what separates an offer
 * from a report: `"I fixed it unless a row was locked"` names a first-person
 * action, offers nothing, and matches none of them.
 */
/**
 * How much OFFER the agent-action clause itself supplies (mt#4311).
 *
 * `governed` — the clause is grammatically governed by the READER's preference:
 * `"you'd rather I clear it"`, `"want me to take it"`. The second person is
 * built into the construction, so the clause cannot occur without handing over
 * a choice. These two legs ARE an offer.
 *
 * `bare` — a first-person modal with no such governor: `"I'll stop"`,
 * `"I can test"`. This is the shape of an offer AND the shape of an ordinary
 * capability or intent report, and nothing inside the clause separates them.
 * Every false positive mt#4311 measured is of this kind.
 */
type AgentActionTier = "governed" | "bare";

const AGENT_ACTION_MATCHERS: ReadonlyArray<{ tier: AgentActionTier; pattern: RegExp }> = [
  // Contracted modal — `I'll`, `I'd`.
  { tier: "bare", pattern: /\bI\s*['’](?:ll|d)\b/i },
  // Explicit modal.
  { tier: "bare", pattern: /\bI\s+(?:can|could|will|would|should|shall)\b/i },
  // Bare verb governed by a preference token, which is where English drops the
  // modal: `"you'd rather I go straight at it"`, `"unless you prefer I hold"`.
  { tier: "governed", pattern: /\b(?:rather|prefer)\s+I\s+\w+/i },
  // The object form of the same construction. `for` is deliberately NOT in this
  // alternation (PR #3088 R1): `"for me to"` is the DESCRIPTIVE form, not an
  // offer — `"It would be unusual for me to change that"` proposes nothing, and
  // `"there is no need for me to rerun this"` is its negation. Every member
  // here takes `me` as a direct object of a volition verb, which `for` does not.
  { tier: "governed", pattern: /\b(?:want|need|prefer|like)\s+me\s+to\s+\w+/i },
];

/**
 * Negation immediately LEADING an agent-action clause (PR #3088 R1).
 *
 * Bounded to a few words because the negation has to govern the clause: in
 * `"there is no need for me to rerun"` it does, while a `not` two sentences
 * back does not. Same shape and the same reasoning as
 * `operator-deferral-detector`'s `NEGATION_LEAD_PATTERN`, declared locally
 * rather than imported because that module imports THIS one — sharing it would
 * close the cycle.
 */
const AGENT_ACTION_NEGATED_LEAD = /\b(?:no|not|never|nothing|unable|hardly)\s+(?:\w+\s+){0,2}$/i;

/** How far back {@link namesAgentAction} reads for a governing negation. */
const AGENT_ACTION_LOOKBACK_CHARS = 24;

/**
 * True when `line` proposes an action the agent itself would perform.
 *
 * **Polarity is checked, not assumed (PR #3088 R1).** The patterns above match
 * the SHAPE of a first-person action clause, and that shape is identical
 * whether the agent is offering to act or saying it will not — `"I can take
 * it"` and `"I can't reproduce it"` differ by two characters, and `\b` sits
 * between `can` and `'t`, so the modal leg matches both. A negated clause is
 * not an offer, and firing on one would put noise into a LIVE-injecting guard.
 *
 * Three forms, all measured against the live matcher rather than reasoned
 * about: a contraction directly after the match (`I can't`), an explicit `not`
 * directly after it (`I would not`), and a governing negator just before it
 * (`no need ... me to`).
 */
export function namesAgentAction(line: string): boolean {
  return matchAgentActionTier(line) !== null;
}

/**
 * The STRONGEST agent-action tier present in `line`, or null (mt#4311).
 *
 * Strongest, not first-matching: a line carrying both — `"Want me to take it?
 * I can start now"` — is governed, and returning `bare` because the bare
 * pattern is earlier in the array would silence a real offer. Array order
 * decides which PATTERN reports, never which tier wins.
 *
 * Polarity is applied per pattern before the tier counts, so a negated clause
 * contributes nothing — see {@link namesAgentAction}'s docblock for why.
 */
function matchAgentActionTier(line: string): AgentActionTier | null {
  let sawBare = false;
  for (const { tier, pattern } of AGENT_ACTION_MATCHERS) {
    const m = pattern.exec(line);
    if (!m) continue;
    const start = m.index ?? 0;
    const trailing = line.slice(start + m[0].length);
    if (/^['’]t\b/.test(trailing)) continue;
    if (/^\s+not\b/i.test(trailing)) continue;
    const lead = line.slice(Math.max(0, start - AGENT_ACTION_LOOKBACK_CHARS), start);
    if (AGENT_ACTION_NEGATED_LEAD.test(lead)) continue;
    if (tier === "governed") return "governed";
    sawBare = true;
  }
  if (!sawBare) return null;
  return INVERTED_FIRST_PERSON.test(line) ? "governed" : "bare";
}

/**
 * Subject-auxiliary inversion on a first-person clause: `"should I stop …?"`
 * (mt#4311).
 *
 * English inverts the auxiliary only to ASK, and asking about one's OWN action
 * is offering it — which is why this belongs with the governed tier rather than
 * the bare one. Found by measurement, not anticipated: replaying the live log,
 * the first cut silenced *"should I stop letting my own writing count as
 * evidence I checked something, at the cost of ~6% more interruptions?"*, a real
 * decision handed to the principal in prose, which is precisely this detector's
 * target class.
 *
 * IT UPGRADES, IT NEVER ADMITS, and the distinction is the whole safety of it.
 * The check runs only after some {@link AGENT_ACTION_MATCHERS} leg has already
 * matched, so no line that was previously invisible becomes matchable. A
 * widening here would point the false-positive way on a LIVE-injecting guard;
 * an upgrade can only preserve a fire that was already happening.
 *
 * PRECISELY WHAT IS UNCHANGED (PR #3211 R1): {@link namesAgentAction} returns
 * the SAME BOOLEAN on every input as before mt#4311 — its body did change, from
 * a direct scan to a tier computation, and an earlier draft of this comment
 * said "bit-for-bit unchanged", which is true of the behaviour and false of the
 * source. The invariant that matters: `matchAgentActionTier` returns null under
 * exactly the old condition (no matcher passed polarity), and the inversion
 * check cannot change null-ness because it runs only when `sawBare` is already
 * true. The test `inversion UPGRADES a bare clause, and admits nothing new`
 * enforces the half that could regress.
 */
const INVERTED_FIRST_PERSON = /\b(?:should|shall|can|could|would|will|may)\s+I\b/i;

/**
 * The OFFER shape: a menu handing the principal a choice about what the AGENT
 * does next (mt#3801) — `"Next step is X unless you'd rather I do Y"`.
 *
 * The CONJUNCTION is the whole mechanism, and it is deliberately not a ninth
 * entry in {@link DEFERRAL_MENU_PATTERNS}. The offer class has open-ended
 * surface forms; five sibling tasks against this file each adding one phrase is
 * the arms race ADR-024 exists to end. Both constituents already existed in
 * this file — what was missing was the relation between them, which is why this
 * is a wiring change rather than a corpus addition.
 *
 * Line-scoped for the reason {@link lineAt} records: a menu token three
 * paragraphs away from an agent-action clause was never said in one breath.
 * Returns the FIRST line satisfying both, reporting the leg's stable label.
 */
export function findOfferShape(
  text: string
): { index: number; length: number; label: string } | null {
  let offset = 0;
  for (const line of text.split("\n")) {
    const tier = matchAgentActionTier(line);
    if (tier !== null) {
      for (const { label, pattern, strength } of MENU_SHAPE_LEGS) {
        // A BARE first-person clause needs a leg that offers on its own
        // (mt#4311). Co-locating "I can test …" with a grammatical `or` on one
        // line is not an offer — measured across three calibration windows, it
        // is a caveat, a negation, or a technical description, and it was the
        // whole of this surface's false-positive population. A GOVERNED clause
        // already carries the offer, so any leg may report it, which is what
        // keeps `"Want me to file those, or a subset?"` firing.
        if (tier === "bare" && strength !== "explicit-offer") continue;
        const m = pattern.exec(line);
        if (m) return { index: offset + (m.index ?? 0), length: m[0].length, label };
      }
    }
    offset += line.length + 1;
  }
  return null;
}

/**
 * The LINE containing character `index`.
 *
 * Deliberately line-scoped rather than paragraph-scoped (PR #2359 R1). An
 * earlier cut split on blank lines, which silently assumed prose uses
 * double-newline delimiters — in single-newline text the whole report collapses
 * to one block, so any question anywhere in it would license a bare pause
 * phrase. That failure points the WRONG way for a suppression gate: a wider
 * scope finds a menu shape more often, suppresses less, and fires more — which
 * is the false-positive direction this gate exists to reduce. A line is the
 * unit that actually corresponds to "said in the same breath".
 */
export function lineAt(text: string, index: number): string {
  const start = text.lastIndexOf("\n", index);
  const end = text.indexOf("\n", index);
  return text.slice(start + 1, end === -1 ? text.length : end);
}

// ---------------------------------------------------------------------------
// Quoted/code-context suppression
// ---------------------------------------------------------------------------

/**
 * Elision implementation moved to the shared `./elision` module (mt#2672) —
 * re-exported here so this detector's public API and tests are unchanged.
 */
export { elideQuotedContexts };

// ---------------------------------------------------------------------------
// Detection (exported for testing)
// ---------------------------------------------------------------------------

/**
 * Scan assistant text for deferral phrases. Returns at most one match per
 * sub-class (first hit).
 *
 * BOTH elision helpers are applied (mt#3271). `elideQuotedContexts` covers
 * fenced blocks, inline backticks, and blockquotes; `elideDoubleQuotedSpans`
 * covers double-quoted prose, which the first deliberately does not touch.
 * Without the second, the detector fires on discussion OF ITSELF — every
 * calibration review, retrospective, PR body, and task spec quotes these
 * phrases by construction. That is not hypothetical: the 2026-07-28T19:45:31Z
 * fire on session `b5295d70` matched `"I'll pause here"` occurring ONLY as a
 * quoted example in prose about this detector. Same fix mt#3273 shipped for
 * the operator-deferral sibling.
 *
 * Patterns in {@link MENU_SHAPE_REQUIRED_PATTERNS} additionally require a menu
 * shape in the same paragraph — see that constant for why.
 */
export function detectDeferralPhrases(text: string): DeferralMatch[] {
  const scanned = elideDoubleQuotedSpans(elideQuotedContexts(text));
  const matches: DeferralMatch[] = [];
  for (const { cls, patterns } of CLASS_PATTERNS) {
    for (const pattern of patterns) {
      // mt#4483: only the principal-reserved class consults the negating
      // complement. The deferral-menu patterns are interrogative or imperative
      // shapes ("What's your call?", "say the word") where the construction does
      // not arise, and this change is scoped to one class on purpose.
      const m =
        cls === "principal-reserved"
          ? firstUnnegatedMatch(pattern, scanned)
          : pattern.exec(scanned);
      if (!m) continue;
      if (
        MENU_SHAPE_REQUIRED_PATTERNS.includes(pattern) &&
        !hasMenuShape(lineAt(scanned, m.index ?? 0))
      ) {
        continue;
      }
      matches.push({
        cls,
        matchedPhrase: m[0].trim(),
        // Captured from `scanned`, the ELIDED copy — never from `text`. Both
        // elision helpers blank their spans with same-length whitespace, so
        // `m.index` addresses the same span in `scanned`, and anything the
        // agent pasted inside a fence or a quoted span is already blanked
        // before it can reach the log (mt#3607).
        // `leadSentences: 1` — this corpus's phrases are frequently whole
        // sentences ("What's your call?"), where the containing sentence alone
        // is byte-identical between a real deferral and a courtesy offer. See
        // `MatchContextOptions.leadSentences` for the measured distribution.
        context: extractMatchContext(scanned, m.index ?? 0, m[0].length, { leadSentences: 1 }),
        // mt#4201: the same extractor with no lead sentence IS the containing
        // sentence — the forward scan already stops at the first `.`/`!`/`?`.
        sentence: extractMatchContext(scanned, m.index ?? 0, m[0].length, { leadSentences: 0 }),
      });
      break;
    }
  }
  // The structural offer trigger (mt#3801), run AFTER the literal corpus and
  // only when the menu class produced nothing. Ordering it second is what keeps
  // this change purely additive: a turn that already matches a literal pattern
  // keeps that pattern's phrase, so no existing record changes shape.
  if (!matches.some((m) => m.cls === "deferral-menu")) {
    const offer = findOfferShape(scanned);
    if (offer) {
      matches.push({
        cls: "deferral-menu",
        matchedPhrase: offer.label,
        context: extractMatchContext(scanned, offer.index, offer.length, { leadSentences: 1 }),
        sentence: extractMatchContext(scanned, offer.index, offer.length, { leadSentences: 0 }),
      });
    }
  }
  return matches;
}

/** True when the turn already routed a decision via asks_create. */
export function turnHasAsksCreate(turnLines: TranscriptLine[]): boolean {
  return extractToolUseNames(turnLines).includes(ASKS_CREATE_TOOL);
}

// ---------------------------------------------------------------------------
// Calibration logging
// ---------------------------------------------------------------------------

/**
 * Project matches into their calibration-record shape.
 *
 * Declared ONCE and used by BOTH write paths (the dispatcher-hosted guard and
 * the standalone-CLI entrypoint) deliberately: the projection was duplicated
 * literally before mt#3607, so adding `context` to one and not the other would
 * have produced a log whose records disagree about their own shape depending on
 * which path wrote them — with nothing failing.
 */
function calibrationMatches(matches: DeferralMatch[]): Array<Record<string, unknown>> {
  return matches.map((m) => ({ class: m.cls, phrase: m.matchedPhrase, context: m.context }));
}

function appendCalibrationRecord(cwd: string, record: Record<string, unknown>): void {
  // mt#4752: the shared helper derives the path from the stream NAME, so the
  // filename cannot drift from the convention the .gitignore globs encode.
  // `cwd` is the guard's raw input cwd — a FALLBACK, never an authoritative
  // root (see `calibrationLogPath`'s docblock for why the two ranks differ).
  logCalibrationRecord(CALIBRATION_LOG_NAME, record, { fallbackCwd: cwd });
}

// ---------------------------------------------------------------------------
// Reminder builder (only used when INJECTION_ENABLED)
// ---------------------------------------------------------------------------

/**
 * Longest evidence phrase this guard will RENDER, in UTF-16 code units (mt#4234).
 *
 * The unit is deliberate and was wrong in the first cut (PR #3187 R1). Bounding
 * CODE POINTS leaves the render unbounded in the unit that is actually enforced
 * and actually spent: `guard-feedback-shape.test.ts` compares `.length` against
 * the declared ceiling, and `composeAdditionalContext` spends `.length` against
 * `MERGED_CONTEXT_BUDGET_CHARS`. One emoji is one code point and two units, so a
 * 120-code-point cap admitted a 240-unit phrase and the ceiling was not a
 * ceiling for emoji-bearing prose — which is the agent's own text, and routinely
 * contains it. `truncateToRenderedLength` bounds units while never splitting a
 * surrogate pair; see its docblock for why the fix goes here rather than
 * re-denominating the ceiling.
 *
 * The evidence line exists so the agent can recognize which of its own phrases
 * tripped the guard — recognition, not reproduction. 120 is comfortably above
 * the longest phrase the live corpus produces (82 chars, the ask#6136 sample),
 * so no real match is truncated today and the bound is a ceiling rather than an
 * active trim.
 *
 * **Why a cap is REQUIRED here and not merely tidy.** `matchedPhrase` is
 * `m[0]` — the regex's whole matched span — and two patterns in this file match
 * spans bounded only by the next sentence terminator in the agent's own prose:
 * `/\b(want\s+me\s+to|should\s+I)\b[^.?]*\bor\b[^.?]*\?/i` and the
 * `before (encoding|committing to|locking in) … decision is yours` shape, both
 * via an unbounded `[^.?]*`. Rendering that span raw made the advisory grow 1:1
 * with whatever the agent wrote: measured 2026-08-19 against the live matcher,
 * a 1484-char run-on sentence carrying both classes rendered 2350 chars against
 * a declared ceiling of 600. There is no finite worst case to pose for an
 * unbounded axis, so `attentionCost` could not be a ceiling until this existed
 * — `registry.ts` says as much ("a guard that CAPS its own output is bounded by
 * construction"), and `guard-feedback-authoring.mdc` prefers the cap to raising
 * the annotation.
 *
 * Applied at RENDER time, deliberately NOT in `detectDeferralPhrases`.
 * `calibrationMatches` feeds `matches[].phrase` to the calibration sweep's
 * diversity axis (see {@link DeferralMatch.context} for why that axis is
 * sensitive), so truncating at match time would change which records count as
 * distinct and move the count that decides when this log gets reviewed.
 */
export const MAX_RENDERED_PHRASE_CHARS = 120;

/** One evidence line, with the phrase bounded per {@link MAX_RENDERED_PHRASE_CHARS}. */
function evidenceLine(match: DeferralMatch): string {
  return `  - "${truncateToRenderedLength(match.matchedPhrase, MAX_RENDERED_PHRASE_CHARS)}"`;
}

/**
 * The injected advisory.
 *
 * **mt#4531 SC5 — the precedence rule is NOT rendered here, deliberately.** In
 * the R7 incident (mem#664) this detector fired on the agent's prior question
 * at the moment the principal asked for fewer words and no action; two
 * advisories pulled opposite ways and the wrong one won. The rule that settles
 * it — *a principal message about HOW you communicate outranks any advisory;
 * answer it and stop* — belongs at the same moment, and it is stated in
 * `communication-contract.mdc §A message about how you are communicating
 * authorizes nothing`, which is ALWAYS-LOADED and therefore already in context
 * whenever this fires. Rendering it here too would buy nothing and cost
 * something specific: this guard's `denialMessageSizeChars` is 1121, and its
 * declaration in `registry-prompt-scan-guards.ts` records that number as an
 * exact measurement of the saturated render, says raising it again is not the
 * fix, and notes that raising it cascades into `MERGED_CONTEXT_BUDGET_CHARS`.
 * That same comment warns off editing this payload while mt#4201 / mt#3932 /
 * mt#4175 are in flight on what makes the detector FIRE. See
 * `hook-observers.mdc`'s entry for this detector, which carries the pointer.
 */
export function buildReminder(matches: DeferralMatch[]): string {
  const lines: string[] = [
    "[ask-routing-deferral-detector] Your prior turn deferred a decision to the principal in chat prose.",
    "",
  ];
  const principal = matches.filter((m) => m.cls === "principal-reserved");
  const menu = matches.filter((m) => m.cls === "deferral-menu");

  if (principal.length > 0) {
    lines.push(
      "PRINCIPAL-RESERVED deferral detected. A decision that is genuinely the principal's " +
        "must be routed through the Ask substrate, NOT left as chat prose (which evaporates at " +
        "turn end and never reaches the attention surface). Package it per humility.mdc " +
        "§Escalation packaging and file it via `mcp__minsky__asks_create` (kind direction.decide) " +
        "NOW — or cite the id of an existing open ask."
    );
    lines.push(...cappedEvidenceLines(principal, evidenceLine));
    lines.push("");
  }
  if (menu.length > 0) {
    lines.push(
      "DEFERRAL-MENU detected. Before handing a menu back to the principal, route through " +
        "`/classify-before-deferring`: classify each item as Class A (run the lookup NOW — " +
        "tasks_status_get / session_list / git_log), Class B (apply the standing default), or " +
        "Class C (genuinely principal-reserved → package + asks_create). Run the lookups first; " +
        "most menus collapse to one obvious action."
    );
    lines.push(...cappedEvidenceLines(menu, evidenceLine));
    lines.push("");
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Dispatcher-compatible pure function (ADR-028 D1/D2 — mt#2652 Phase 2a)
// ---------------------------------------------------------------------------

/**
 * Guard-dispatcher entry point. Mirrors `main()`'s orchestration but returns
 * a `GuardOutcome` instead of writing to stdout/`process.exit`. Reuses
 * `ctx.transcriptLines` (D6) instead of re-parsing the transcript itself.
 * Calibration is logged unconditionally on a match (mirrors `main()`'s "the
 * v1 product" comment); `additionalContext` is gated behind
 * `INJECTION_ENABLED` (`true` since the mt#2694 flip — see its doc for the
 * decision provenance).
 */
/**
 * Phrases the Stop-event untaken-action guard already injected about this same
 * closing sentence (mt#3620). Fails open to an empty set.
 *
 * `sessionId` is REQUIRED to be a real id (PR #2574 R1). The dedup store is
 * keyed per session, and `?? "unknown"` would put every session that arrives
 * without an id into ONE shared bucket — where a Stop fire in one could silence
 * a genuine deferral in another. An absent id therefore means no dedup at all,
 * which fails toward injecting.
 */
function readStopInjectedPhrases(
  sessionId: string | undefined,
  assistantText: string,
  storeDir?: string
): Set<string> {
  const injected = new Set<string>();
  if (!sessionId || !assistantText) return injected;
  try {
    const flagged = readFlagged(sessionId, storeDir);
    if (flagged.size === 0) return injected;
    const key = overlapTurnKey(assistantText, sha1Short);
    const prefix = `${key}|${STOP_INJECTED_OVERLAP_FAMILY}|`;
    for (const entry of flagged) {
      if (entry.startsWith(prefix)) injected.add(entry.slice(prefix.length));
    }
  } catch {
    // intentional-swallow: dedup is best-effort; failing open double-injects
    // rather than dropping a warning.
  }
  return injected;
}

/**
 * The mt#3620 stop-overlap decision, shared by BOTH entrypoints (dispatcher
 * `run()` and CLI `main()`).
 *
 * Extracted rather than inlined twice (PR #2574 R1): a reviewer reading either
 * copy had to trace a later `process.exit` to see whether suppression actually
 * withheld the injection. One function, one answer, and it is directly testable
 * without driving a process that exits.
 *
 * `remaining` is what to render if anything is rendered; `suppressedAll` means
 * the Stop guard already covered every matched phrase, so this guard says
 * nothing.
 */
export function resolveStopOverlap(
  sessionId: string | undefined,
  assistantText: string,
  matches: DeferralMatch[],
  storeDir?: string
): { remaining: DeferralMatch[]; suppressedAll: boolean } {
  const stopInjected = readStopInjectedPhrases(sessionId, assistantText, storeDir);
  const remaining = matches.filter((m) => !stopInjected.has(m.matchedPhrase));
  return { remaining, suppressedAll: matches.length > 0 && remaining.length === 0 };
}

/**
 * An already-filed ask, cited the two ways this corpus cites one (mt#4201).
 *
 * `ask#N` is the short-id label form and `minsky://ask/<uuid>` is the deeplink
 * target; `cockpit-deeplinks.mdc` prescribes writing BOTH as
 * `[ask#N](minsky://ask/<uuid>)`, so either alone is enough to recognize a
 * citation and neither is required to accompany the other.
 *
 * Deliberately NOT anchored to a markdown link: an unlinked bare `ask#N` is the
 * documented fallback when the uuid is not at hand, and it linkifies in the
 * cockpit anyway. Requiring the link would fire on exactly the case the deeplink
 * rule already concedes.
 */
// ADR-024 **Rung 1 — quotation/citation-aware deterministic prefilter**, which
// that ADR names as "the default stopping point" and clause (a) says the ladder
// stops at "by default; Rungs 2-3 are strictly evidence-gated". A literal
// ask-citation token test is precisely citation-aware deterministic
// prefiltering — the ADR's own words for it — so no rung escalation is argued
// and none is needed. Recorded HERE, at the mechanism, because SC2 asks for the
// rung to be named in the implementation and a PR body does not survive merge.
const ASK_CITATION_RE = /\bask#\d+\b|minsky:\/\/ask\/[0-9a-f-]{8,}/i;

/**
 * Whether a matched sentence is REPORTING a filed ask rather than deferring.
 *
 * Takes {@link DeferralMatch.sentence} — the containing sentence, captured at
 * match time — NOT the turn and NOT the wider `context`. That scope is the whole
 * discrimination, and getting it wrong in either direction has a cost:
 *
 * - Too WIDE (the `context`, which carries a lead sentence) suppresses a genuine
 *   deferral sitting beside a reported ask. Found by a failing test:
 *   *"Still yours: [ask#9275](…), whether the detector starts speaking. Want me
 *   to file the follow-up task, or should I leave it?"* — the second sentence is
 *   real work the agent could just do, and context granularity silences it.
 * - Too CLEVER (re-deriving the sentence later by searching the context for the
 *   phrase) picks the wrong occurrence when the phrase repeats — PR #3205 R1.
 *   Hence the capture at match time, where the offset is known.
 *
 * The value read is the ELIDED text, so an ask id inside a code fence or a
 * quoted span is blanked and does NOT suppress. That is correct rather than
 * incidental: quoted text is not this turn's citation, and honoring it would let
 * a pasted transcript silence a live deferral (PR #3205 R1, non-blocking).
 *
 * **The id is MATCHED, never verified to exist, and that is a decision with a
 * stated failure mode (SC5).** Verifying would mean a substrate lookup inside a
 * `UserPromptSubmit` hook: latency on every turn, and — the deciding half — a
 * DB outage would silently flip the detector back to firing on compliant
 * behaviour, which is precisely the inversion this suppression exists to end.
 * Failing OPEN toward suppression is the safe direction here.
 *
 * What match-only concedes: a fabricated `ask#9999` would suppress a real
 * deferral. That costs the fabricator and nobody else — this guard injects to
 * the agent that wrote the sentence, so gaming it is self-deception with no
 * downstream victim, and the ask substrate remains the source of truth for
 * whether a decision was actually routed.
 */
export function citesFiledAsk(sentence: string): boolean {
  return ASK_CITATION_RE.test(sentence);
}

/**
 * Drop matches whose sentence cites a filed ask (mt#4201).
 *
 * Mirrors {@link resolveStopOverlap}'s shape deliberately — same per-match
 * filter, same `suppressedAll` signal — so the two suppressions compose without
 * either needing to know about the other.
 */
export function resolveAskCitation(matches: DeferralMatch[]): {
  remaining: DeferralMatch[];
  suppressedAll: boolean;
} {
  const remaining = matches.filter((m) => !citesFiledAsk(m.sentence));
  return { remaining, suppressedAll: matches.length > 0 && remaining.length === 0 };
}

/**
 * Does this window show the agent having ALREADY taken the decision (mt#4175)?
 *
 * Takes {@link DeferralMatch.context} rather than `.sentence` — see
 * {@link SETTLED_DECISION_PATTERNS} for why that scope, and what it costs in
 * each direction.
 *
 * Scoped to `deferral-menu` at the call site below, NOT here: the
 * `principal-reserved` class is a different question, and a settled decision
 * does not make "rotating that token is your call" any less the principal's.
 * mt#4201 owns that class's suppression and this must not reach into it —
 * mt#4175's `## Scope` cedes it explicitly.
 */
export function settlesDecision(context: string): boolean {
  return SETTLED_DECISION_PATTERNS.some((p) => p.test(context));
}

/**
 * Drop `deferral-menu` matches whose window shows a decision already taken
 * (mt#4175).
 *
 * Mirrors {@link resolveAskCitation} and {@link resolveStopOverlap} — same
 * per-match filter, same `suppressedAll` signal — so the three suppressions
 * compose without any needing to know about the others.
 *
 * The `cls` guard is the load-bearing half. Without it this would silence the
 * `principal-reserved` class too, and that class's regression floor includes
 * *"Rotating that token is your call … Say the word and I'll do it."* — a
 * correctly-identified principal decision that still belongs in an ask rather
 * than in chat prose. The detector's subject is CHANNEL, not judgment.
 */
export function resolveSettledDecision(matches: DeferralMatch[]): {
  remaining: DeferralMatch[];
  suppressedAll: boolean;
} {
  const remaining = matches.filter(
    (m) => !(m.cls === "deferral-menu" && settlesDecision(m.context))
  );
  return { remaining, suppressedAll: matches.length > 0 && remaining.length === 0 };
}

/**
 * `storeDir` and `nominator` are test seams; the dispatcher passes neither.
 *
 * **This is `async` as of mt#4404, and the consumer audit is recorded here
 * rather than left to the next reader (PR #3395 R1).** The reviewer asked for
 * it and said it could not complete one; this is the result, from a repo-wide
 * grep for imports of this module:
 *
 * - **Nothing imports `run` from this module.** The four in-repo importers take
 *   `findOfferShape` (`operator-deferral-detector`, and its test),
 *   `detectDeferralPhrases` (`turn-end-untaken-action-scan`,
 *   `judged-input-capture.test`), and `SUPPRESSION_ASKS_CREATE_THIS_TURN`
 *   (`suppression-contract.test`). The two `scripts/replay-*.ts` harnesses take
 *   the resolvers and the exemplar set. None of them touches `run`.
 * - **The only production caller is the dispatcher**, through the registry's
 *   dynamic import (`registry-prompt-scan-guards.ts` →
 *   `import("./ask-routing-deferral-detector").then((m) => ({ run: m.run }))`),
 *   and it awaits: `dispatcher.ts` → `return await mod.run(input, ctx)`.
 * - **The registry's own type already permits it** —
 *   `run(...): GuardRunResult | Promise<GuardRunResult>` (`registry.ts`).
 *
 * So there is no non-dispatcher path that could receive an unawaited Promise.
 * `run-returns-a-promise` in the test file pins this: if a future change makes
 * `run` synchronous again, or a new caller forgets to await, that test is the
 * thing that notices rather than a silent no-op at prompt time.
 */
export async function run(
  input: ClaudeHookInput,
  ctx: DispatchContext,
  storeDir?: string,
  nominator: SettledDecisionNominator | undefined = isRung2NominationEnabled()
    ? createSettledDecisionNominator()
    : undefined
): Promise<GuardOutcome | null> {
  const overrideVal = process.env[OVERRIDE_ENV_VAR];
  const isOverride =
    overrideVal === "1" ||
    overrideVal?.toLowerCase() === "true" ||
    overrideVal?.toLowerCase() === "yes";

  if (isOverride) {
    return {
      auditLines: [
        `[ask-routing-deferral-detector] OVERRIDE: ack=${overrideVal} session=${input.session_id ?? "unknown"} ts=${new Date().toISOString()}\n`,
      ],
    };
  }

  if (!input.transcript_path) return null;
  const lines = ctx.transcriptLines;
  if (lines.length === 0) return null;

  let matches: DeferralMatch[] = [];
  let suppressedByAsksCreate = false;
  // Hoisted out of the try: the mt#3620 stop-overlap key derives from this same
  // text after detection.
  let assistantText = "";
  try {
    const turnLines = extractLastAssistantTurn(lines, ctx.recordedAnchor);
    if (turnLines.length === 0) return null;
    // mt#3207: detect FIRST, suppress SECOND. This gate used to return before
    // detection ran, so a deferral phrase in a turn that also routed an ask
    // left no trace anywhere — indistinguishable from a clean turn.
    suppressedByAsksCreate = turnHasAsksCreate(turnLines);
    const text = extractAssistantText(turnLines);
    if (text) {
      assistantText = text;
      matches = detectDeferralPhrases(text);
    }
  } catch (err) {
    process.stderr.write(
      `[ask-routing-deferral-detector] detection error: ${err instanceof Error ? err.message : String(err)}\n`
    );
    return null;
  }

  if (matches.length === 0) return null;

  const suppressionReasons = suppressedByAsksCreate ? [SUPPRESSION_ASKS_CREATE_THIS_TURN] : [];

  // mt#3620: the Stop-event untaken-action guard sees this same closing
  // sentence one event EARLIER — before the principal ever read it. When it has
  // already injected about a phrase, saying it again here is the second half of
  // a round-trip that already happened. Stay quiet about those phrases.
  //
  // This is the mt#3336 dedup with the yield inverted: same "one closing
  // sentence, one injection" contract, but the guard that can still prevent the
  // failure is the one that speaks. Fails open — an unreadable store or a
  // mismatched key means no suppression, i.e. the pre-mt#3336 double injection,
  // never a dropped warning.
  // mt#4201: a sentence that CITES a filed ask is reporting a routed decision,
  // not deferring one. Runs BEFORE the stop-overlap filter so the two compose on
  // the same per-match footing; `matches` itself is untouched, so the calibration
  // record still carries every detection (the mt#3207 detect-first discipline).
  //
  // Only an all-suppressed turn records a reason, matching the stop-overlap
  // convention immediately below: a reason string gates injection entirely, so
  // pushing one on a PARTIAL suppression would silence the genuine deferrals that
  // survived alongside the reported ask.
  // mt#4175: runs FIRST, so a revisability offer never reaches the later
  // filters. Chained by `remaining` like its two siblings; only an
  // all-suppressed turn records a reason, per the convention above.
  const settled = resolveSettledDecision(matches);
  if (settled.suppressedAll) {
    suppressionReasons.push(SUPPRESSION_SETTLED_DECISION);
  }

  // mt#4404: Rung 2 runs over what Rung 1 LEFT, and only when the operator has
  // opted in. Chained by `remaining` like every sibling below it; its own reason
  // string keeps the two rungs separable in the calibration log.
  const settledRung2 = await resolveSettledDecisionRung2(settled.remaining, nominator);
  if (settledRung2.suppressedAll) {
    suppressionReasons.push(SUPPRESSION_SETTLED_DECISION_RUNG2);
  }

  const askCited = resolveAskCitation(settledRung2.remaining);
  if (askCited.suppressedAll) {
    suppressionReasons.push(SUPPRESSION_CITES_FILED_ASK);
  }

  const { remaining, suppressedAll } = resolveStopOverlap(
    input.session_id,
    assistantText,
    askCited.remaining,
    storeDir
  );
  if (suppressedAll) {
    suppressionReasons.push(SUPPRESSION_STOP_GUARD_ALREADY_INJECTED);
  }

  const outcome: GuardOutcome = {
    calibration: {
      timestamp: new Date().toISOString(),
      session_id: input.session_id,
      injection_enabled: INJECTION_ENABLED,
      [CAPTURE_SCHEMA_FIELD]: CAPTURE_SCHEMA_VERSION,
      matches: calibrationMatches(matches),
      suppressionReasons,
      // ADR-024's degraded MARKER. Present only when a nomination was attempted
      // and could not complete, so a sweep can tell "Rung 2 found nothing" from
      // "Rung 2 never ran" — which are the same empty verdict without it.
      ...(settledRung2.degradedReason !== undefined
        ? { rung2DegradedReason: settledRung2.degradedReason }
        : {}),
    },
  };

  if (INJECTION_ENABLED && suppressionReasons.length === 0) {
    outcome.additionalContext = buildReminder(remaining);
  }

  return outcome;
}

// ---------------------------------------------------------------------------
// Entrypoint
// ---------------------------------------------------------------------------

export async function main(): Promise<void> {
  const overrideVal = process.env[OVERRIDE_ENV_VAR];
  const isOverride =
    overrideVal === "1" ||
    overrideVal?.toLowerCase() === "true" ||
    overrideVal?.toLowerCase() === "yes";

  let input: ClaudeHookInput;
  try {
    input = await readInput<ClaudeHookInput>();
  } catch {
    process.exit(0);
  }

  if (isOverride) {
    const ts = new Date().toISOString();
    process.stdout.write(
      `[ask-routing-deferral-detector] OVERRIDE: ack=${overrideVal} session=${input.session_id ?? "unknown"} ts=${ts}\n`
    );
    process.exit(0);
  }

  const transcriptPath = input.transcript_path;
  if (!transcriptPath) {
    process.exit(0);
  }

  let lines: TranscriptLine[];
  try {
    lines = resolveParentTranscriptLinesForPath(transcriptPath, input.agent_id);
  } catch {
    process.exit(0);
  }
  if (lines.length === 0) {
    process.exit(0);
  }

  let matches: DeferralMatch[] = [];
  let suppressedByAsksCreate = false;
  let assistantText = "";
  try {
    const turnLines = extractLastAssistantTurn(lines);
    if (turnLines.length === 0) {
      process.exit(0);
    }
    // mt#3207: detect FIRST, suppress SECOND (mirrors `run()`). Suppression
    // still withholds the injection below; what changed is that the suppressed
    // detection is now recorded instead of vanishing.
    suppressedByAsksCreate = turnHasAsksCreate(turnLines);
    const text = extractAssistantText(turnLines);
    if (text) {
      assistantText = text;
      matches = detectDeferralPhrases(text);
    }
  } catch (err) {
    // Fail-open: never block the prompt.
    process.stderr.write(
      `[ask-routing-deferral-detector] detection error: ${err instanceof Error ? err.message : String(err)}\n`
    );
    process.exit(0);
  }

  if (matches.length === 0) {
    process.exit(0);
  }

  const suppressionReasons = suppressedByAsksCreate ? [SUPPRESSION_ASKS_CREATE_THIS_TURN] : [];

  // mt#3620 — the SAME decision function `run()` uses. This CLI path renders the
  // same surface, and a fix wired into only one of the two entrypoints is the
  // mt#3270 R1 shape. `suppressedAll` feeds the shared
  // `suppressionReasons.length > 0` exit below, which is what actually withholds
  // the injection.
  // mt#4201, mirroring `run()` above — this file's two write paths must not
  // disagree about what suppresses (the mt#3607 declared-once discipline).
  // mt#4175: runs FIRST, so a revisability offer never reaches the later
  // filters. Chained by `remaining` like its two siblings; only an
  // all-suppressed turn records a reason, per the convention above.
  const settled = resolveSettledDecision(matches);
  if (settled.suppressedAll) {
    suppressionReasons.push(SUPPRESSION_SETTLED_DECISION);
  }

  // mt#4404 — the SAME Rung-2 decision function `run()` uses, for the same
  // reason the three suppressions above are shared: a fix wired into only one of
  // this file's two write paths is the mt#3270 R1 shape.
  const settledRung2 = await resolveSettledDecisionRung2(
    settled.remaining,
    isRung2NominationEnabled() ? createSettledDecisionNominator() : undefined
  );
  if (settledRung2.suppressedAll) {
    suppressionReasons.push(SUPPRESSION_SETTLED_DECISION_RUNG2);
  }

  const askCited = resolveAskCitation(settledRung2.remaining);
  if (askCited.suppressedAll) {
    suppressionReasons.push(SUPPRESSION_CITES_FILED_ASK);
  }

  const { remaining, suppressedAll } = resolveStopOverlap(
    input.session_id,
    assistantText,
    askCited.remaining
  );
  if (suppressedAll) {
    suppressionReasons.push(SUPPRESSION_STOP_GUARD_ALREADY_INJECTED);
  }

  // Calibration record (always — this is the v1 product). mt#3207: "always"
  // now includes the suppressed fire, which used to exit above this line.
  appendCalibrationRecord(input.cwd, {
    timestamp: new Date().toISOString(),
    session_id: input.session_id,
    injection_enabled: INJECTION_ENABLED,
    [CAPTURE_SCHEMA_FIELD]: CAPTURE_SCHEMA_VERSION,
    matches: calibrationMatches(matches),
    suppressionReasons,
    ...(settledRung2.degradedReason !== undefined
      ? { rung2DegradedReason: settledRung2.degradedReason }
      : {}),
  });

  // Calibration-first: inject only when the gate is flipped on, and never for
  // a suppressed fire.
  if (!INJECTION_ENABLED || suppressionReasons.length > 0) {
    process.exit(0);
  }

  const output: HookOutput = {
    hookSpecificOutput: {
      hookEventName: "UserPromptSubmit",
      additionalContext: buildReminder(remaining),
    },
  };
  process.stdout.write(JSON.stringify(output));
  process.exit(0);
}

if (import.meta.main) {
  main();
}
