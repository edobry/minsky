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
import type { MinedCluster, FingerprintProfile } from "./types";

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

/**
 * Stable signature for a fingerprint-REFINED cluster (mt#3429 SC2) — keyed
 * on both the tool-name sequence AND the concrete arg_fingerprint sequence,
 * so a refined cluster never collides with its generic parent's signature
 * (which would otherwise clobber the parent's ledger row on upsert).
 */
export function computeRefinedClusterSignature(
  toolSequence: readonly string[],
  fingerprintSequence: readonly string[]
): string {
  const normalized = `${toolSequence.join("→")}::fp::${fingerprintSequence.join("→")}`;
  return createHash("sha256").update(normalized).digest("hex").slice(0, 24);
}

/**
 * Reduce a window's per-fingerprint-sequence sub-aggregates (mt#3429 SC2)
 * to the single dominant `FingerprintProfile` a refinement decision needs.
 * Ties (equal counts) break on the fingerprint key itself for determinism
 * across runs — never on Map iteration order, which is insertion-order but
 * not otherwise meaningful here.
 */
function computeFingerprintProfile(
  groups: ReadonlyMap<
    string,
    {
      count: number;
      sessions: Set<string>;
      sampleRefs: Array<{ sessionId: string; turnIndex: number }>;
    }
  >,
  clusterFrequency: number
): FingerprintProfile | undefined {
  if (groups.size === 0 || clusterFrequency === 0) return undefined;
  let topKey: string | undefined;
  let topGroup:
    | {
        count: number;
        sessions: Set<string>;
        sampleRefs: Array<{ sessionId: string; turnIndex: number }>;
      }
    | undefined;
  for (const [key, group] of groups) {
    if (
      !topGroup ||
      group.count > topGroup.count ||
      (group.count === topGroup.count && topKey !== undefined && key < topKey)
    ) {
      topKey = key;
      topGroup = group;
    }
  }
  if (!topKey || !topGroup) return undefined;
  return {
    sequence: topKey.split("→"),
    frequency: topGroup.count,
    sessionCount: topGroup.sessions.size,
    concentration: topGroup.count / clusterFrequency,
    sampleRefs: topGroup.sampleRefs,
  };
}

interface StreamEntry {
  toolName: string;
  turnIndex: number;
  argFingerprint: string;
}

/** Per-fingerprint-sequence sub-aggregate within a name-level cluster (mt#3429 SC2). */
interface FingerprintAggregate {
  count: number;
  sessions: Set<string>;
  sampleRefs: Array<{ sessionId: string; turnIndex: number }>;
}

interface ClusterAggregate {
  toolSequence: string[];
  frequency: number;
  sessions: Set<string>;
  sampleRefs: Array<{ sessionId: string; turnIndex: number; argFingerprints?: string[] }>;
  /** Keyed by the joined arg_fingerprint sequence for this window's occurrences. */
  fingerprintGroups: Map<string, FingerprintAggregate>;
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

  let rows: Array<{
    agentSessionId: string;
    turnIndex: number;
    ordinal: number;
    toolName: string;
    argFingerprint: string;
  }>;
  try {
    rows = await db
      .select({
        agentSessionId: agentToolCallProjectionTable.agentSessionId,
        turnIndex: agentToolCallProjectionTable.turnIndex,
        ordinal: agentToolCallProjectionTable.ordinal,
        toolName: agentToolCallProjectionTable.toolName,
        argFingerprint: agentToolCallProjectionTable.argFingerprint,
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
    stream.push({
      toolName: row.toolName,
      turnIndex: row.turnIndex,
      argFingerprint: row.argFingerprint,
    });
  }

  // Contiguous n-grams, order-sensitive, lengths [minChainLength, maxChainLength].
  const agg = new Map<string, ClusterAggregate>();
  for (const [sessionId, stream] of streams) {
    for (let len = opts.minChainLength; len <= opts.maxChainLength; len++) {
      for (let start = 0; start + len <= stream.length; start++) {
        const windowSlice = stream.slice(start, start + len);
        const toolSequence = windowSlice.map((w) => w.toolName);
        const argFingerprints = windowSlice.map((w) => w.argFingerprint);
        const key = toolSequence.join("→");
        let entry = agg.get(key);
        if (!entry) {
          entry = {
            toolSequence,
            frequency: 0,
            sessions: new Set(),
            sampleRefs: [],
            fingerprintGroups: new Map(),
          };
          agg.set(key, entry);
        }
        entry.frequency++;
        entry.sessions.add(sessionId);
        if (entry.sampleRefs.length < opts.maxSampleRefs) {
          const first = windowSlice[0];
          if (first)
            entry.sampleRefs.push({ sessionId, turnIndex: first.turnIndex, argFingerprints });
        }

        // mt#3429 SC2: sub-cluster the SAME window by its concrete
        // arg_fingerprint sequence, so a later refinement pass can tell
        // "the same command repeated" apart from "the same tool, different
        // commands, coincidentally the same tool-name shape."
        const fingerprintKey = argFingerprints.join("→");
        let fpGroup = entry.fingerprintGroups.get(fingerprintKey);
        if (!fpGroup) {
          fpGroup = { count: 0, sessions: new Set(), sampleRefs: [] };
          entry.fingerprintGroups.set(fingerprintKey, fpGroup);
        }
        fpGroup.count++;
        fpGroup.sessions.add(sessionId);
        if (fpGroup.sampleRefs.length < opts.maxSampleRefs) {
          const first = windowSlice[0];
          if (first) fpGroup.sampleRefs.push({ sessionId, turnIndex: first.turnIndex });
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
      fingerprintProfile: computeFingerprintProfile(entry.fingerprintGroups, entry.frequency),
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

/** True when either sequence occurs as a contiguous run inside the other. */
function isNestedEitherDirection(a: readonly string[], b: readonly string[]): boolean {
  if (a.length === b.length) {
    return a.length > 0 && a.every((v, i) => v === b[i]);
  }
  const [shorter, longer] = a.length < b.length ? [a, b] : [b, a];
  return isContiguousSubsequence(shorter, longer);
}

export interface MaximalCollapseSuppression {
  cluster: MinedCluster;
  /** The higher-ranked (kept) cluster whose tool sequence already covers this one. */
  supersededBy: MinedCluster;
}

export interface MaximalCollapseResult {
  /** Clusters that survived collapsing — one per family of nested/overlapping sequences. */
  maximal: MinedCluster[];
  /** Every other cluster, paired with the surviving cluster that subsumes it. */
  suppressed: MaximalCollapseSuppression[];
  /**
   * Count of pairwise `isNestedEitherDirection` comparisons performed (mt#3494).
   *
   * This is the algorithm's COMPLEXITY SIGNAL, exposed so a regression guard can
   * assert on it directly instead of on elapsed wall-clock time. The collapse
   * loop scans the growing `maximal` list per candidate, so the count is
   * O(N x |maximal|) — it stays near-linear while most candidates are suppressed
   * early, and approaches N^2/2 if `maximal` grows with N (the quadratic blowup
   * mt#3432 AT1 guards against).
   *
   * Purely a function of the input: the same clusters always produce the same
   * count, on any machine, under any load, whether run standalone or inside the
   * full suite. That determinism is the point — the previous guard timed this
   * loop and asserted `elapsed < 10s`, which measured the host and the
   * surrounding suite as much as the algorithm (~1.4s standalone vs ~10.5s
   * inside the 769-file suite) and failed the fail-closed pre-push gate on
   * unrelated branches.
   */
  comparisons: number;
}

/**
 * Maximal-sequence collapsing (mt#3429 SC1).
 *
 * v1's `selectTopClusters` only ever checks whether a CANDIDATE is a
 * contiguous subsequence of an ALREADY-SELECTED (necessarily earlier, i.e.
 * higher-scored) cluster. That direction alone misses the production
 * shape this task fixes: a homogeneous repeat of the same tool (e.g. a
 * burst of consecutive `Bash` calls) generates a NESTED family of n-grams
 * — [Bash,Bash], [Bash,Bash,Bash], ... — whose n-gram-counted frequency is
 * naturally anti-monotonic in chain length (a 2-window fits inside every
 * longer run too, so it's always counted at least as often). The SHORTER
 * member of the family therefore almost always scores HIGHEST and is
 * selected first; every LONGER member is then compared only against
 * "is the longer one a subsequence of the shorter, already-selected one?"
 * — which is never true (a longer sequence cannot fit inside a shorter
 * one), so nothing gets suppressed and the whole family survives as N
 * separate proposals (the v1 production run's Bash x2..x6 five-way split,
 * mt#3419/3420/3421/3423/3425).
 *
 * The fix: check containment in EITHER direction. Two clusters where one's
 * sequence is a contiguous run of the other's represent the SAME
 * phenomenon observed at a different grain; walking the (pre-sorted,
 * score-descending) candidate list and keeping only the first member of
 * each such family — regardless of whether that first-kept member happens
 * to be the shorter or the longer sequence — collapses the whole family to
 * the single highest-ranked ("higher-ranked proposed cluster" per spec
 * SC1) representative. Every other member is suppressed and returned
 * alongside the surviving cluster it was superseded by, so the caller can
 * record a distinct, audit-trail-bearing ledger row for each (never a
 * silent drop, per spec SC1 / work-completion's invocation-path
 * discipline).
 *
 * `clusters` is expected pre-sorted by score descending (as `mineClusters`
 * returns it) — this function does not re-sort.
 */
export function collapseToMaximalClusters(
  clusters: readonly MinedCluster[]
): MaximalCollapseResult {
  const maximal: MinedCluster[] = [];
  const suppressed: MaximalCollapseSuppression[] = [];
  let comparisons = 0;

  for (const candidate of clusters) {
    // Explicit loop rather than `maximal.find(...)` purely so the comparison
    // count is observable (mt#3494). Semantics are identical to `find`: first
    // match wins and the scan short-circuits there.
    let supersededBy: MinedCluster | undefined;
    for (const kept of maximal) {
      comparisons++;
      if (isNestedEitherDirection(candidate.toolSequence, kept.toolSequence)) {
        supersededBy = kept;
        break;
      }
    }
    if (supersededBy) {
      suppressed.push({ cluster: candidate, supersededBy });
    } else {
      maximal.push(candidate);
    }
  }

  return { maximal, suppressed, comparisons };
}
