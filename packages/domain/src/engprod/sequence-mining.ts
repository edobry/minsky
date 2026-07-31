/**
 * Stage 1 (deterministic) of the EngProd toil miner (mt#3330).
 *
 * Reads ONLY `agent_tool_call_projection` — never `agent_transcript_turns`'s
 * raw `tool_calls` jsonb — over a trailing time window, builds per-session
 * ordered tool-name streams, and mines recurring contiguous tool-name
 * subsequences ("n-grams"). Each distinct subsequence is a candidate
 * cluster, ranked by `frequency * sessionCount * chainLength` per the spec.
 *
 * Design note (premise check against the RFC text): the RFC distinguishes
 * "recurring tool-call subsequences" from "hand-rolled-pipeline signatures"
 * as if they were two mining targets. In this implementation both are
 * captured by the SAME contiguous-subsequence miner — a hand-rolled
 * pipeline (e.g. Read -> manual-filter -> Edit repeated across sessions) is
 * observationally just a recurring tool-call subsequence with a longer
 * chain. A dedicated pipeline-signature heuristic (e.g. detecting a
 * characteristic shape rather than exact repetition) would need real
 * mined-corpus examples to design against; deferred to the mt#2807-baseline
 * gate run (a parent-agent post-merge step per this task's scope) which may
 * surface concrete cases motivating a second detector.
 *
 * @see agent-tool-call-projection-schema.ts — source table
 * @see types.ts — MinedCluster
 */

import { createHash } from "node:crypto";
import { gte } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";

import { agentToolCallProjectionTable } from "../storage/schemas/agent-tool-call-projection-schema";
import { log } from "@minsky/shared/logger";
import { getLoggableErrorSummary } from "../errors/index";
import type { MinedCluster } from "./types";

export interface MineClustersOptions {
  /** Trailing window, in days. Default 14 (spec default). */
  windowDays?: number;
  /** Minimum occurrences across the window for a cluster to survive. */
  minFrequency?: number;
  /** Minimum distinct sessions for a cluster to survive. */
  minSessions?: number;
  /** Shortest chain length considered (n-gram length lower bound). */
  minChainLength?: number;
  /** Longest chain length considered (n-gram length upper bound). */
  maxChainLength?: number;
  /** Sample (sessionId, turnIndex) refs kept per cluster for the evidence block. */
  maxSampleRefs?: number;
}

const DEFAULTS: Required<MineClustersOptions> = {
  windowDays: 14,
  minFrequency: 3,
  minSessions: 2,
  minChainLength: 2,
  maxChainLength: 6,
  maxSampleRefs: 3,
};

export interface MineClustersResult {
  /** Clusters surviving the frequency/session thresholds, sorted by score descending. */
  clusters: MinedCluster[];
  /** Distinct (session, turn) pairs scanned in the window. */
  turnsScanned: number;
}

/**
 * Stable, deterministic signature for a tool-name sequence — the ledger key.
 * A sha256 hex digest (truncated for storage economy; collision risk at this
 * corpus scale is negligible and a collision would only cause an overly
 * conservative dedupe, never a silent proposal loss).
 */
export function computeClusterSignature(toolSequence: readonly string[]): string {
  const normalized = toolSequence.join("→");
  return createHash("sha256").update(normalized).digest("hex").slice(0, 24);
}

interface StreamEntry {
  toolName: string;
  turnIndex: number;
}

interface ClusterAggregate {
  toolSequence: string[];
  frequency: number;
  sessions: Set<string>;
  sampleRefs: Array<{ sessionId: string; turnIndex: number }>;
}

/**
 * Mine recurring contiguous tool-name subsequences from the projection table
 * over a trailing window. Fails open (empty result) on a query error — a
 * derived-table read failure must not crash the ops loop; the caller
 * (`toil-miner-tick.ts`) treats a zero-cluster result as real signal for its
 * own two-consecutive-zero-run error escalation, so masking a query failure
 * as "zero clusters" is acceptable here (the failure is logged, and a
 * PERSISTENT query failure will surface as repeated zero-cluster runs).
 */
export async function mineClusters(
  db: PostgresJsDatabase,
  options: MineClustersOptions = {}
): Promise<MineClustersResult> {
  const opts = { ...DEFAULTS, ...options };
  const since = new Date(Date.now() - opts.windowDays * 24 * 60 * 60 * 1000);

  let rows: Array<{ agentSessionId: string; turnIndex: number; ordinal: number; toolName: string }>;
  try {
    rows = await db
      .select({
        agentSessionId: agentToolCallProjectionTable.agentSessionId,
        turnIndex: agentToolCallProjectionTable.turnIndex,
        ordinal: agentToolCallProjectionTable.ordinal,
        toolName: agentToolCallProjectionTable.toolName,
      })
      .from(agentToolCallProjectionTable)
      .where(gte(agentToolCallProjectionTable.timestamp, since))
      .orderBy(
        agentToolCallProjectionTable.agentSessionId,
        agentToolCallProjectionTable.turnIndex,
        agentToolCallProjectionTable.ordinal
      );
  } catch (err) {
    log.error("engprod sequence-mining: failed to load projection rows", {
      error: getLoggableErrorSummary(err),
    });
    return { clusters: [], turnsScanned: 0 };
  }

  if (!Array.isArray(rows)) {
    log.error("engprod sequence-mining: projection query did not return an array");
    return { clusters: [], turnsScanned: 0 };
  }

  // Per-session ordered tool-name streams. Rows arrive pre-sorted by
  // (session, turnIndex, ordinal) from the query above.
  const streams = new Map<string, StreamEntry[]>();
  const turnsSeen = new Set<string>();
  for (const row of rows) {
    turnsSeen.add(`${row.agentSessionId}:${row.turnIndex}`);
    let stream = streams.get(row.agentSessionId);
    if (!stream) {
      stream = [];
      streams.set(row.agentSessionId, stream);
    }
    stream.push({ toolName: row.toolName, turnIndex: row.turnIndex });
  }

  // Contiguous n-grams, order-sensitive, lengths [minChainLength, maxChainLength].
  const agg = new Map<string, ClusterAggregate>();
  for (const [sessionId, stream] of streams) {
    for (let len = opts.minChainLength; len <= opts.maxChainLength; len++) {
      for (let start = 0; start + len <= stream.length; start++) {
        const windowSlice = stream.slice(start, start + len);
        const toolSequence = windowSlice.map((w) => w.toolName);
        const key = toolSequence.join("→");
        let entry = agg.get(key);
        if (!entry) {
          entry = { toolSequence, frequency: 0, sessions: new Set(), sampleRefs: [] };
          agg.set(key, entry);
        }
        entry.frequency++;
        entry.sessions.add(sessionId);
        if (entry.sampleRefs.length < opts.maxSampleRefs) {
          const first = windowSlice[0];
          if (first) entry.sampleRefs.push({ sessionId, turnIndex: first.turnIndex });
        }
      }
    }
  }

  const clusters: MinedCluster[] = [];
  for (const entry of agg.values()) {
    if (entry.frequency < opts.minFrequency) continue;
    if (entry.sessions.size < opts.minSessions) continue;
    const chainLength = entry.toolSequence.length;
    clusters.push({
      signature: computeClusterSignature(entry.toolSequence),
      toolSequence: entry.toolSequence,
      frequency: entry.frequency,
      sessionCount: entry.sessions.size,
      chainLength,
      score: entry.frequency * entry.sessions.size * chainLength,
      sampleRefs: entry.sampleRefs,
    });
  }

  clusters.sort((a, b) => b.score - a.score);

  return { clusters, turnsScanned: turnsSeen.size };
}

/** True when `needle` occurs as a contiguous run inside `haystack`. */
function isContiguousSubsequence(needle: readonly string[], haystack: readonly string[]): boolean {
  if (needle.length > haystack.length) return false;
  outer: for (let i = 0; i + needle.length <= haystack.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) continue outer;
    }
    return true;
  }
  return false;
}

/**
 * Select the top `cap` clusters for the LLM stage, skipping any candidate
 * whose tool sequence is a contiguous subsequence of an already-selected
 * (higher-ranked) candidate's sequence. Without this, a single long
 * recurring pipeline of length N dominates the cap with N-1 overlapping
 * sub-windows of itself instead of surfacing N-1 DIFFERENT patterns.
 *
 * `clusters` is expected to already be sorted by score descending (as
 * `mineClusters` returns it) — this function does not re-sort.
 */
export function selectTopClusters(clusters: readonly MinedCluster[], cap: number): MinedCluster[] {
  const selected: MinedCluster[] = [];
  for (const candidate of clusters) {
    if (selected.length >= cap) break;
    const redundant = selected.some((s) =>
      isContiguousSubsequence(candidate.toolSequence, s.toolSequence)
    );
    if (redundant) continue;
    selected.push(candidate);
  }
  return selected;
}
