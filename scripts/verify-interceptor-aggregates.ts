#!/usr/bin/env bun
/**
 * Live verification for the interceptor-aggregates query surface (mt#4009,
 * §7a structural-change artifact).
 *
 * Five checks against the REAL database and the REAL on-disk fire-log:
 *
 *  1. CATALOG ROLLUP — runs the four fire-log fetchers the off-request
 *     refresh runs, timed (the AT3 refresh-side figure).
 *  2. DETAIL — runs the single-guard window aggregate for a sampled guard,
 *     timed (the index-served path; expected tens of ms).
 *  3. AT2 EQUALITY — recomputes the sampled guard's decision counts directly
 *     from `~/.local/state/minsky/fire-log.jsonl` over the SAME bounded
 *     window, using the ingest's own `extractPromotedFields` (no second
 *     definition of the mapping), and compares. The window's upper edge sits
 *     30 minutes in the past so ingest lag (5-minute sweep cadence) cannot
 *     produce a spurious mismatch; byte-identical duplicate lines are
 *     collapsed exactly the way `dedupe_key` collapses them on ingest.
 *  4. AT4 COST EQUALITY (mt#4057) — the same comparison for the COST figure the
 *     catalog renders. Kept as its own check rather than folded into (3),
 *     because it has a DIFFERENT denominator: only records carrying a
 *     `duration_ms` reach the aggregate, so a guard with thousands of fires can
 *     have a handful of measured ones, and a total computed over the wrong
 *     subset would still look entirely plausible.
 *
 *  5. ROLLUP DRIFT (mt#4294) — the maintained `guard_event_fire_log_rollup`
 *     against a DIRECT `GROUP BY` recompute from `guard_events`. Every other
 *     check reads the rollup through `fetchFireLogLifetime`, so all of them
 *     would agree with a drifted rollup; this is the only one that can
 *     disagree. Runs the expensive full aggregate ONCE, on purpose — it is the
 *     thing being verified against.
 *
 * Exit 0 = all checks pass (or SKIP: no DB configured / no fire-log file).
 * Exit 1 = a check failed (mismatch or query error), with detail on stdout.
 *
 * Usage: bun scripts/verify-interceptor-aggregates.ts [--guard=<name>]
 */
import "reflect-metadata";

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { createInterface } from "node:readline";
import { and, eq, isNotNull, sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import {
  fetchFireLogDecisionCounts,
  fetchFireLogDurations,
  fetchFireLogLifetime,
  fetchFireLogOverrides,
  CATALOG_WINDOW_DAYS,
} from "@minsky/domain/guard-events/aggregates";
import { extractPromotedFields } from "@minsky/domain/guard-events/parsing";
import { guardEventsTable } from "@minsky/domain/storage/schemas/guard-events-schema";

/** Mirrors scripts/backfill-guard-events.ts's bootstrapDb precedent. */
async function bootstrapDb(): Promise<PostgresJsDatabase | null> {
  const { initializeConfiguration, CustomConfigFactory } = await import(
    "@minsky/domain/configuration"
  );
  const { createCliContainer } = await import("../src/composition/cli");

  await initializeConfiguration(new CustomConfigFactory(), { workingDirectory: process.cwd() });

  const container = await createCliContainer();
  await container.initialize();

  const persistence = container.has("persistence") ? container.get("persistence") : undefined;

  interface SqlCapablePersistence {
    getDatabaseConnection: () => Promise<PostgresJsDatabase | null>;
  }
  const isSqlCapablePersistence = (p: unknown): p is SqlCapablePersistence =>
    !!p &&
    !!(p as { capabilities?: { sql?: boolean } }).capabilities?.sql &&
    typeof (p as { getDatabaseConnection?: unknown }).getDatabaseConnection === "function";

  if (!isSqlCapablePersistence(persistence)) return null;
  return persistence.getDatabaseConnection();
}

function stateDir(): string {
  return process.env.MINSKY_STATE_DIR ?? path.join(os.homedir(), ".local", "state", "minsky");
}

/**
 * Recompute one guard's decision counts from the on-disk fire-log over
 * [since, until], collapsing byte-identical lines the way ingest's
 * `dedupe_key` (sha256 over `<stream>\n<line>`) collapses them.
 *
 * Streams line-by-line (PR #2939 R1 non-blocking): the fire-log is ~92MB and
 * growing ~4MB/day, so a whole-file read doubles as a memory spike the
 * streaming read avoids.
 */
interface DiskRecompute {
  /** Fire counts bucketed by decision (AT2). */
  counts: Record<string, number>;
  /** The cost figure recomputed the same way (mt#4057 AT4). */
  cost: { totalMs: number; measuredFires: number; maxMs: number | null };
}

async function recomputeFromDisk(
  fireLogPath: string,
  guardName: string,
  since: Date,
  until: Date
): Promise<DiskRecompute> {
  const counts: Record<string, number> = {};
  let totalMs = 0;
  let measuredFires = 0;
  let maxMs: number | null = null;
  const seen = new Set<string>();
  const rl = createInterface({
    input: fs.createReadStream(fireLogPath, { encoding: "utf-8" }),
    crlfDelay: Infinity,
  });
  for await (const line of rl) {
    if (line.trim() === "") continue;
    let record: unknown;
    try {
      record = JSON.parse(line);
    } catch {
      continue; // ingest skips unparseable lines the same way
    }
    const promoted = extractPromotedFields(record, undefined);
    if (promoted.guardName !== guardName) continue;
    if (!promoted.occurredAt) continue;
    const at = promoted.occurredAt.getTime();
    if (at < since.getTime() || at > until.getTime()) continue;
    const dedupeKey = createHash("sha256").update(`fire-log\n${line}`).digest("hex");
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    const bucket = promoted.decision ?? "null";
    counts[bucket] = (counts[bucket] ?? 0) + 1;
    // Only records CARRYING a duration reach the aggregate — the SQL side
    // filters on `duration_ms is not null` and counts that column, so the
    // denominator here has to be the same subset or the totals cannot match.
    if (typeof promoted.durationMs === "number" && Number.isFinite(promoted.durationMs)) {
      totalMs += promoted.durationMs;
      measuredFires += 1;
      maxMs = maxMs === null ? promoted.durationMs : Math.max(maxMs, promoted.durationMs);
    }
  }
  return { counts, cost: { totalMs, measuredFires, maxMs } };
}

async function main(): Promise<number> {
  const guardArg = process.argv.find((a) => a.startsWith("--guard="))?.split("=")[1];

  const db = await bootstrapDb();
  if (!db) {
    console.log("SKIP: no SQL-capable persistence provider configured — nothing to verify.");
    return 0;
  }

  const now = Date.now();
  const since = new Date(now - CATALOG_WINDOW_DAYS * 24 * 60 * 60 * 1000);

  // 1. Catalog rollup — the refresh's query set, timed.
  const rollupStart = Date.now();
  const [decisionCounts, durations, lifetime, overrides] = await Promise.all([
    fetchFireLogDecisionCounts(db, since),
    fetchFireLogDurations(db, since),
    fetchFireLogLifetime(db),
    fetchFireLogOverrides(db, since),
  ]);
  const rollupMs = Date.now() - rollupStart;
  console.log(
    JSON.stringify({
      check: "catalog-rollup",
      rollupMs,
      population: lifetime.length,
      windowGuards: new Set(decisionCounts.map((r) => r.guardName)).size,
      durationsRows: durations.length,
      overrideRows: overrides.length,
    })
  );

  // Sample guard: --guard, else the highest-volume guard in the window.
  const byGuardFires = new Map<string, number>();
  for (const row of decisionCounts) {
    byGuardFires.set(row.guardName, (byGuardFires.get(row.guardName) ?? 0) + row.fires);
  }
  const sampledGuard = guardArg ?? [...byGuardFires.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
  if (!sampledGuard) {
    console.log("FAIL: no guard found in the window to sample.");
    return 1;
  }

  // 2. Detail path — the LIVE half of fetchGuardDetail (single-guard window
  // decision counts + durations; lifetime/overrides ride the snapshot), timed.
  const detailStart = Date.now();
  await Promise.all([
    fetchFireLogDecisionCounts(db, since, sampledGuard),
    fetchFireLogDurations(db, since, sampledGuard),
  ]);
  const detailMs = Date.now() - detailStart;
  console.log(JSON.stringify({ check: "detail", guard: sampledGuard, detailMs }));

  // 3. AT2 equality over a bounded window (upper edge 30min back, behind ingest lag).
  const fireLogPath = path.join(stateDir(), "fire-log.jsonl");
  if (!fs.existsSync(fireLogPath)) {
    console.log(`SKIP: AT2 comparison skipped — no fire-log at ${fireLogPath}.`);
    return 0;
  }
  const until = new Date(now - 30 * 60 * 1000);
  const dbRows = await fetchFireLogDecisionCounts(db, since, sampledGuard, until);
  const dbCounts: Record<string, number> = {};
  for (const row of dbRows) {
    const bucket = row.decision ?? "null";
    dbCounts[bucket] = (dbCounts[bucket] ?? 0) + row.fires;
  }
  const { counts: diskCounts, cost: diskCost } = await recomputeFromDisk(
    fireLogPath,
    sampledGuard,
    since,
    until
  );

  const buckets = new Set([...Object.keys(dbCounts), ...Object.keys(diskCounts)]);
  const mismatches: string[] = [];
  for (const bucket of buckets) {
    if ((dbCounts[bucket] ?? 0) !== (diskCounts[bucket] ?? 0)) {
      mismatches.push(`${bucket}: db=${dbCounts[bucket] ?? 0} disk=${diskCounts[bucket] ?? 0}`);
    }
  }
  console.log(
    JSON.stringify({
      check: "at2-equality",
      guard: sampledGuard,
      window: { since: since.toISOString(), until: until.toISOString() },
      dbCounts,
      diskCounts,
      match: mismatches.length === 0,
    })
  );
  if (mismatches.length > 0) {
    console.log(`FAIL: AT2 mismatch for ${sampledGuard}: ${mismatches.join("; ")}`);
    return 1;
  }

  // 4. mt#4057 AT4 — the COST figure the catalog renders, recomputed from the
  //    same stream over the same bounded window. Compared separately from AT2
  //    because it has a different denominator: only records carrying a
  //    `duration_ms` reach it, so a guard can have thousands of fires and a
  //    handful of measured ones, and a total that silently covered the wrong
  //    subset would still look plausible.
  const dbDurationRows = await fetchFireLogDurations(db, since, sampledGuard, until);
  const dbCost = dbDurationRows[0] ?? { totalMs: 0, measuredFires: 0, maxMs: null };
  const costMismatches: string[] = [];
  if (dbCost.measuredFires !== diskCost.measuredFires) {
    costMismatches.push(`measuredFires: db=${dbCost.measuredFires} disk=${diskCost.measuredFires}`);
  }
  // Float sums over the same values in a different order can differ in the last
  // bits; a sub-millisecond gap over a 7-day total is float arithmetic, not a
  // wrong subset. Anything larger is a real disagreement.
  if (Math.abs(dbCost.totalMs - diskCost.totalMs) > 1) {
    costMismatches.push(`totalMs: db=${dbCost.totalMs} disk=${diskCost.totalMs}`);
  }
  if ((dbCost.maxMs ?? null) !== (diskCost.maxMs ?? null)) {
    costMismatches.push(`maxMs: db=${String(dbCost.maxMs)} disk=${String(diskCost.maxMs)}`);
  }
  console.log(
    JSON.stringify({
      check: "at4-cost-equality",
      guard: sampledGuard,
      window: { since: since.toISOString(), until: until.toISOString() },
      db: { totalMs: dbCost.totalMs, measuredFires: dbCost.measuredFires, maxMs: dbCost.maxMs },
      disk: diskCost,
      match: costMismatches.length === 0,
    })
  );
  if (costMismatches.length > 0) {
    console.log(`FAIL: AT4 cost mismatch for ${sampledGuard}: ${costMismatches.join("; ")}`);
    return 1;
  }

  // 5. ROLLUP DRIFT (mt#4294) — the maintained lifetime rollup vs a DIRECT
  //    recompute from `guard_events`.
  //
  //    This is the check that keeps the rollup honest. Every other check above
  //    reads it through `fetchFireLogLifetime`, so they would agree with a
  //    drifted rollup just as readily as with a correct one — a rollup that
  //    silently under-counts produces no error anywhere, only smaller numbers.
  //    Recomputing from the corpus is the only thing here that can disagree.
  //
  //    Deliberately the ONE place the expensive full `GROUP BY` still runs on
  //    purpose: it is the thing being verified against, and it runs once per
  //    invocation of a script an operator ran, not on a five-minute timer.
  const driftStart = Date.now();
  const recomputedRows = await db
    .select({
      guardName: guardEventsTable.guardName,
      totalFires: sql<number>`count(*)::int`,
    })
    .from(guardEventsTable)
    .where(and(eq(guardEventsTable.stream, "fire-log"), isNotNull(guardEventsTable.guardName)))
    .groupBy(guardEventsTable.guardName);
  const driftMs = Date.now() - driftStart;

  const truth = new Map(recomputedRows.map((r) => [r.guardName as string, r.totalFires]));
  const stored = new Map(lifetime.map((r) => [r.guardName, r.totalFires]));

  const driftEntries: string[] = [];
  for (const [guardName, expected] of truth) {
    const actual = stored.get(guardName);
    if (actual === undefined) {
      driftEntries.push(`${guardName}: missing from rollup (corpus has ${expected})`);
    } else if (actual !== expected) {
      driftEntries.push(`${guardName}: rollup ${actual} vs corpus ${expected}`);
    }
  }
  for (const guardName of stored.keys()) {
    if (!truth.has(guardName)) {
      driftEntries.push(`${guardName}: in rollup but absent from the corpus`);
    }
  }

  console.log(
    JSON.stringify({
      check: "rollup-drift",
      driftMs,
      corpusGuards: truth.size,
      rollupGuards: stored.size,
      match: driftEntries.length === 0,
    })
  );
  if (driftEntries.length > 0) {
    const more = driftEntries.length > 10 ? ` (+${driftEntries.length - 10} more)` : "";
    console.log(
      `FAIL: lifetime rollup has drifted from the corpus: ${driftEntries.slice(0, 10).join("; ")}${more}`
    );
    return 1;
  }

  console.log(
    "PASS: rollup + detail + AT2 count equality + AT4 cost equality + rollup-drift verified against the live corpus."
  );
  return 0;
}

if (import.meta.main) {
  main()
    .then((code) => process.exit(code))
    .catch((err) => {
      console.error("FAIL: verification errored:", err instanceof Error ? err.message : err);
      process.exit(1);
    });
}
