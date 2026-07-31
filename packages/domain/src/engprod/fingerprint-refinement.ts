/**
 * Fingerprint-refined clustering (mt#3429, SC2).
 *
 * A name-level cluster (e.g. "Bash -> Bash", 6,628 occurrences / 407
 * sessions in the v1 production gate run) only tells you the SAME TOOL was
 * called twice in a row — it says nothing about whether those calls were
 * the SAME COMMAND repeated (a genuinely automatable primitive: "the same
 * jq pipeline 50x") or unrelated ad-hoc commands that happen to share a
 * tool name. `arg_fingerprint` (a stable hash of the normalized tool-call
 * input, NEVER the raw arguments — see
 * `agent-tool-call-projection-schema.ts`) is exactly the signal that tells
 * these apart, and v1 left it unused in cluster identity (mt#3330 Outcome,
 * defect 2).
 *
 * This module makes that decision from a `FingerprintProfile` already
 * computed during mining (`sequence-mining.ts`'s single-pass aggregation,
 * mt#3429 — no second query, no raw-argument access):
 *
 * - If the cluster's DOMINANT fingerprint sequence covers at least
 *   `threshold` of its occurrences, that sub-pattern IS the real signal —
 *   propose the REFINED cluster (its own signature, frequency, sessions,
 *   and sample refs) instead of the generic name-level one.
 * - Otherwise the generic cluster carries no primitive-level signal at all
 *   (its occurrences are just noise sharing a tool name) and is EXCLUDED
 *   from the LLM stage entirely — never sent generically, per spec SC2's
 *   "distinctiveness floor."
 *
 * @see types.ts — FingerprintProfile, MinedCluster.argFingerprintSequence
 * @see sequence-mining.ts — computeRefinedClusterSignature, mineClusters
 */

import { computeRefinedClusterSignature } from "./sequence-mining";
import type { MinedCluster } from "./types";

/** Default concentration floor (spec SC2: "~20%") — configurable via `refineCluster`'s `threshold` param. */
export const DEFAULT_FINGERPRINT_CONCENTRATION_THRESHOLD = 0.2;

export type RefinementOutcome =
  | { kind: "refined"; cluster: MinedCluster; concentration: number }
  | { kind: "excluded"; concentration: number };

/**
 * Decide whether a (maximal, name-level) cluster should be replaced by its
 * fingerprint-refined sub-cluster, or excluded from the LLM stage entirely
 * for lacking a distinctive fingerprint sub-pattern.
 *
 * A cluster with no `fingerprintProfile` at all (e.g. a hand-built test
 * fixture, or — defensively — a corpus row whose fingerprint somehow never
 * populated) is treated as `concentration: 0` and excluded, matching the
 * "no distinctive sub-pattern observed" case rather than silently
 * defaulting to "propose the generic form" (which would resurrect the v1
 * defect this task fixes).
 */
export function refineCluster(
  cluster: MinedCluster,
  threshold: number = DEFAULT_FINGERPRINT_CONCENTRATION_THRESHOLD
): RefinementOutcome {
  const profile = cluster.fingerprintProfile;
  if (!profile || cluster.frequency <= 0) {
    return { kind: "excluded", concentration: 0 };
  }

  if (profile.concentration >= threshold) {
    const refined: MinedCluster = {
      ...cluster,
      signature: computeRefinedClusterSignature(cluster.toolSequence, profile.sequence),
      frequency: profile.frequency,
      sessionCount: profile.sessionCount,
      score: profile.frequency * profile.sessionCount * cluster.chainLength,
      sampleRefs: profile.sampleRefs,
      argFingerprintSequence: profile.sequence,
    };
    return { kind: "refined", cluster: refined, concentration: profile.concentration };
  }

  return { kind: "excluded", concentration: profile.concentration };
}
