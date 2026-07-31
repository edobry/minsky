/**
 * Periodic recurring-category aggregation over reviewer_findings (mt#3295 SC#3).
 *
 * Follows the same in-process `setInterval` pattern established by
 * asks-reconcile-scheduler.ts (the lightest-weight existing scheduler in this
 * service — no domain container required, just the reviewer DB handle) rather
 * than the heavier sweeper.ts (retrigger + circuit-breaker machinery this job
 * has no need for).
 *
 * Scope note: this is a query/module + wiring, not a new UI surface (per the
 * mt#3295 spec's scope guidance — "do not build a new UI surface"). Output is
 * a structured log line (`findings_aggregation.cycle_complete`) an operator
 * or a future cockpit widget can read; it does not itself render anything.
 *
 * The category taxonomy mirrors the keyword-classified table in the mt#3295
 * spec's "Measured corpus results" §3 (full taxonomy, 846/846 real findings
 * classified) — this is a live, ongoing re-run of that same classification
 * over the rolling window, not a one-time analysis.
 *
 * Sealed: no imports from src/.
 */

import { and, gte, inArray } from "drizzle-orm";
import type { ReviewerDb } from "./db/client";
import { reviewerFindingsTable } from "./db/schemas/findings-schema";
import { parsePositiveIntEnv } from "./config";
import { extractPgErrorContext } from "./webhook-events";
import { log } from "./logger";

// ---------------------------------------------------------------------------
// Category taxonomy (mirrors the mt#3295 spec's Measured corpus results §3)
// ---------------------------------------------------------------------------

export type FindingCategory =
  | "unguarded-edge-case"
  | "doc-code-divergence"
  | "spec-evidence-unmet"
  | "logic-bug"
  | "silent-failure"
  | "test-quality"
  | "sibling-path-missed"
  | "wiring-gap"
  | "stale-reference"
  | "regression"
  | "info-disclosure"
  | "scope-expansion"
  | "other";

/**
 * Ordered classification rules: (category, pattern). Order matters — more
 * specific/discriminating patterns are checked before broader ones
 * (`unguarded-edge-case` and `logic-bug` are checked near the end since their
 * vocabulary is the most generic and would otherwise shadow more specific
 * categories). The first match wins; no match falls through to "other".
 *
 * This is a keyword heuristic, not a semantic classifier — it will
 * misclassify ambiguous findings. That's an accepted trade-off for a cheap,
 * dependency-free aggregation job (per the mt#3295 spec's scope guidance:
 * "a query/module ... is sufficient").
 *
 * **Measured real-world hit rate (mt#3295 PR, live verification against
 * production `reviewer_webhook_events`):** against a 60-review / 123-finding
 * sample of real minsky-reviewer[bot] findings, this ruleset classifies
 * ~41% into a real category and ~59% fall through to "other" — a much
 * higher "other" rate than the mt#3295 spec's Measured-corpus-results table
 * (~0.4% "other" on the ORIGINAL 846-finding classification, which was done
 * by four agents semantically READING each finding, not by regex). Three
 * widening passes against the live sample cut "other" from an initial ~93%
 * to ~59% — real, but not "reproduces the table" fidelity. A keyword
 * classifier has a real ceiling against freeform natural-language findings;
 * closing the remaining gap is future work (an LLM-based per-finding judge
 * is the likely right tool, not more regex alternatives) — tracked as a
 * known limitation, not silently claimed as matching. The module/query/
 * scheduler wiring itself (this file's actual SC#3 deliverable) is complete
 * and correct independent of classifier precision.
 */
const CATEGORY_RULES: ReadonlyArray<{ category: FindingCategory; pattern: RegExp }> = [
  {
    category: "doc-code-divergence",
    pattern:
      /\b(?:docstring|jsdoc|documentation|doc|comment|guidance)s?\b.{0,50}\b(?:contradict|wrong|stale|out.?of.?date|incorrect|mismatch|differ|diverge|drift|does not match|does not mention|inconsisten)|\b(?:contradict|mismatch|inconsisten|diverge|drift)\w*\b.{0,50}\bdoc|\bdoc\w*\s+claims?\b|\bclaims?\b.{0,40}\bbut\b.{0,40}\b(?:not|doesn.t|does not)\b|wording\s+drift|section.?reference\s+precision/i,
  },
  {
    category: "spec-evidence-unmet",
    pattern:
      /acceptance\s+(?:criteri|test)|success\s+criteri|spec(?:ification)?\s+(?:criterion|criteria|SC\d|requires|says|states|ties)|\bSC\d+\b|evidence\s+(?:is\s+)?missing|not\s+met\b|durable\s+record|not\s+recorded\s+in.?repo|spec\s+(?:requires|says|states)/i,
  },
  {
    category: "silent-failure",
    pattern:
      /silent(?:ly)?\s*(?:fail|swallow|drop|overwritten)|swallow(?:s|ed|ing)?\s+(?:the\s+)?error|fail[-\s]?open|empty\s+catch|data\s+loss|overwrites?\s+(?:the\s+)?existing|with\s+null\b|drops?\s+(?:the\s+)?(?:error|value|result)|never\s+clears?|stale\s+\w+\s+persists|does\s+not\s+clear/i,
  },
  {
    category: "test-quality",
    pattern:
      /placeholder\s+(?:test|assertion)|test.{0,20}(?:doesn.t|does not)\s+(?:exercise|test|cover|verify)|expect\(true\)|\.skip\(|\.todo\(|(?:missing|lacks?|no|untested|lacking)\b.{0,20}\btest(?:s|\s+coverage|\s+case)?\b|test\s+suite\s+lacks|lacks?\s+guardrails/i,
  },
  {
    category: "sibling-path-missed",
    pattern:
      /sibling\s+(?:path|site|call)|other\s+call\s?site|missed\s+(?:a\s+)?sibling|same\s+\w*\s*bug\s+as|omits?\s+(?:the\s+)?legacy|other\s+(?:path|hook|handler|branch)\s+(?:not|wasn.t|was not)|asymmetric\s+behavior|duplicated\s+instead\s+of\s+reusing/i,
  },
  {
    category: "wiring-gap",
    pattern:
      /(?:not|never)\s+(?:wired|registered|invoked|called|adopted)|no\s+(?:caller|consumer)s?\s+(?:found|wired)|dead\s+code\s+path|orphan(?:ed)?\s+(?:export|function)|omits?\s+(?:the\s+)?legacy\s+\w+\s+name|never\s+perform|never\s+refresh|ignores?\s+\w+\.\w+|renders?\s+regardless\s+of/i,
  },
  {
    category: "stale-reference",
    pattern:
      /stale\s+(?:reference|link|pointer|import|selection|match|section|state|timestamp)|references?\s+(?:a\s+)?(?:removed|deleted|renamed)|dangling\s+reference|still\s+uses?\s+(?:the\s+)?first\s+match|reference\s+to\s+\w+\s+before\s+its\s+declaration/i,
  },
  {
    category: "regression",
    pattern:
      /\bregression\b|previously\s+(?:worked|passing)|used\s+to\s+work|broke\s+(?:existing|previously)/i,
  },
  {
    category: "info-disclosure",
    pattern:
      /(?:leak(?:s|ed|age)?|expos(?:e|es|ed|ure)|disclos(?:e|es|ed|ure))\s+(?:a\s+)?(?:secret|token|credential|password|pii|sensitive)|log\s+volume\s+and\s+pii\s+risk/i,
  },
  {
    category: "scope-expansion",
    pattern: /scope\s+(?:creep|expansion)|out.?of.?scope|beyond\s+(?:the\s+)?(?:stated|spec)/i,
  },
  {
    category: "logic-bug",
    pattern:
      /logic\s+(?:error|bug)|incorrect(?:ly)?\s+(?:condition|comparison|calculation|flagg?ed)|off[-\s]?by[-\s]?one|wrong\s+(?:operator|comparison|id|index|order)|falsely\s+(?:flag|match|report)|false\s+(?:positive|negative)|can\s+(?:crash|orphan|misreport)|will\s+crash|can\s+remain\s+permanently|misreport/i,
  },
  {
    category: "unguarded-edge-case",
    pattern:
      /unguarded|missing\s+(?:guard|check|validation|re-?check)|uncaught\s+exception|edge\s+case|null\s+check|undefined\s+check|no\s+error\s+handling|no\s+guard\s+against|does\s+not\s+(?:re-?check|re-?verify|handle|validate|account\s+for)|fails?\s+to\s+(?:check|verify|handle|validate|re-?check|print)|assumes?\b|can\s+(?:become|leave|result\s+in)|may\s+(?:skip|miss|leave|be\s+too|not\s+learn|mislead)|not\s+re-?check(?:ed)?|unhandled|overlooked|misses?\s+\w+|omits?\s+\w+(?:\s+(?:flags?|form|name))?|does\s+not\s+mention|hard.?fails?\s+on|brittle\s+and\s+likely\s+to\s+drift/i,
  },
];

/**
 * Classify one finding's title + body text into a recurring category.
 * Pure function. Exported for unit testing.
 */
export function classifyFindingCategory(title: string, body: string): FindingCategory {
  const text = `${title}\n${body}`;
  for (const rule of CATEGORY_RULES) {
    if (rule.pattern.test(text)) return rule.category;
  }
  return "other";
}

// ---------------------------------------------------------------------------
// Aggregation query
// ---------------------------------------------------------------------------

export interface CategoryCount {
  category: FindingCategory;
  count: number;
}

export interface AggregateRecurringCategoriesOptions {
  /** Rolling window size in days. */
  windowDays: number;
  /** Severities to include. Default: ["BLOCKING"] (the actionable subset). */
  severities?: ReadonlyArray<string>;
}

/**
 * Aggregate reviewer_findings rows from the last `windowDays` into
 * category counts, sorted descending by count (most-recurring first).
 */
export async function aggregateRecurringCategories(
  db: ReviewerDb,
  options: AggregateRecurringCategoriesOptions
): Promise<CategoryCount[]> {
  const severities = options.severities ?? ["BLOCKING"];
  const cutoff = new Date(Date.now() - options.windowDays * 24 * 60 * 60 * 1000);

  const rows = await db
    .select({
      title: reviewerFindingsTable.title,
      body: reviewerFindingsTable.body,
    })
    .from(reviewerFindingsTable)
    .where(
      and(
        gte(reviewerFindingsTable.createdAt, cutoff),
        inArray(reviewerFindingsTable.severity, [...severities])
      )
    );

  const counts = new Map<FindingCategory, number>();
  for (const row of rows) {
    const category = classifyFindingCategory(row.title, row.body);
    counts.set(category, (counts.get(category) ?? 0) + 1);
  }

  return Array.from(counts.entries())
    .map(([category, count]) => ({ category, count }))
    .sort((a, b) => b.count - a.count);
}

// ---------------------------------------------------------------------------
// Scheduler config
// ---------------------------------------------------------------------------

export interface FindingsAggregationConfig {
  /** Whether the scheduler is enabled. */
  enabled: boolean;
  /** Poll interval in milliseconds. */
  intervalMs: number;
  /** Rolling window size in days. */
  windowDays: number;
  /** Number of top categories to log per cycle. */
  topN: number;
}

export function loadFindingsAggregationConfig(): FindingsAggregationConfig {
  return {
    enabled: (process.env["FINDINGS_AGGREGATION_ENABLED"] ?? "false") === "true",
    // Strict-positive parse (mt#1811 cascade-defense convention, shared with
    // every other scheduler in this service): malformed values would feed
    // NaN to setInterval. Default: once per day — this is a slow-moving
    // trend signal, not a real-time one.
    intervalMs: parsePositiveIntEnv("FINDINGS_AGGREGATION_INTERVAL_MS", 24 * 60 * 60 * 1000),
    // Default per decision-defaults.mdc's observed-cadence grounding
    // ("Budget windows: 5 days") rather than an arbitrary round number.
    windowDays: parsePositiveIntEnv("FINDINGS_AGGREGATION_WINDOW_DAYS", 5),
    topN: parsePositiveIntEnv("FINDINGS_AGGREGATION_TOP_N", 5),
  };
}

// ---------------------------------------------------------------------------
// Cycle + scheduler
// ---------------------------------------------------------------------------

export interface FindingsAggregationCycleResult {
  totalFindings: number;
  topCategories: CategoryCount[];
}

/**
 * Run one aggregation cycle: query the rolling window, classify, log the top
 * N categories. Errors are caught and logged — this is a best-effort
 * background signal, never allowed to crash the reviewer service.
 */
export async function runFindingsAggregationCycle(
  db: ReviewerDb,
  config: FindingsAggregationConfig
): Promise<FindingsAggregationCycleResult> {
  try {
    const all = await aggregateRecurringCategories(db, { windowDays: config.windowDays });
    const totalFindings = all.reduce((sum, c) => sum + c.count, 0);
    const topCategories = all.slice(0, config.topN);

    log.info("findings_aggregation.cycle_complete", {
      event: "findings_aggregation.cycle_complete",
      windowDays: config.windowDays,
      totalFindings,
      topCategories,
    });

    return { totalFindings, topCategories };
  } catch (err: unknown) {
    log.error("findings_aggregation.cycle_error", {
      event: "findings_aggregation.cycle_error",
      ...extractPgErrorContext(err),
      windowDays: config.windowDays,
    });
    return { totalFindings: 0, topCategories: [] };
  }
}

/**
 * Start the findings-aggregation scheduler on an in-process interval.
 *
 * Opt-in via `FINDINGS_AGGREGATION_ENABLED=true` (disabled by default —
 * matches the asks-reconcile-scheduler.ts convention for a job with no
 * production urgency yet). A reentrancy guard (`isRunning`) prevents
 * overlapping cycles if one takes longer than the interval.
 *
 * @returns the timer handle (for tests to `clearInterval`), or `null` when
 *   disabled or when no DB is configured (degraded boot).
 */
export function startFindingsAggregationScheduler(
  db: ReviewerDb | undefined,
  config: FindingsAggregationConfig
): ReturnType<typeof setInterval> | null {
  if (!config.enabled) {
    log.info("findings_aggregation.disabled", {
      event: "findings_aggregation.disabled",
      message: "Findings-aggregation scheduler is disabled (FINDINGS_AGGREGATION_ENABLED=false).",
    });
    return null;
  }

  if (db === undefined) {
    log.warn("findings_aggregation.missing_db", {
      event: "findings_aggregation.missing_db",
      message:
        "FINDINGS_AGGREGATION_ENABLED=true but no DB is configured. " +
        "Findings-aggregation scheduler will not start.",
    });
    return null;
  }

  log.info("findings_aggregation.enabled", {
    event: "findings_aggregation.enabled",
    intervalMs: config.intervalMs,
    windowDays: config.windowDays,
    topN: config.topN,
  });

  let isRunning = false;

  const handle = setInterval(() => {
    if (isRunning) {
      log.warn("findings_aggregation.tick.skipped_overlap", {
        event: "findings_aggregation.tick.skipped_overlap",
        message: "Previous aggregation cycle still in progress; skipping this interval tick.",
      });
      return;
    }
    isRunning = true;
    runFindingsAggregationCycle(db, config)
      .catch((err: unknown) => {
        // Unreachable: runFindingsAggregationCycle catches internally.
        // Belt-and-suspenders, mirrors asks-reconcile-scheduler.ts.
        const message = err instanceof Error ? err.message : String(err);
        log.error("findings_aggregation.tick.error", {
          event: "findings_aggregation.tick.error",
          error: message,
        });
      })
      .finally(() => {
        isRunning = false;
      });
  }, config.intervalMs);

  return handle;
}
