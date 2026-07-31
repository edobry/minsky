/**
 * EngProd toil miner — shared domain types (mt#3330).
 *
 * Stage 1 (deterministic): mine recurring tool-call subsequences from the
 * `agent_tool_call_projection` table over a trailing window. Stage 2 (LLM,
 * AI-as-API — a direct provider call via `CognitionProvider`, no MCP/agent
 * loop): ask the top-ranked clusters "what primitive would collapse this?"
 * and "did an existing tool already cover it?". The curation gate (ledger +
 * dedupe + budget + containment) decides which survivors become BLOCKED
 * proposal tasks.
 *
 * @see RFC (Accepted): Notion 3ac937f0-3cb4-816e-8af7-e5380f10a24b
 * @see mt#3330 — this module
 */

/** Tag stamped on every task this miner files. Never routable via `tasks_available`/`tasks_route` while BLOCKED. */
export const ENGPROD_PROPOSAL_TAG = "engprod-proposal";

/**
 * The dominant `arg_fingerprint` sequence within a name-level cluster's
 * occurrences (mt#3429 SC2). `arg_fingerprint` is a stable hash of the
 * normalized tool-call input (never the raw arguments) — when a large
 * share of a cluster's occurrences share the IDENTICAL fingerprint
 * sequence, that's a much stronger toil signal ("the same command repeated
 * N times") than the bare tool-name pattern alone.
 */
export interface FingerprintProfile {
  /** The most common arg_fingerprint sequence among this cluster's occurrences. */
  sequence: string[];
  /** Occurrences sharing that exact fingerprint sequence. */
  frequency: number;
  /** Distinct sessions among those occurrences. */
  sessionCount: number;
  /** frequency / cluster.frequency — the concentration ratio (mt#3429 SC2). */
  concentration: number;
  /** Sample (sessionId, turnIndex) refs specific to the fingerprint-matching occurrences. */
  sampleRefs: Array<{ sessionId: string; turnIndex: number }>;
}

/** A mined recurring tool-call subsequence, before ranking/capping. */
export interface MinedCluster {
  /** Stable hash of the normalized tool-name sequence. Ledger key. */
  signature: string;
  /** Normalized tool-name sequence, e.g. ["Read", "Edit", "Bash"]. */
  toolSequence: string[];
  /** Total occurrences across all sessions in the window. */
  frequency: number;
  /** Distinct sessions in which this sequence occurred. */
  sessionCount: number;
  /** toolSequence.length — kept separate for cheap ranking/storage. */
  chainLength: number;
  /** Ranking score: frequency * sessionCount * chainLength (spec SC1). */
  score: number;
  /**
   * A few (sessionId, turnIndex) sample refs for the evidence block, each
   * optionally carrying the concrete per-position `arg_fingerprint` values
   * observed at that occurrence (mt#3429 SC3) — captured directly during
   * mining from the same projection rows the n-gram scan already reads,
   * never a second query and never raw argument payloads.
   */
  sampleRefs: Array<{ sessionId: string; turnIndex: number; argFingerprints?: string[] }>;
  /**
   * The dominant arg_fingerprint sub-pattern within this cluster's
   * occurrences (mt#3429 SC2), when any fingerprint data was observed.
   * Undefined only for clusters that never carried fingerprint data (e.g.
   * hand-built test fixtures that omit it).
   */
  fingerprintProfile?: FingerprintProfile;
  /**
   * Present when this cluster IS a fingerprint-refined sub-cluster (mt#3429
   * SC2) rather than a generic name-level cluster — i.e. it was produced by
   * `refineCluster` substituting the generic cluster with a more specific
   * one keyed on both tool names AND this fingerprint sequence.
   */
  argFingerprintSequence?: string[];
}

/** LLM stage-2 output for one cluster. */
export interface ClusterAnalysis {
  /** Answer to "what primitive would collapse this?" */
  proposedPrimitive: string;
  /** Answer to "did an existing tool already cover it?" */
  existingToolCoverage: string;
  /** True when the model is confident an existing tool/primitive already covers this need. */
  alreadyCovered: boolean;
}

/** Either a completed analysis or a recorded per-cluster failure — never silently dropped. */
export type ClusterAnalysisOutcome = ClusterAnalysis | { error: string };

export function isClusterAnalysisError(
  outcome: ClusterAnalysisOutcome
): outcome is { error: string } {
  return typeof (outcome as { error?: unknown }).error === "string";
}

/** Per-run self-observability counters (spec SC6; mt#3429 adds the two maximal/distinctiveness fields). */
export interface ToilMinerRunCounters {
  turnsScanned: number;
  clustersFound: number;
  clustersSentToLlm: number;
  proposalsGenerated: number;
  suppressedByDedupe: number;
  suppressedByBudget: number;
  llmErrors: number;
  /** mt#3429 SC1: clusters suppressed because a higher-ranked cluster's tool sequence already covers them. */
  suppressedByMaximalCollapse: number;
  /** mt#3429 SC2 (AT2): generic clusters excluded from the LLM stage for lacking a concentrated arg_fingerprint sub-pattern. */
  suppressedByLowDistinctiveness: number;
}

export function emptyRunCounters(): ToilMinerRunCounters {
  return {
    turnsScanned: 0,
    clustersFound: 0,
    clustersSentToLlm: 0,
    proposalsGenerated: 0,
    suppressedByDedupe: 0,
    suppressedByBudget: 0,
    llmErrors: 0,
    suppressedByMaximalCollapse: 0,
    suppressedByLowDistinctiveness: 0,
  };
}
