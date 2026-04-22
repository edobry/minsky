import { z } from "zod";

/**
 * Staleness threshold configuration.
 *
 * A chunk's `lastModified` is compared against today's date:
 *   - `fresh`  — modified within the last `agingDays` days (default 30)
 *   - `aging`  — modified between `agingDays` and `staleDays` days ago (default 30–90)
 *   - `stale`  — not modified for more than `staleDays` days (default 90)
 */
const stalenessThresholdsSchema = z.object({
  /** Days after which a chunk is considered "aging" (default 30) */
  agingDays: z.number().int().positive().default(30),
  /** Days after which a chunk is considered "stale" (default 90) */
  staleDays: z.number().int().positive().default(90),
});

/**
 * Knowledge reconciliation configuration section.
 *
 * Controls freshness classification, authority-based ranking, near-duplicate
 * clustering, and conflict detection during `knowledge.search`.
 *
 * ### staleness
 * Configures the freshness thresholds used by `classifyFreshness()`.
 *
 * ### sourceAuthority
 * A map from knowledge source name to an authority score (any positive number).
 * Sources not listed default to 0.  When two chunks' relevance scores fall
 * within `epsilon` of each other, the higher-authority source is ranked first
 * in the `authority` field of `KnowledgeSearchResponse`.
 *
 * ### epsilon
 * Maximum relevance score delta within which authority tiebreaking is applied
 * (default 0.05).  Outside this band, pure relevance ordering is used.
 *
 * ### redundancyThreshold
 * Cosine similarity threshold above which two chunks are near-duplicates
 * (default 0.92).  Used by the clustering step run after `knowledge.sync`.
 *
 * ### conflictModel
 * Anthropic model used for NLI-style contradiction detection (default
 * "claude-haiku-4-5").  Must be an Anthropic model that supports structured
 * output.
 */
export const knowledgeReconciliationSchema = z.object({
  /** Freshness classification thresholds */
  staleness: stalenessThresholdsSchema.optional(),
  /**
   * Source authority scores.  Higher number = higher authority.
   * Unlisted sources default to 0.
   *
   * Example:
   *   sourceAuthority:
   *     team-prds: 10
   *     minsky-design: 5
   */
  sourceAuthority: z.record(z.string(), z.number()).optional(),
  /**
   * Maximum relevance score delta within which authority tiebreaking applies.
   * Default 0.05.
   */
  epsilon: z.number().nonnegative().optional(),
  /**
   * Cosine similarity threshold for near-duplicate detection.
   * Two chunks with similarity ≥ this value are considered near-duplicates.
   * Default 0.92.
   */
  redundancyThreshold: z.number().min(0).max(1).optional(),
  /**
   * Anthropic model for NLI-style conflict detection.
   * Default "claude-haiku-4-5" (cost-efficient).
   */
  conflictModel: z.string().optional(),
});

export type KnowledgeReconciliationConfig = z.infer<typeof knowledgeReconciliationSchema>;
export type StalenessThresholds = z.infer<typeof stalenessThresholdsSchema>;

/** Resolved config with all defaults applied — used internally by reconciliation helpers */
export interface ResolvedReconciliationConfig {
  staleness: { agingDays: number; staleDays: number };
  sourceAuthority: Record<string, number>;
  epsilon: number;
  /** Cosine similarity threshold for near-duplicate clustering (default 0.92) */
  redundancyThreshold: number;
  /** Anthropic model for NLI conflict detection (default "claude-haiku-4-5") */
  conflictModel: string;
}

/** Apply defaults to a partial KnowledgeReconciliationConfig */
export function resolveReconciliationConfig(
  config?: KnowledgeReconciliationConfig
): ResolvedReconciliationConfig {
  return {
    staleness: {
      agingDays: config?.staleness?.agingDays ?? 30,
      staleDays: config?.staleness?.staleDays ?? 90,
    },
    sourceAuthority: config?.sourceAuthority ?? {},
    epsilon: config?.epsilon ?? 0.05,
    redundancyThreshold: config?.redundancyThreshold ?? 0.92,
    conflictModel: config?.conflictModel ?? "claude-haiku-4-5",
  };
}
