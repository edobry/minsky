/**
 * Stage 2 (LLM, AI-as-API) of the EngProd toil miner (mt#3330).
 *
 * For each top-ranked cluster, asks exactly two questions per the RFC:
 * "what primitive would collapse this?" and "did an existing tool already
 * cover it?". Uses `CognitionProvider` (ADR-007) — a direct provider call,
 * NOT an MCP tool call or an agent loop — so this stage is a bounded,
 * schema-validated completion request per cluster.
 *
 * Per-cluster error isolation: `CognitionProvider.performBatch` is
 * documented as all-or-nothing (one failing task fails the whole batch), so
 * this module calls `.perform` once per cluster instead — a single
 * cluster's failure is recorded and does not prevent the others from being
 * analyzed. The caller (`toil-miner-tick.ts`) treats ANY recorded failure as
 * a run-level error state (never a silent empty success) per spec AT4.
 *
 * @see packages/domain/src/cognition/types.ts — CognitionProvider contract
 * @see packages/domain/src/cognition/providers/direct.ts — direct provider impl
 */

import { z } from "zod";
import type { CognitionProvider, CognitionTask } from "../cognition/types";
import type { MinedCluster, ClusterAnalysis, ClusterAnalysisOutcome } from "./types";

export const clusterAnalysisSchema = z.object({
  proposedPrimitive: z.string().min(1),
  existingToolCoverage: z.string().min(1),
  alreadyCovered: z.boolean(),
});

const SYSTEM_PROMPT = [
  "You are the analysis stage of Minsky's EngProd toil miner.",
  "You are given a recurring tool-call subsequence observed across multiple",
  "agent sessions — a pattern of manual tool calls that repeats often enough",
  "to look like unautomated toil. Answer two questions concisely:",
  "",
  "1. What primitive (a new tool, MCP command, or workflow step) would",
  "   collapse this sequence into a single call?",
  "2. Does an existing Minsky tool or command already cover this need? If",
  "   so, name it — the real gap may be ADOPTION, not a missing primitive.",
  "",
  "Set alreadyCovered=true only when you are confident an existing tool",
  "already does this; otherwise false.",
].join("\n");

/**
 * Render a cluster's representative samples — tool names + arg_fingerprint
 * values only, NEVER raw arguments (mt#3429 SC3). Samples are resolved
 * directly from `cluster.sampleRefs`, which `mineClusters` already
 * populates with the concrete per-position fingerprints observed at each
 * occurrence, straight from the projection rows the mining pass reads —
 * there is no second query and no path to raw argument payloads here.
 */
function buildSampleLines(cluster: MinedCluster): string[] {
  const withFingerprints = cluster.sampleRefs.filter(
    (ref) => (ref.argFingerprints?.length ?? 0) > 0
  );
  if (withFingerprints.length === 0) return [];

  const lines = [
    "",
    "Representative samples (tool name + argument fingerprint per call — never raw arguments):",
  ];
  for (const ref of withFingerprints) {
    const pairs = cluster.toolSequence.map(
      (tool, i) => `${tool}(fp:${ref.argFingerprints?.[i] ?? "?"})`
    );
    lines.push(`  - ${pairs.join(" -> ")}`);
  }
  return lines;
}

function buildUserPrompt(cluster: MinedCluster): string {
  const lines = [
    `Recurring tool-call sequence: ${cluster.toolSequence.join(" -> ")}`,
    `Observed ${cluster.frequency} times across ${cluster.sessionCount} distinct sessions.`,
    `Chain length: ${cluster.chainLength}.`,
  ];

  if (cluster.argFingerprintSequence) {
    lines.push(
      `This is a FINGERPRINT-REFINED cluster: these occurrences share the IDENTICAL argument fingerprint sequence [${cluster.argFingerprintSequence.join(", ")}] — this is the SAME command/input repeated, not merely the same tool.`
    );
  }

  lines.push(...buildSampleLines(cluster));
  lines.push(
    "",
    "1. What primitive would collapse this sequence into one call?",
    "2. Does an existing Minsky tool already cover this need?"
  );
  return lines.join("\n");
}

function buildTask(cluster: MinedCluster): CognitionTask<ClusterAnalysis> {
  return {
    id: `engprod-cluster-${cluster.signature}`,
    kind: "engprod-cluster-analysis",
    systemPrompt: SYSTEM_PROMPT,
    userPrompt: buildUserPrompt(cluster),
    evidence: {
      toolSequence: cluster.toolSequence,
      frequency: cluster.frequency,
      sessionCount: cluster.sessionCount,
      chainLength: cluster.chainLength,
    },
    schema: clusterAnalysisSchema,
  };
}

/**
 * Analyze each cluster via one `CognitionProvider.perform` call. Returns a
 * map keyed by cluster signature so the caller can look up per-cluster
 * outcomes (`ClusterAnalysis` on success, `{ error }` on failure) without
 * relying on array-index alignment.
 */
export async function analyzeClusters(
  cognitionProvider: CognitionProvider,
  clusters: readonly MinedCluster[]
): Promise<Map<string, ClusterAnalysisOutcome>> {
  const results = new Map<string, ClusterAnalysisOutcome>();

  for (const cluster of clusters) {
    try {
      const result = await cognitionProvider.perform(buildTask(cluster));
      if (result.kind === "completed") {
        results.set(cluster.signature, result.value);
      } else {
        // "packaged" (delegated mode) or "unavailable" — neither is a valid
        // outcome for this bounded ops-loop stage, which requires a direct
        // provider (DirectCognitionProvider only ever returns "completed").
        results.set(cluster.signature, {
          error: `cognition provider returned unexpected kind "${result.kind}" (expected "completed")`,
        });
      }
    } catch (err) {
      results.set(cluster.signature, {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return results;
}
