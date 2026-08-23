/**
 * Rung-2 basis recognition for the bare-prohibition detector (mt#3861).
 *
 * ## What this is, in ADR-024's terms
 *
 * `BASIS_PATTERNS` recognizes a basis only when it carries a MARKER — a causal
 * connective, an explanatory colon, or a citation. A basis stated as a plain
 * adjacent declarative sentence carries none, so it reads as `hasBasis: false`
 * and the detector fires. Two prompts of identical meaning get opposite verdicts
 * when one window happens to contain a backtick.
 *
 * That is a **recall miss of the BASIS predicate**, which is ADR-024's Rung 2
 * ("embedding recall-widening (only if paraphrase misses recur)"). It presents
 * as a PRECISION failure of the detector only because the predicate is consumed
 * as a suppressor: widening basis recall ⇒ fewer false fires. One axis, two
 * ends — see mt#3861's `## Planning pass 2026-08-16 (second)`, which retracts an
 * earlier reading of this as a Rung-2-for-precision override.
 *
 * ## Why it lives here rather than inside `analyzeNegativeConstraints`
 *
 * That function is SYNCHRONOUS and has four consumer classes — the dispatch
 * hook, its generated `.claude/hooks` copy, a second `.codex/hooks` copy, and
 * `src/adapters/shared/commands/tasks/dispatch-command.ts`, which runs inside
 * the MCP server on every `tasks_dispatch`. Making it async to fit an embedding
 * round-trip would push that round-trip into all four. Keeping the Rung-1
 * verdict synchronous and offering this as a stage the CALLER composes lets each
 * consumer decide on its own latency budget, and leaves every existing call site
 * working unchanged.
 *
 * ## Fail direction
 *
 * On ANY failure this returns the input report untouched — the Rung-1 verdict.
 * Because this predicate suppresses, that means MORE fires, not fewer, which is
 * exactly ADR-024's invariant: "the hook degrades to the deterministic Rung-1
 * result and _still injects_ (lower precision, no missed trigger)". Silent
 * suppression is the one direction forbidden here.
 *
 * @see docs/architecture/adr-024-detection-mechanism-ladder-for-guidance-hooks.md
 * @see packages/domain/src/detectors/embedding-nomination.ts — the shared primitive
 */

import {
  nominate,
  type DegradedReason,
  type ExemplarSet,
  type NominationDeps,
} from "../detectors/embedding-nomination";
import { BASIS_WINDOW_CHARS, type NegativeConstraintReport } from "./negative-constraint";

/** Family name carried on nominations, for the calibration record. */
export const BASIS_FAMILY = "basis";

/**
 * Curated exemplars of a sentence that STATES THE BASIS for a prohibition.
 *
 * Sampled from real dispatch prose and real calibration records rather than
 * invented (mem#1020: a fixture that reaches no matcher is silently inert, and
 * paraphrasing is what writing prose IS). Each entry below is either lifted
 * verbatim from `.minsky/bare-prohibition-calibration.jsonl` / the recovered
 * mt#3120 prompt, or is the minimal generalization of one such record.
 *
 * The set spans the shapes a marker-free basis actually takes:
 *
 *  1. An empirical negative result — the thing was checked and is not there.
 *  2. A guard / policy citation — a named mechanism forbids it.
 *  3. A prior-measurement citation — it was tried and measured.
 *  4. A structural-impossibility statement — the surface does not exist.
 *
 * DELIBERATELY SMALL. ADR-024 specifies "a small curated exemplar set per
 * family"; a large set drifts toward matching all prose, which is the
 * nullification mt#3861's criterion 3 rejected two regex candidates for.
 */
export const BASIS_EXEMPLARS: readonly string[] = [
  // (1) empirical negative result — the 2026-08-08 fire's own basis sentence, verbatim
  "NEGATIVE RESULT: no public API surface for a third party to attach an alternate UI to an Anthropic Remote Control session.",
  "I checked the provider's API and it exposes no endpoint for this.",
  // (2) guard / policy citation
  "Reading that file is blocked by the secret-file-read guard.",
  "The merge gate denies this unless the review has concluded.",
  // (3) prior-measurement citation
  "We measured this approach at 8 of 8 false positives and retired it.",
  "The previous attempt timed out on every run, which is why it was abandoned.",
  // (4) structural impossibility
  "The transcript does not carry that field, so it cannot be derived downstream.",
  "There is no caller-visible signal for the actual value.",
];

export interface BasisRefinementOptions {
  timeoutMs?: number;
  threshold?: number;
}

export interface BasisRefinementResult {
  /** The report, with any nominated finding flipped to `hasBasis: true` and dropped from `bare`. */
  report: NegativeConstraintReport;
  /** True when the nomination stage could not run; the report is then the untouched Rung-1 result. */
  degraded: boolean;
  degradedReason?: DegradedReason;
  /** How many findings the stage flipped from bare to basis-bearing. */
  refinedCount: number;
}

/**
 * Widen basis recognition over the findings Rung 1 marked BARE.
 *
 * Only the bare findings are considered: Rung 1 already recognized a basis for
 * the rest, and re-examining them could only ever REMOVE a basis, which this
 * stage is not permitted to do. That also keeps the batch small — bare findings
 * are a small minority of matches (5 of 82 on mt#3861's measured corpus).
 *
 * `deps === null` (an unconfigured or unconstructable provider) is a degraded
 * path, not an error — see the module header on fail direction.
 */
export async function refineBasisWithNomination(
  report: NegativeConstraintReport,
  text: string,
  deps: NominationDeps | null,
  options: BasisRefinementOptions = {}
): Promise<BasisRefinementResult> {
  if (deps === null) {
    return { report, degraded: true, degradedReason: "provider-unconfigured", refinedCount: 0 };
  }
  if (report.bare.length === 0) {
    // Nothing Rung 1 left bare — no work, and not a degradation.
    return { report, degraded: false, refinedCount: 0 };
  }

  const exemplarSets: ExemplarSet[] = [{ family: BASIS_FAMILY, exemplars: [...BASIS_EXEMPLARS] }];

  const refinedIndexes = new Set<number>();
  let degraded = false;
  let degradedReason: DegradedReason | undefined;

  for (const finding of report.bare) {
    // Same bidirectional window Rung 1 scored, so the two rungs see identical
    // evidence and differ only in how they judge it.
    const windowStart = Math.max(0, finding.index - BASIS_WINDOW_CHARS);
    const window = text.slice(windowStart, finding.index + BASIS_WINDOW_CHARS);

    const result = await nominate(window, exemplarSets, deps, {
      timeoutMs: options.timeoutMs,
      threshold: options.threshold,
    });

    if (result.degraded) {
      // Stop, and DISCARD any positives found before this point (PR #3033 R1
      // asked whether those are lost — they are, deliberately). Two reasons,
      // and the second is the stronger one:
      //
      //  1. ADR-024's fail-to-Rung-1 invariant. This predicate SUPPRESSES, so
      //     applying a partial result would suppress some fires on incomplete
      //     evidence. Degrading must cost precision, never a missed trigger.
      //  2. Determinism. Applying whatever happened to be scored before the
      //     provider died makes the verdict depend on WHERE the failure landed
      //     — the same prompt would get different verdicts across runs. A
      //     detector whose output varies with a transient is worse than one
      //     that degrades cleanly to its deterministic rung.
      //
      // Breaking rather than continuing also keeps the round-trips within the
      // 10s budget the consuming guards declare in `registry.ts`.
      degraded = true;
      degradedReason = result.degradedReason;
      break;
    }
    if (result.nominations.length > 0) refinedIndexes.add(finding.index);
  }

  if (degraded || refinedIndexes.size === 0) {
    return { report, degraded, degradedReason, refinedCount: 0 };
  }

  const findings = report.findings.map((f) =>
    refinedIndexes.has(f.index) ? { ...f, hasBasis: true } : f
  );

  return {
    report: {
      ...report,
      findings,
      bare: findings.filter((f) => !f.hasBasis),
    },
    degraded: false,
    refinedCount: refinedIndexes.size,
  };
}
