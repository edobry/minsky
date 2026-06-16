/**
 * Evidence-gated actions — the shared tool-boundary evidence-argument primitive (mt#2488).
 *
 * Tier-1 of the mt#2485 stakes-tiered re-partition of the "assertion frozen as fact
 * without verification" family (root memory `3772c77d`). The thesis: any claim that
 * authorizes a consequential / irreversible tool call must be supplied to the tool as a
 * STRUCTURED argument the tool validates mechanically — NOT asserted in prose that a
 * downstream detector then has to catch. A prose detector has to make the same
 * discrimination the model just failed to make (an Ashby requisite-variety violation,
 * memory `c437ed0e`); a hard checkpoint at the action boundary does not — it just
 * requires the evidence to be present and well-formed before the action proceeds.
 *
 * The reference instance is the mt#2215 `session_pr_merge forceBypass` gate
 * (`packages/domain/src/session/session-merge-operations.ts`): it requires a non-empty
 * `bypassReason` + structural preconditions and writes an audit signature into the merge
 * commit. This module generalizes that shape so a future consequential tool can adopt it
 * by calling {@link validateEvidenceArgument} at its boundary.
 *
 * See the mt#2488 spec for the full design note and the enumeration of consequential
 * actions in scope.
 */
import { ValidationError } from "../errors";

/**
 * A structured premise plus its cheapest-falsifier check, supplied by the CALLER to
 * justify a consequential action.
 *
 * - `claim` — the load-bearing assumption the action rests on.
 * - `falsifier` — the cheapest check that would DISPROVE the claim if it were false.
 * - `evidence` — the result of actually running that falsifier.
 *
 * For an action with no diagnostic premise the caller still states the basis — e.g.
 * claim "greenfield work; the spec fully specifies the acceptance criteria", falsifier
 * "the spec is ambiguous on the acceptance criteria", evidence "re-read spec
 * §Acceptance Tests — each criterion is independently checkable". The gate cannot force
 * honesty, but it forces the caller to articulate-and-check the premise the same way
 * `bypassReason` forces the bypass rationale.
 */
export interface EvidenceArgument {
  claim: string;
  falsifier: string;
  evidence: string;
}

/**
 * Minimum substantive length (trimmed chars) for each evidence field. Tuned to reject
 * placeholder no-ops ("n/a", "none", "ok", "tbd") while accepting a terse-but-real check
 * like "check main CI" — roughly "a few words," not a single token. The gate cannot force
 * honesty, only presence + a substance floor.
 */
export const MIN_EVIDENCE_FIELD_LENGTH = 12;

export interface ValidateEvidenceOptions {
  /** Action name surfaced in the error message (e.g. "tasks_dispatch"). */
  action: string;
  /**
   * Optional per-action structural check, run after the generic non-emptiness check.
   * Return a non-empty error string to reject; return null/undefined to accept.
   */
  structuralCheck?: (arg: EvidenceArgument) => string | null | undefined;
}

/**
 * Validate an evidence argument at a tool boundary. Mirrors the mt#2215 `forceBypass`
 * gate: throws {@link ValidationError} when the argument is absent or any field is empty
 * or below the substance floor ({@link MIN_EVIDENCE_FIELD_LENGTH}). Returns the
 * normalized (trimmed) argument on success so callers can write it into an audit trail.
 */
export function validateEvidenceArgument(
  arg: Partial<EvidenceArgument> | undefined | null,
  opts: ValidateEvidenceOptions
): EvidenceArgument {
  const { action } = opts;

  if (!arg || typeof arg !== "object") {
    throw new ValidationError(
      `❌ ${action} requires an evidence argument (the premise this action rests on). ` +
        `Provide { claim, falsifier, evidence }: the load-bearing assumption, the cheapest ` +
        `check that would disprove it, and the result of actually running that check.`
    );
  }

  const claim = (arg.claim ?? "").trim();
  const falsifier = (arg.falsifier ?? "").trim();
  const evidence = (arg.evidence ?? "").trim();

  const weak: string[] = [];
  if (claim.length < MIN_EVIDENCE_FIELD_LENGTH) weak.push("claim");
  if (falsifier.length < MIN_EVIDENCE_FIELD_LENGTH) weak.push("falsifier");
  if (evidence.length < MIN_EVIDENCE_FIELD_LENGTH) weak.push("evidence");
  if (weak.length > 0) {
    throw new ValidationError(
      `❌ ${action}: the evidence argument is not well-formed — ${weak.join(", ")} ` +
        `${weak.length === 1 ? "is" : "are"} empty or too short (min ${MIN_EVIDENCE_FIELD_LENGTH} ` +
        `chars each). claim = the load-bearing assumption justifying this action; ` +
        `falsifier = the cheapest check that would disprove it; evidence = the result of ` +
        `actually running that check.`
    );
  }

  const normalized: EvidenceArgument = { claim, falsifier, evidence };

  const structuralError = opts.structuralCheck?.(normalized);
  if (structuralError) {
    throw new ValidationError(`❌ ${action}: ${structuralError}`);
  }

  return normalized;
}
