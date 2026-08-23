/**
 * Interceptor-aggregates cache (mt#4009) — the impure PRODUCER half of the
 * catalog aggregation surface. Mirrors `topology-cache.ts`: a periodic
 * refresh (driven by `startInterceptorAggregatesSweeper` in sweepers.ts) does
 * the expensive reads once per cadence tick — the catalog-wide `guard_events`
 * rollup measured at 2.73s cold (mt#4009 `## Plan`), the canary-history batch
 * read, the guard-health tracker summary, and the calibration sweep — and
 * writes one in-process snapshot; the `interceptor-aggregates` widget's
 * catalog path reads ONLY that snapshot, never querying per request.
 *
 * Per-guard DETAIL reads are the exception and stay LIVE: a single-guard
 * window aggregate is index-served (`(guard_name, occurred_at)`, measured
 * 18.6ms) — see {@link fetchGuardDetail}.
 *
 * Single-definition joins (mt#3754 criterion 6): canary state comes from
 * `guard-canary-history.ts` (`deriveGuardCanaryStatus`), health/liveness from
 * `GuardHealthTracker.getSummary()` (mt#3892), review-due from
 * `calibration-sweep.ts`'s `runSweep` + `computeReviewDueLogs` (the same
 * functions `observability.calibration-review` and the cadence hook consume),
 * and the log→guard name mapping from `guardNameForCalibrationLog` — nothing
 * here recomputes a figure that already has an owner.
 *
 * Failure posture (mt#2758 convention): each source degrades independently —
 * a failed source is named in the snapshot's `sourceFailures` and its
 * sections are null, never zero-filled. A failed POPULATION query (fire-log
 * lifetime) fails the whole refresh; the previous snapshot is kept so the
 * widget serves stale-but-honest data with its `computedAt` visible.
 */
import * as fs from "fs";
import * as path from "path";
import { log } from "@minsky/shared/logger";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import {
  assembleInterceptorAggregates,
  fetchFireLogDecisionCounts,
  fetchFireLogDurations,
  fetchFireLogLifetime,
  fetchFireLogOverrides,
  buildWindowSections,
  CATALOG_WINDOW_DAYS,
  type CalibrationLogJoin,
  type CanaryStatusJoin,
  type FireLogWindowSection,
  type HealthEntryJoin,
  type InterceptorAggregateRow,
  type InterceptorAggregatesSnapshot,
  type RegistryJoin,
} from "@minsky/domain/guard-events/aggregates";
import { buildGuardCanaryHistoryRepository } from "@minsky/domain/observability/guard-canary-history";
import {
  runSweep,
  computeReviewDueLogs,
  guardNameForCalibrationLog,
  type WatermarkStore,
} from "../domain/calibration/calibration-sweep";
import { buildSweptEntries } from "../domain/calibration/swept-entries";
// mt#4398 — see `passkey-store.ts` for why this wrapper rather than the domain
// helper directly.
import { describeServerPersistenceUnavailability } from "./db-providers";
import { GuardHealthTracker } from "../mcp/guard-health-tracker";
import { createCachedSqlDbGetter } from "./db-providers";
import { findRepoRoot } from "./web-dist";
import { parseCatalog } from "./widgets/interceptors";
import catalogJson from "../generated/interceptor-catalog.json";

const WATERMARK_STORE_PATH = ".minsky/calibration-review-watermarks.json";

// ---------------------------------------------------------------------------
// In-process cache + seams
// ---------------------------------------------------------------------------

let cached: InterceptorAggregatesSnapshot | null = null;

export function getCachedInterceptorAggregates(): InterceptorAggregatesSnapshot | null {
  return cached;
}

/** Test seam: reset the module-level cache between tests. */
export function resetInterceptorAggregatesCacheForTests(): void {
  cached = null;
}

/** Test seam: directly set the module-level cache, bypassing real I/O. */
export function setInterceptorAggregatesCacheForTests(
  snapshot: InterceptorAggregatesSnapshot | null
): void {
  cached = snapshot;
}

/** Lazy-cached real DB resolution (db-providers pattern; retries until first success). */
const getDb = createCachedSqlDbGetter({ cacheNegative: false });

// ---------------------------------------------------------------------------
// Source readers — each guarded independently
// ---------------------------------------------------------------------------

async function guarded<T>(source: string, read: () => Promise<T>): Promise<T | null> {
  try {
    return await read();
  } catch (err) {
    log.warn(`cockpit: interceptor-aggregates: ${source} source failed this refresh`, {
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

function readHealthByGuard(): Map<string, HealthEntryJoin> {
  const summary = GuardHealthTracker.getInstance().getSummary();
  const map = new Map<string, HealthEntryJoin>();
  for (const [guardName, entry] of Object.entries(summary.byGuard)) {
    map.set(guardName, {
      liveness: entry.liveness,
      lastCleanRunAt: entry.lastCleanRunAt ?? null,
      failureCount24h: entry.failureCount24h,
      failureCount7d: entry.failureCount7d,
      consecutiveStreak: entry.consecutiveStreak,
      escalation: entry.escalation,
    });
  }
  return map;
}

interface CalibrationSections {
  byGuard: Map<string, CalibrationLogJoin[]>;
  reviewDue: InterceptorAggregatesSnapshot["calibrationReviewDue"];
}

async function readCalibrationSections(repoRoot: string): Promise<CalibrationSections> {
  const entries = await buildSweptEntries();
  const watermarks = readWatermarks(repoRoot);
  const results = await runSweep(
    entries,
    async (relPath) => {
      try {
        return String(fs.readFileSync(path.join(repoRoot, relPath), "utf-8"));
      } catch {
        return null;
      }
    },
    watermarks
  );
  const due = computeReviewDueLogs(results, watermarks, Date.now());
  const dueByLogName = new Map(due.map((d) => [d.name, d]));

  const byGuard = new Map<string, CalibrationLogJoin[]>();
  for (const result of results) {
    const guardName = guardNameForCalibrationLog(result.entry.name);
    const dueEntry = dueByLogName.get(result.entry.name);
    const join: CalibrationLogJoin = {
      logName: result.entry.name,
      totalFires: result.totalFires,
      firesSinceLastReview: result.firesSinceLastReview,
      injectedFiresSinceLastReview: result.injectedFiresSinceLastReview,
      reviewDue: dueEntry !== undefined,
      ...(dueEntry ? { reviewDueReason: dueEntry.reason } : {}),
      lastReviewedAt: watermarks[result.entry.path]?.lastReviewedAt ?? null,
    };
    const list = byGuard.get(guardName) ?? [];
    list.push(join);
    byGuard.set(guardName, list);
  }

  return {
    byGuard,
    reviewDue: due.map((d) => ({
      logName: d.name,
      mappedGuardName: guardNameForCalibrationLog(d.name),
      reason: d.reason,
      injectedFiresSinceLastReview: d.injectedFiresSinceLastReview,
    })),
  };
}

function readWatermarks(repoRoot: string): WatermarkStore {
  try {
    const content = String(fs.readFileSync(path.join(repoRoot, WATERMARK_STORE_PATH), "utf-8"));
    const parsed: unknown = JSON.parse(content);
    return typeof parsed === "object" && parsed !== null ? (parsed as WatermarkStore) : {};
  } catch {
    return {};
  }
}

function readRegistryByGuard(): Map<string, RegistryJoin> {
  const catalog = parseCatalog(catalogJson);
  const map = new Map<string, RegistryJoin>();
  for (const entry of catalog.entries) {
    map.set(entry.guardName, { registered: entry.registered, stratum: entry.stratum });
  }
  return map;
}

// ---------------------------------------------------------------------------
// Refresh (sweeper tick body)
// ---------------------------------------------------------------------------

/**
 * Refresh the snapshot, reporting whether it actually succeeded (mt#4294).
 *
 * The `ok` flag is the point. This tick applies its own fail-open try/catch —
 * correct, a failed refresh must not crash the cockpit — but until now it also
 * returned nothing, so `createIntervalSweeper` recorded every failure as a
 * COMPLETED tick. The scheduler could not tell a refresh that served a fresh
 * snapshot from one that bailed on a dead source, which is why nothing could
 * back off however long the failure persisted: there was no failure signal to
 * back off from. Returning the mt#3684 `SweepTickResult` shape puts the
 * outcome where `consecutiveDomainFailures` can see it.
 *
 * "No SQL-capable DB" reports `ok: true` deliberately — that is an
 * INAPPLICABLE tick, not a failed one, and counting it as a failure would
 * back off a cockpit that simply has no database configured.
 */
export async function refreshInterceptorAggregates(): Promise<{ ok: boolean }> {
  const startedAt = Date.now();
  const db = await getDb();
  if (!db) {
    log.debug("cockpit: interceptor-aggregates refresh: no SQL-capable DB, keeping prior snapshot");
    return { ok: true };
  }

  const since = new Date(startedAt - CATALOG_WINDOW_DAYS * 24 * 60 * 60 * 1000);
  const repoRoot = findRepoRoot([process.cwd()]) ?? process.cwd();

  // Independent reads start together (mem#868: serialized independent awaits
  // were the dominant cockpit latency cost); canary follows lifetime because
  // it needs the population's names.
  const [decisionCounts, durations, lifetime, overrides, calibration] = await Promise.all([
    guarded("fire-log decision counts", () => fetchFireLogDecisionCounts(db, since)),
    guarded("fire-log durations", () => fetchFireLogDurations(db, since)),
    guarded("fire-log lifetime", () => fetchFireLogLifetime(db)),
    guarded("fire-log overrides", () => fetchFireLogOverrides(db, since)),
    guarded("calibration sweep", () => readCalibrationSections(repoRoot)),
  ]);

  if (!lifetime || !decisionCounts) {
    // The population (and its window counts) IS the snapshot; without it there
    // is nothing honest to serve. Keep the previous snapshot (stale-but-honest,
    // its computedAt says so) rather than replacing it with a fabricated empty.
    log.warn("cockpit: interceptor-aggregates refresh failed on the fire-log source", {
      lifetimeOk: lifetime !== null,
      decisionCountsOk: decisionCounts !== null,
    });
    return { ok: false };
  }

  // Read the registry BEFORE the canary batch: the canary lookup covers the
  // UNION of the fire-log population and the declared one (mt#4057). A
  // declared interceptor that has never fired is absent from `lifetime`
  // entirely, so keying canary off `lifetime` alone would leave exactly the
  // never-fired guards — the dormant case — permanently unverifiable.
  const registryByGuard = await guarded("registry catalog artifact", async () =>
    readRegistryByGuard()
  );
  const declaredNames = registryByGuard ? [...registryByGuard.keys()] : [];
  const canaryNames = [...new Set([...lifetime.map((row) => row.guardName), ...declaredNames])];

  const canaryByGuard = await guarded("canary history", async () => {
    const repo = buildGuardCanaryHistoryRepository(db as PostgresJsDatabase);
    if (!repo) throw new Error("canary repository unavailable");
    const statuses = await repo.getGuardStatuses(canaryNames);
    const map = new Map<string, CanaryStatusJoin>();
    for (const [guardName, status] of statuses) {
      map.set(guardName, { ...status });
    }
    // Guards absent from the repository result carry never-verified implicitly
    // (guard-canary-history contract); make that explicit so a consumer never
    // confuses "no canary rows" with "canary source failed".
    for (const guardName of canaryNames) {
      if (!map.has(guardName)) map.set(guardName, { state: "never-verified" });
    }
    return map;
  });

  const healthByGuard = await guarded("guard-health summary", async () => readHealthByGuard());

  cached = assembleInterceptorAggregates({
    computedAt: new Date(startedAt).toISOString(),
    windowDays: CATALOG_WINDOW_DAYS,
    refreshDurationMs: Date.now() - startedAt,
    decisionCounts,
    durations: durations ?? [],
    lifetime,
    overrides: overrides ?? [],
    canaryByGuard,
    healthByGuard,
    calibrationByGuard: calibration?.byGuard ?? null,
    registryByGuard,
    calibrationReviewDue: calibration?.reviewDue ?? null,
    declaredNames,
  });

  return { ok: true };
}

// ---------------------------------------------------------------------------
// Per-guard detail (live, request-time — index-served)
// ---------------------------------------------------------------------------

export interface InterceptorDetailResult {
  guardName: string;
  windowDays: number;
  /**
   * The composed row. The window's decision counts + duration aggregates are
   * LIVE (single-guard, window-bounded — the index-served queries); the
   * window's override figures and the health/calibration/registry sections
   * ride the SNAPSHOT at its refresh cadence (`snapshotComputedAt`). The
   * payload-detoasting override scan measured multi-second live on the
   * corpus's highest-volume guard (verify script, 2026-08-12), so it stays off
   * the request path like the catalog itself. Canary is live (few rows per
   * guard).
   *
   * The LIFETIME totals used to be in that off-request set for the same
   * reason, and no longer are (mt#4294): they now come from the maintained
   * `guard_event_fire_log_rollup`, where the single-guard read is a
   * primary-key lookup. Measured before the change, the live single-guard
   * lifetime query took 10,972 ms — worse than the full-catalog rollup's
   * 2,193 ms, because filtering by `guard_name` trades a sequential scan for
   * a bitmap heap scan over ~37,688 scattered blocks. It still prefers the
   * snapshot row when one exists, purely to avoid a second round trip.
   */
  row: InterceptorAggregateRow | null;
  /** True when the guard has no live window rows AND no snapshot row — unknown to the fire log. */
  unknownToFireLog: boolean;
  snapshotComputedAt: string | null;
}

export async function fetchGuardDetail(guardName: string): Promise<InterceptorDetailResult> {
  const db = await getDb();
  if (!db) {
    // mt#4398: "no SQL-capable database available" is true and unactionable —
    // it does not say whether Postgres is unconfigured or configured-and-failed,
    // which need opposite responses. Same fix as the two store siblings.
    throw new Error(
      `no SQL-capable database available. ${await describeServerPersistenceUnavailability()}`
    );
  }

  const since = new Date(Date.now() - CATALOG_WINDOW_DAYS * 24 * 60 * 60 * 1000);
  const [decisionCounts, durations, canary] = await Promise.all([
    fetchFireLogDecisionCounts(db, since, guardName),
    fetchFireLogDurations(db, since, guardName),
    guarded("canary history (detail)", async () => {
      const repo = buildGuardCanaryHistoryRepository(db as PostgresJsDatabase);
      if (!repo) throw new Error("canary repository unavailable");
      const status = await repo.getGuardStatus(guardName);
      const join: CanaryStatusJoin = { ...status };
      return join;
    }),
  ]);

  const snapshot = cached;
  const snapshotRow = snapshot?.rows.find((r) => r.guardName === guardName);
  const declaredOnlyRow = snapshot?.declaredOnlyRows.find((r) => r.guardName === guardName);

  if (decisionCounts.length === 0 && !snapshotRow) {
    // Declared but never fired (mt#4057). Still unknown to the FIRE LOG — the
    // flag stays true and the zero counts stay zero — but not unknown to the
    // system: its canary state is what makes the dormant verdict possible, so
    // return the declared-only row rather than a null that erases it.
    return {
      guardName,
      windowDays: CATALOG_WINDOW_DAYS,
      row: declaredOnlyRow ? { ...declaredOnlyRow, canary } : null,
      unknownToFireLog: true,
      snapshotComputedAt: snapshot?.computedAt ?? null,
    };
  }

  const liveWindow = buildWindowSections(CATALOG_WINDOW_DAYS, decisionCounts, durations, []).get(
    guardName
  );
  const window: FireLogWindowSection = liveWindow ?? {
    days: CATALOG_WINDOW_DAYS,
    fires: 0,
    byDecision: { allow: 0, warn: 0, deny: 0, other: 0 },
    overrides: { total: 0, byEnvVar: {} },
    duration: null,
  };
  // Overrides ride the snapshot cadence (see the doc comment above).
  if (snapshotRow) window.overrides = snapshotRow.fireLog.window.overrides;

  // Rare pre-first-tick path: no snapshot row to source lifetime from. Run the
  // single-guard lifetime query live rather than fabricating zeros — slower
  // (all-time scan for one guard), but only reachable before the first
  // refresh completes.
  const lifetime = snapshotRow?.fireLog.lifetime ??
    (await fetchFireLogLifetime(db, guardName)).map((r) => ({
      totalFires: r.totalFires,
      firstFireAt: r.firstFireAt,
      lastFireAt: r.lastFireAt,
    }))[0] ?? { totalFires: 0, firstFireAt: null, lastFireAt: null };

  const row: InterceptorAggregateRow = {
    guardName,
    fireLog: {
      window,
      lifetime,
    },
    canary,
    health: snapshotRow?.health ?? null,
    calibration: snapshotRow?.calibration ?? null,
    registry: snapshotRow?.registry ?? null,
  };

  return {
    guardName,
    windowDays: CATALOG_WINDOW_DAYS,
    row,
    unknownToFireLog: false,
    snapshotComputedAt: snapshot?.computedAt ?? null,
  };
}
