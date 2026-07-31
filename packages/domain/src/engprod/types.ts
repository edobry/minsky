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
  /** A few (sessionId, turnIndex) sample refs for the evidence block. */
  sampleRefs: Array<{ sessionId: string; turnIndex: number }>;
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

/** Per-run self-observability counters (spec SC6). */
export interface ToilMinerRunCounters {
  turnsScanned: number;
  clustersFound: number;
  clustersSentToLlm: number;
  proposalsGenerated: number;
  suppressedByDedupe: number;
  suppressedByBudget: number;
  llmErrors: number;
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
  };
}
