/**
 * Operator-response labeling — pure logic module (mt#3583, ADR-032 §D2).
 *
 * Derives, for each guard fire, whether the guidance changed behavior:
 * `heeded`, `dismissed`, or `unknown`. That label is the input
 * `proposeThresholdAdjustment` (`./threshold-tuning.ts`) needs and which
 * nothing produced before this module — ADR-032 shipped the decider inert
 * precisely because this half did not exist.
 *
 * ALL functions here are pure (no fs, no DB, no clock) — the same split
 * `calibration-sweep.ts`, `rationalization-review.ts`, and `threshold-tuning.ts`
 * already follow. Reading the evaluation stream off disk belongs to the caller.
 *
 * ## Why this reads EVALUATIONS, not fires
 *
 * A fire-only corpus can express `dismissed` (the guard fired again, so the
 * guidance did not land) but can never express `heeded` — every detector writes
 * its calibration record only on a match, so an evaluation that did NOT fire
 * leaves no trace. The fire log's `allow` records do not fill the gap: for a
 * guard that runs on every `UserPromptSubmit`, `allow` conflates "evaluated and
 * complied" with "not applicable this turn."
 *
 * That asymmetry is not a cosmetic gap. `proposeThresholdAdjustment` computes
 * `dismissed / labeled` and refuses to move below a 20% budget; if `heeded` is
 * unrepresentable that ratio is always 1, the budget check goes vacuous, and the
 * heeded-clamp never engages — a tuner that raises the threshold on any guard
 * firing five times in a session. The decider's safety properties are
 * load-bearing on both labels existing, so the emit path records every
 * EVALUATION and this module reads that stream.
 *
 * @see docs/architecture/adr-032-guard-threshold-tuning-loop.md §D2
 * @see src/domain/calibration/threshold-tuning.ts — the consumer
 */

import type { ObservationResponse, ThresholdObservation } from "./threshold-tuning";

// ---------------------------------------------------------------------------
// Input shape
// ---------------------------------------------------------------------------

/**
 * One evaluation of one guard — written whether or not the guard fired.
 *
 * Structurally duplicated from the hook-side emit shape rather than imported:
 * `.minsky/hooks/` is dependency-free by `SPEC.md` invariant and `src/` does not
 * cross-import it (the precedent `rationalization-review.ts`'s `RawFireRecord`
 * follows). Drift between the two is undetected repo-wide — tracked at mt#3586.
 */
export interface GuardEvaluation {
  /** ISO-8601. */
  timestamp: string;
  guardName: string;
  /**
   * The conversation this evaluation belongs to. Labels are derived WITHIN a
   * session only: "the agent kept doing it" is a claim about one continuous
   * exchange, and two different conversations say nothing about each other.
   * An evaluation with no session id cannot be sequenced and is dropped.
   */
  sessionId: string | null | undefined;
  /**
   * The value the guard compared against its threshold. Null when the guard has
   * no numeric decision input — such a guard can still be labeled (fired-again
   * is still fired-again) but supplies no `observedValue` downstream.
   */
  observedValue: number | null;
  /** Whether this evaluation produced a fire (guidance was actually delivered). */
  fired: boolean;
}

export interface LabeledFire {
  timestamp: string;
  guardName: string;
  sessionId: string;
  observedValue: number | null;
  response: ObservationResponse;
  /** Why the label came out this way — named, never a score. */
  basis: LabelBasis;
}

export type LabelBasis =
  | "next-evaluation-fired"
  | "next-evaluation-did-not-fire"
  | "no-subsequent-evaluation"
  | "no-session-id";

// ---------------------------------------------------------------------------
// Labeling
// ---------------------------------------------------------------------------

const BASIS_TO_RESPONSE: Record<LabelBasis, ObservationResponse> = {
  "next-evaluation-fired": "dismissed",
  "next-evaluation-did-not-fire": "heeded",
  "no-subsequent-evaluation": "unknown",
  "no-session-id": "unknown",
};

/** Stable sort by timestamp; unparseable timestamps sort last and never become an anchor. */
function byTimestamp(a: { timestamp: string }, b: { timestamp: string }): number {
  const ta = Date.parse(a.timestamp);
  const tb = Date.parse(b.timestamp);
  const va = Number.isFinite(ta);
  const vb = Number.isFinite(tb);
  if (!va && !vb) return 0;
  if (!va) return 1;
  if (!vb) return -1;
  return ta - tb;
}

function groupKey(evaluation: GuardEvaluation): string | null {
  const sessionId = evaluation.sessionId;
  if (typeof sessionId !== "string" || sessionId.trim() === "") return null;
  // A printable separator, not a NUL: guard names and session ids never contain
  // a pipe, and the pre-commit NUL check blocks the invisible alternative.
  return `${evaluation.guardName}|${sessionId}`;
}

/**
 * Label every FIRE in the corpus against the evaluation that follows it.
 *
 * The rule, in full: within one guard and one session, ordered by time, a fire
 * is `dismissed` when the next evaluation also fired, `heeded` when the next
 * evaluation did not, and `unknown` when nothing follows it.
 *
 * **What this does and does not establish.** "The next evaluation did not fire"
 * is evidence the agent had another turn and stayed under the threshold — it is
 * NOT proof the agent read the guidance, and a turn that simply had no occasion
 * to trip the guard reads the same way. The label is deliberately noisy-but-
 * unbiased rather than clever: it makes no attempt to judge comparability,
 * because every rule for doing so requires a magic number, and the accuracy this
 * actually achieves is a MEASURED quantity (this task's Success Criterion 2,
 * against ADR-024's sign-off (b) bar) rather than an asserted one. If it misses
 * that bar, the honest outcome is that this rung is insufficient — not a
 * threshold tuned to hide it.
 *
 * Non-fire evaluations are never themselves labeled; they exist only as the
 * evidence that labels the fire before them.
 */
export function labelFires(evaluations: GuardEvaluation[]): LabeledFire[] {
  const groups = new Map<string, GuardEvaluation[]>();
  const orphanedFires: GuardEvaluation[] = [];

  for (const evaluation of evaluations) {
    const key = groupKey(evaluation);
    if (key === null) {
      if (evaluation.fired) orphanedFires.push(evaluation);
      continue;
    }
    const bucket = groups.get(key);
    if (bucket) bucket.push(evaluation);
    else groups.set(key, [evaluation]);
  }

  const labeled: LabeledFire[] = [];

  for (const bucket of groups.values()) {
    const ordered = [...bucket].sort(byTimestamp);
    for (let i = 0; i < ordered.length; i++) {
      const evaluation = ordered[i];
      if (!evaluation || !evaluation.fired) continue;

      const next = ordered[i + 1];
      const basis: LabelBasis =
        next === undefined
          ? "no-subsequent-evaluation"
          : next.fired
            ? "next-evaluation-fired"
            : "next-evaluation-did-not-fire";

      labeled.push({
        timestamp: evaluation.timestamp,
        guardName: evaluation.guardName,
        // Non-null by construction: groupKey() returned a key for this bucket.
        sessionId: String(evaluation.sessionId),
        observedValue: evaluation.observedValue,
        response: BASIS_TO_RESPONSE[basis],
        basis,
      });
    }
  }

  for (const evaluation of orphanedFires) {
    labeled.push({
      timestamp: evaluation.timestamp,
      guardName: evaluation.guardName,
      sessionId: "",
      observedValue: evaluation.observedValue,
      response: BASIS_TO_RESPONSE["no-session-id"],
      basis: "no-session-id",
    });
  }

  return labeled.sort(byTimestamp);
}

// ---------------------------------------------------------------------------
// Adapter to the decider's input
// ---------------------------------------------------------------------------

/**
 * Convert labeled fires into the shape `proposeThresholdAdjustment` consumes.
 *
 * Fires with no numeric `observedValue` are DROPPED rather than coerced: a
 * threshold move is computed as a percentile over observed values, and a
 * placeholder zero would drag every proposal toward it. A guard with no numeric
 * decision input simply cannot feed the tuner — which is the documented
 * reason-why-not this task's Success Criterion 1 allows, not a silent skip.
 */
export function toThresholdObservations(
  labeled: LabeledFire[],
  guardName: string
): ThresholdObservation[] {
  return labeled
    .filter((fire) => fire.guardName === guardName && fire.observedValue !== null)
    .map((fire) => ({
      timestamp: fire.timestamp,
      // Non-null by the filter above.
      observedValue: fire.observedValue as number,
      response: fire.response,
    }));
}

/** Count labels by response — the sample sizes a measurement pass reports. */
export function summarizeLabels(labeled: LabeledFire[]): Record<ObservationResponse, number> {
  const counts: Record<ObservationResponse, number> = { heeded: 0, dismissed: 0, unknown: 0 };
  for (const fire of labeled) counts[fire.response] += 1;
  return counts;
}
