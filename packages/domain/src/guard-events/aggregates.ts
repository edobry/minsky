/**
 * Interceptor-corpus aggregation reads over `guard_events` (mt#4009, mt#3754
 * phase 3).
 *
 * The QUERY half of the ingest thread: window-bounded grouped reads over the
 * promoted columns, shaped to the indexes `guard-events-schema.ts` designed
 * for exactly these read shapes — `(stream, occurred_at)` for catalog-wide
 * windows, `(guard_name, occurred_at)` for single-guard windows. No new DDL:
 * the deferred `(guard_name, decision, occurred_at)` composite stays deferred
 * per the schema doc-comment (query tuning is the mt#4019 track).
 *
 * Layering: SQL fetchers here take an injected drizzle handle
 * (testable-design, mt#3632 — no module-level connection reach); the pure
 * {@link assembleInterceptorAggregates} merges fetched rows with
 * caller-supplied joins (canary, health, calibration, registry) into one
 * snapshot. Callers own WHERE those joins come from; this module only defines
 * the structural shapes it merges, so `packages/domain` does not import
 * `src/` (the health tracker and calibration sweep live there).
 *
 * Traceability (mt#4009 SC2 / mt#3754 criterion 6): every figure lives under
 * a section NAMED for its source — `fireLog` figures come from
 * `guard_events` rows with `stream = 'fire-log'`, `canary` from
 * `guard_canary_runs`, `health` from the guard-health tracker, `calibration`
 * from the calibration sweep, `registry` from the generated catalog artifact
 * — and the snapshot's `sources` map spells each mapping out. Nothing here
 * recomputes a figure another module already defines: canary state, health
 * liveness, and review-due arrive PRE-COMPUTED from their single owners.
 *
 * @see packages/domain/src/storage/schemas/guard-events-schema.ts — the table + index rationale
 * @see mt#4009 — this task (the plan section records the measured basis for the cached serving shape)
 */
import { and, eq, gte, isNotNull, lte, sql, type SQL } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import {
  guardEventFireLogRollupTable,
  guardEventsTable,
} from "../storage/schemas/guard-events-schema";

/** Catalog above-the-fold window (AT1: "denials per guard per week"). */
export const CATALOG_WINDOW_DAYS = 7;

/**
 * The fire-log stream discriminator.
 *
 * Exported so `fire-log-rollup.ts` uses THIS value rather than its own copy
 * (PR #3191 R1). The rollup's fold and `fireLogWhere` below must select the
 * same population or the maintained value drifts from the rebuild — the same
 * hazard the reviewer caught in the guard-name predicate, one constant over.
 * Two string literals that must stay equal are a latent divergence; one export
 * is not.
 */
export const FIRE_LOG_STREAM = "fire-log";

// ---------------------------------------------------------------------------
// Fetched row shapes
// ---------------------------------------------------------------------------

export interface FireLogDecisionCountRow {
  guardName: string;
  /** Promoted tri-state: allow | warn | deny — null when the record carried none. */
  decision: string | null;
  fires: number;
}

export interface FireLogDurationRow {
  guardName: string;
  avgMs: number | null;
  p95Ms: number | null;
  maxMs: number | null;
  totalMs: number;
  /** Rows that actually carried a `duration_ms` — the aggregate's denominator. */
  measuredFires: number;
}

export interface FireLogLifetimeRow {
  guardName: string;
  totalFires: number;
  firstFireAt: string | null;
  lastFireAt: string | null;
}

export interface FireLogOverrideRow {
  guardName: string;
  overrideEnvVar: string;
  fires: number;
}

// ---------------------------------------------------------------------------
// SQL fetchers — window-bounded grouped reads, one round trip each
// ---------------------------------------------------------------------------

function fireLogWhere(since?: Date, guardName?: string, until?: Date): SQL | undefined {
  return and(
    eq(guardEventsTable.stream, FIRE_LOG_STREAM),
    isNotNull(guardEventsTable.guardName),
    ...(since ? [gte(guardEventsTable.occurredAt, since)] : []),
    ...(until ? [lte(guardEventsTable.occurredAt, until)] : []),
    // `!== undefined`, NOT truthiness (PR #3191 R2). The empty string is a
    // VALID guard name here — `isNotNull` above admits it — so `guardName ? …`
    // silently drops the filter for `""` and returns the WHOLE population
    // where the caller asked for one guard. A missing filter fails open, which
    // is why this reads as a plausible result rather than an error. The `since`
    // and `until` guards above are safe under truthiness only because a Date
    // is never falsy; do not copy their shape for a string.
    ...(guardName !== undefined ? [eq(guardEventsTable.guardName, guardName)] : [])
  );
}

/**
 * `min`/`max(occurred_at)` comes back as a Date from postgres-js; normalize to
 * ISO-8601. Anything unparseable maps to null rather than throwing — an
 * Invalid Date's `toISOString()` throws a RangeError, and a malformed value
 * from the driver must degrade to an honest null, not crash the refresh
 * (PR #2939 R1). Exported for direct testing of exactly that path.
 */
export function toIsoOrNull(value: unknown): string | null {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value.toISOString();
  }
  if (typeof value === "string" && value !== "") {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
  }
  return null;
}

function toFiniteOrNull(value: unknown): number | null {
  const n = typeof value === "string" ? Number.parseFloat(value) : (value as number | null);
  return typeof n === "number" && Number.isFinite(n) ? n : null;
}

/** Fire counts by decision per guard over the window. */
export async function fetchFireLogDecisionCounts(
  db: PostgresJsDatabase,
  since: Date,
  guardName?: string,
  /** Optional inclusive upper bound — used by the verify script to compare a window whose upper edge sits safely behind ingest lag (AT2). */
  until?: Date
): Promise<FireLogDecisionCountRow[]> {
  const rows = await db
    .select({
      guardName: guardEventsTable.guardName,
      decision: guardEventsTable.decision,
      fires: sql<number>`count(*)::int`,
    })
    .from(guardEventsTable)
    .where(fireLogWhere(since, guardName, until))
    .groupBy(guardEventsTable.guardName, guardEventsTable.decision);
  return rows.map((r) => ({
    guardName: r.guardName as string,
    decision: r.decision,
    fires: r.fires,
  }));
}

/** Duration/cost aggregates per guard over the window (rows carrying duration_ms only). */
export async function fetchFireLogDurations(
  db: PostgresJsDatabase,
  since: Date,
  guardName?: string,
  /** Optional inclusive upper bound — mirrors the decision-count fetcher, so the verify script can bound a window behind ingest lag (mt#4057 AT4). */
  until?: Date
): Promise<FireLogDurationRow[]> {
  const rows = await db
    .select({
      guardName: guardEventsTable.guardName,
      avgMs: sql<unknown>`avg(${guardEventsTable.durationMs})::float8`,
      p95Ms: sql<unknown>`percentile_cont(0.95) within group (order by ${guardEventsTable.durationMs})::float8`,
      maxMs: sql<unknown>`max(${guardEventsTable.durationMs})::float8`,
      totalMs: sql<unknown>`coalesce(sum(${guardEventsTable.durationMs}), 0)::float8`,
      measuredFires: sql<number>`count(${guardEventsTable.durationMs})::int`,
    })
    .from(guardEventsTable)
    .where(and(fireLogWhere(since, guardName, until), isNotNull(guardEventsTable.durationMs)))
    .groupBy(guardEventsTable.guardName);
  return rows.map((r) => ({
    guardName: r.guardName as string,
    avgMs: toFiniteOrNull(r.avgMs),
    p95Ms: toFiniteOrNull(r.p95Ms),
    maxMs: toFiniteOrNull(r.maxMs),
    totalMs: toFiniteOrNull(r.totalMs) ?? 0,
    measuredFires: r.measuredFires,
  }));
}

/**
 * All-time per-guard totals + first/last fire. This is the POPULATION query
 * (SC3: the population is fire-log-derived distinct `guardName`).
 *
 * Reads the MAINTAINED rollup (`guard_event_fire_log_rollup`), not
 * `guard_events` — a primary-key lookup when `guardName` is given, a ~109-row
 * seq scan when it is not. It used to be a full `GROUP BY` over the whole
 * corpus, which cost 2,193 ms / ~404 MB per refresh and 10,972 ms for the
 * single-guard form (mt#4294). Because it is now cheap in BOTH forms, the
 * "off-request refresh only, never per request" restriction this comment used
 * to carry no longer applies — the per-guard detail path calls it directly.
 *
 * The rollup is maintained at ingest and rebuilt by
 * `rebuildFireLogLifetimeRollup`; see `guardEventFireLogRollupTable`'s doc
 * comment for why it cannot drift.
 */
export async function fetchFireLogLifetime(
  db: PostgresJsDatabase,
  guardName?: string
): Promise<FireLogLifetimeRow[]> {
  const rows = await db
    .select({
      guardName: guardEventFireLogRollupTable.guardName,
      totalFires: guardEventFireLogRollupTable.totalFires,
      firstFireAt: guardEventFireLogRollupTable.firstFireAt,
      lastFireAt: guardEventFireLogRollupTable.lastFireAt,
    })
    .from(guardEventFireLogRollupTable)
    // `!== undefined`, not truthiness — see `fireLogWhere` (PR #3191 R2).
    .where(
      guardName !== undefined ? eq(guardEventFireLogRollupTable.guardName, guardName) : undefined
    );
  return rows.map((r) => ({
    guardName: r.guardName,
    totalFires: r.totalFires,
    firstFireAt: toIsoOrNull(r.firstFireAt),
    lastFireAt: toIsoOrNull(r.lastFireAt),
  }));
}

/**
 * Override usage per guard over the window. Override fields ride in
 * `payload` by design (schema doc-comment §What deliberately rides in
 * payload); grouping happens SQL-side so the refresh never fetches the
 * window's raw payloads.
 */
export async function fetchFireLogOverrides(
  db: PostgresJsDatabase,
  since: Date,
  guardName?: string
): Promise<FireLogOverrideRow[]> {
  const envVarExpr = sql<string>`${guardEventsTable.payload}->>'overrideEnvVar'`;
  const rows = await db
    .select({
      guardName: guardEventsTable.guardName,
      overrideEnvVar: envVarExpr,
      fires: sql<number>`count(*)::int`,
    })
    .from(guardEventsTable)
    .where(
      and(
        fireLogWhere(since, guardName),
        sql`${guardEventsTable.payload}->>'overrideEnvVar' is not null`
      )
    )
    .groupBy(guardEventsTable.guardName, envVarExpr);
  return rows.map((r) => ({
    guardName: r.guardName as string,
    overrideEnvVar: r.overrideEnvVar,
    fires: r.fires,
  }));
}

// ---------------------------------------------------------------------------
// Join shapes — structural types for the sections other modules own.
// ---------------------------------------------------------------------------

/**
 * Structural mirror of `guard-canary-history.ts`'s GuardCanaryStatus.
 *
 * The optional fields carry that type's ACTUAL names (mt#4057). They were
 * `brokenSince` / `lastRunAt` until then — names the real status object never
 * had, so reading either always yielded `undefined`; the index signature made
 * that type-check and nothing read them, so the divergence was invisible.
 */
export interface CanaryStatusJoin {
  state: string;
  /** Present on `broken`. */
  brokenSinceAt?: string | null;
  /** Present on `broken` — the run that observed it still failing. */
  lastCheckedAt?: string | null;
  /** Present on `passing`. */
  lastVerifiedAt?: string | null;
  [key: string]: unknown;
}

/** Structural mirror of the guard-health tracker's per-guard entry (src/mcp). */
export interface HealthEntryJoin {
  liveness?: string;
  lastCleanRunAt?: string | null;
  failureCount24h?: number;
  failureCount7d?: number;
  consecutiveStreak?: number;
  escalation?: string;
  [key: string]: unknown;
}

/** One declared calibration log's state, mapped to this guard by the sweep's own name mapping. */
export interface CalibrationLogJoin {
  logName: string;
  totalFires: number;
  firesSinceLastReview: number;
  injectedFiresSinceLastReview: number;
  reviewDue: boolean;
  /** Set only when reviewDue — the sweep's own reason vocabulary. */
  reviewDueReason?: string;
  lastReviewedAt: string | null;
}

/** Registry metadata joined from the generated catalog artifact (mt#4010). */
export interface RegistryJoin {
  registered: boolean;
  stratum: string | null;
}

// ---------------------------------------------------------------------------
// Snapshot assembly (pure)
// ---------------------------------------------------------------------------

export interface FireLogWindowSection {
  days: number;
  fires: number;
  byDecision: { allow: number; warn: number; deny: number; other: number };
  overrides: { total: number; byEnvVar: Record<string, number> };
  /** Null when no window row carried a duration. */
  duration: {
    avgMs: number | null;
    p95Ms: number | null;
    maxMs: number | null;
    totalMs: number;
    measuredFires: number;
  } | null;
}

export interface InterceptorAggregateRow {
  guardName: string;
  /** Source: guard_events, stream = 'fire-log'. Always present — this IS the population. */
  fireLog: {
    window: FireLogWindowSection;
    lifetime: { totalFires: number; firstFireAt: string | null; lastFireAt: string | null };
  };
  /** Source: guard_canary_runs (mt#4007). Null = source unavailable this refresh; `never-verified` = genuinely no history. */
  canary: CanaryStatusJoin | null;
  /** Source: guard-health tracker (mt#2812/mt#3892). Null = no tracker entry for this guard, or source unavailable. */
  health: HealthEntryJoin | null;
  /** Source: calibration sweep (mt#2483 pipeline). Null = no declared calibration log maps to this guard. */
  calibration: CalibrationLogJoin[] | null;
  /** Source: generated interceptor catalog artifact (mt#4010). Null = source unavailable. */
  registry: RegistryJoin | null;
}

export interface InterceptorAggregatesSnapshot {
  computedAt: string;
  windowDays: number;
  /** Distinct fire-log guard names — SC3's fire-log-derived population. */
  population: number;
  rows: InterceptorAggregateRow[];
  /**
   * Rows for names the registry catalog DECLARES but the fire log has never
   * recorded (mt#4057).
   *
   * Kept separate from `rows` rather than merged into it, because `population`
   * above is contractually the fire-log-derived count and folding these in
   * would silently redefine it. They exist because the health column needs
   * them: `rows` is built from the fire-log lifetime query, so a declared
   * interceptor that has NEVER fired appears in no row at all — and that is
   * exactly the guard mt#3754 AT2 is about (zero fires, passing canary, must
   * render dormant rather than broken or healthy-by-default). Without this
   * section the dormant state is unreachable by construction.
   *
   * Their fire-log figures are genuinely zero (a measured absence, not a
   * fabricated one); their canary/health/calibration sections are joined the
   * same way every other row's are.
   */
  declaredOnlyRows: InterceptorAggregateRow[];
  /**
   * Snapshot-level review-due list (calibration logs, whether or not their
   * mapped guard appears in the fire-log population) — the above-the-fold
   * attention count reads this, so an unmapped log is never silently dropped.
   */
  calibrationReviewDue: Array<{
    logName: string;
    mappedGuardName: string;
    reason: string;
    injectedFiresSinceLastReview: number;
  }>;
  /** SC2: figure section -> source, spelled out in the payload itself. */
  sources: Record<string, string>;
  /**
   * Sources that failed to fetch THIS refresh (mt#2758 convention:
   * query-layer failure must be distinguishable from genuine no-data). A
   * failed source's sections are null on every row.
   */
  sourceFailures: string[];
  refreshDurationMs: number;
}

export const SNAPSHOT_SOURCES: Record<string, string> = {
  fireLog: "guard_events (stream = 'fire-log')",
  canary: "guard_canary_runs (mt#4007 canary history)",
  health: "guard-health tracker summary (guard-health-log + fire-log tail, mt#3892)",
  calibration: ".minsky calibration logs + review watermarks (calibration-sweep, mt#2483)",
  registry: "src/generated/interceptor-catalog.json (mt#4010)",
};

export interface AssembleInput {
  computedAt: string;
  windowDays: number;
  refreshDurationMs: number;
  decisionCounts: FireLogDecisionCountRow[];
  durations: FireLogDurationRow[];
  /** The population source — assembly is impossible without it. */
  lifetime: FireLogLifetimeRow[];
  overrides: FireLogOverrideRow[];
  /** Null = that source failed this refresh (recorded in sourceFailures). */
  canaryByGuard: ReadonlyMap<string, CanaryStatusJoin> | null;
  healthByGuard: ReadonlyMap<string, HealthEntryJoin> | null;
  calibrationByGuard: ReadonlyMap<string, CalibrationLogJoin[]> | null;
  registryByGuard: ReadonlyMap<string, RegistryJoin> | null;
  calibrationReviewDue: InterceptorAggregatesSnapshot["calibrationReviewDue"] | null;
  /**
   * Every name the registry catalog declares (mt#4057). Those absent from
   * `lifetime` become `declaredOnlyRows`. Omit (or pass empty) to keep the
   * snapshot fire-log-only — a caller that cannot read the catalog artifact
   * should omit rather than guess, since `registryByGuard: null` already
   * records that failure.
   */
  declaredNames?: readonly string[];
}

function bucketDecision(decision: string | null): "allow" | "warn" | "deny" | "other" {
  return decision === "allow" || decision === "warn" || decision === "deny" ? decision : "other";
}

/**
 * Merge fetched fire-log rows with the caller's joins into one snapshot.
 * Pure: no I/O, injected timestamps. Absent-as-absent throughout — a guard
 * missing from a join gets null for that section, never a fabricated zero,
 * and a failed SOURCE is named in `sourceFailures` (its section is null on
 * every row, which is distinguishable from "this guard has no data" only via
 * that list — exactly the mt#2758 distinction).
 */
export function buildWindowSections(
  windowDays: number,
  decisionCounts: FireLogDecisionCountRow[],
  durations: FireLogDurationRow[],
  overrides: FireLogOverrideRow[]
): Map<string, FireLogWindowSection> {
  const byGuardWindow = new Map<string, FireLogWindowSection>();

  const windowSection = (guardName: string): FireLogWindowSection => {
    let section = byGuardWindow.get(guardName);
    if (!section) {
      section = {
        days: windowDays,
        fires: 0,
        byDecision: { allow: 0, warn: 0, deny: 0, other: 0 },
        overrides: { total: 0, byEnvVar: {} },
        duration: null,
      };
      byGuardWindow.set(guardName, section);
    }
    return section;
  };

  for (const row of decisionCounts) {
    const section = windowSection(row.guardName);
    section.fires += row.fires;
    section.byDecision[bucketDecision(row.decision)] += row.fires;
  }
  for (const row of durations) {
    windowSection(row.guardName).duration = {
      avgMs: row.avgMs,
      p95Ms: row.p95Ms,
      maxMs: row.maxMs,
      totalMs: row.totalMs,
      measuredFires: row.measuredFires,
    };
  }
  for (const row of overrides) {
    const section = windowSection(row.guardName);
    section.overrides.total += row.fires;
    section.overrides.byEnvVar[row.overrideEnvVar] =
      (section.overrides.byEnvVar[row.overrideEnvVar] ?? 0) + row.fires;
  }
  return byGuardWindow;
}

export function assembleInterceptorAggregates(input: AssembleInput): InterceptorAggregatesSnapshot {
  const byGuardWindow = buildWindowSections(
    input.windowDays,
    input.decisionCounts,
    input.durations,
    input.overrides
  );

  const windowSection = (guardName: string): FireLogWindowSection =>
    byGuardWindow.get(guardName) ?? {
      days: input.windowDays,
      fires: 0,
      byDecision: { allow: 0, warn: 0, deny: 0, other: 0 },
      overrides: { total: 0, byEnvVar: {} },
      duration: null,
    };

  const sourceFailures: string[] = [];
  if (input.canaryByGuard === null) sourceFailures.push("canary");
  if (input.healthByGuard === null) sourceFailures.push("health");
  if (input.calibrationByGuard === null) sourceFailures.push("calibration");
  if (input.registryByGuard === null) sourceFailures.push("registry");

  const joinsFor = (guardName: string) => ({
    canary: input.canaryByGuard?.get(guardName) ?? null,
    health: input.healthByGuard?.get(guardName) ?? null,
    calibration: input.calibrationByGuard?.get(guardName) ?? null,
    registry: input.registryByGuard?.get(guardName) ?? null,
  });

  const rows: InterceptorAggregateRow[] = [...input.lifetime]
    .sort((a, b) => a.guardName.localeCompare(b.guardName))
    .map((lifetime) => ({
      guardName: lifetime.guardName,
      fireLog: {
        window: windowSection(lifetime.guardName),
        lifetime: {
          totalFires: lifetime.totalFires,
          firstFireAt: lifetime.firstFireAt,
          lastFireAt: lifetime.lastFireAt,
        },
      },
      ...joinsFor(lifetime.guardName),
    }));

  const inFireLog = new Set(rows.map((r) => r.guardName));
  const declaredOnlyRows: InterceptorAggregateRow[] = [...new Set(input.declaredNames ?? [])]
    .filter((name) => !inFireLog.has(name))
    .sort((a, b) => a.localeCompare(b))
    .map((guardName) => ({
      guardName,
      fireLog: {
        // Zero here is MEASURED, not defaulted: the name is declared and the
        // lifetime query — an all-time scan — returned no row for it.
        window: windowSection(guardName),
        lifetime: { totalFires: 0, firstFireAt: null, lastFireAt: null },
      },
      ...joinsFor(guardName),
    }));

  return {
    computedAt: input.computedAt,
    windowDays: input.windowDays,
    population: rows.length,
    rows,
    declaredOnlyRows,
    calibrationReviewDue: input.calibrationReviewDue ?? [],
    sources: SNAPSHOT_SOURCES,
    sourceFailures,
    refreshDurationMs: input.refreshDurationMs,
  };
}
