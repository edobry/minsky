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
 * Controls freshness classification and authority-based ranking during
 * `knowledge.search` response construction.
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
});

export type KnowledgeReconciliationConfig = z.infer<typeof knowledgeReconciliationSchema>;
export type StalenessThresholds = z.infer<typeof stalenessThresholdsSchema>;

/** Resolved config with all defaults applied — used internally by reconciliation helpers */
export interface ResolvedReconciliationConfig {
  staleness: { agingDays: number; staleDays: number };
  sourceAuthority: Record<string, number>;
  epsilon: number;
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
  };
}
