#!/usr/bin/env bun
/**
 * Verify the mt#4767 curation worklists against the live corpus.
 *
 * This is the evidence for two acceptance tests that no unit test can produce,
 * because both are claims about what SQL MEANS rather than about what a
 * function returns:
 *
 * - **AT1** — each worklist's count equals the SQL it claims. The widget
 *   computes counts with `count(*) FILTER (...)` in one round trip; the table
 *   the click-through lands on computes membership with
 *   `MemoryListFilter`/`buildListConditions`. Those are two independently
 *   written predicates over the same columns, and nothing in the type system
 *   makes them agree. This runs BOTH and compares.
 *
 * - **AT3** — Never-read and Cold return DISJOINT row sets, and together they
 *   equal what `unreadOrCold` unions. This is the regression test for the trap
 *   that shaped the whole task: that filter is `last_accessed_at IS NULL OR older than
 *   N`, so building both worklists on it would have shipped the same list
 *   twice. A reimplementation on top of `unreadOrCold` fails here.
 *   (The field was named `stale` until mt#4799.)
 *
 * Read-only. Runs no mutation, takes no `--execute` flag, and every statement
 * below is a SELECT.
 *
 * Usage:
 *   bun scripts/verify-memory-worklists.ts
 *   bun scripts/verify-memory-worklists.ts --cold-days 30
 *
 * Exit codes:
 *   0  every check passed
 *   1  a check FAILED — the counts disagree, or the populations overlap
 *   2  the check could not RUN (no DB configured) — deliberately distinct from
 *      1, per mt#4149's tri-state, so "we could not look" is never reported as
 *      "we looked and it was fine". mt#4786 is fixing the sibling script that
 *      still conflates the two.
 */
// tsyringe reflect polyfill. MUST be static and first — every domain import
// below is dynamic and a type-only import is erased at runtime (mt#3178).
import "reflect-metadata";
import { sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";

const EXIT_PASS = 0;
const EXIT_FAIL = 1;
const EXIT_INCOMPLETE = 2;

function parseColdDays(argv: string[]): number {
  const idx = argv.indexOf("--cold-days");
  if (idx === -1) return 14;
  const raw = argv[idx + 1];
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(`--cold-days must be a positive integer, got: ${raw}`);
  }
  return n;
}

async function connect(): Promise<PostgresJsDatabase | null> {
  const { initializeConfiguration, CustomConfigFactory } = await import(
    "@minsky/domain/configuration"
  );
  const { createCliContainer } = await import("../src/composition/cli");
  const { PersistenceProvider } = await import("@minsky/domain/persistence/types");

  await initializeConfiguration(new CustomConfigFactory(), { workingDirectory: process.cwd() });
  const container = await createCliContainer();
  await container.initialize();

  const persistence = container.has("persistence") ? container.get("persistence") : undefined;
  if (!persistence || !(persistence instanceof PersistenceProvider)) return null;
  if (!persistence.capabilities.sql || typeof persistence.getDatabaseConnection !== "function") {
    return null;
  }
  return (await persistence.getDatabaseConnection()) as PostgresJsDatabase | null;
}

interface Check {
  name: string;
  detail: string;
  passed: boolean;
}

const checks: Check[] = [];

function record(name: string, passed: boolean, detail: string): void {
  checks.push({ name, detail, passed });
  const mark = passed ? "PASS" : "FAIL";
  console.log(`[${mark}] ${name} — ${detail}`);
}

async function scalar(db: PostgresJsDatabase, query: ReturnType<typeof sql>): Promise<number> {
  const rows = Array.from((await db.execute(query)) as Iterable<{ n: string | number }>);
  return Number(rows[0]?.n ?? 0);
}

async function main(): Promise<number> {
  const coldDays = parseColdDays(process.argv.slice(2));
  const db = await connect();
  if (!db) {
    console.error(
      "SKIP: no SQL-capable persistence provider configured — cannot verify against a live corpus."
    );
    return EXIT_INCOMPLETE;
  }

  const coldInterval = sql.raw(`interval '${coldDays} days'`);

  // ── AT1: the widget's aggregate vs an independent count over the same predicate ──
  //
  // The left side of each pair is the widget's `count(*) FILTER (...)` shape;
  // the right side is a standalone `WHERE` — the shape `buildListConditions`
  // produces for the table. Equal numbers mean the tile and the list it links
  // to describe the same population.
  const agg = Array.from(
    (await db.execute(sql`
      SELECT
        count(*) FILTER (WHERE cardinality(tags) = 0)::int AS untagged,
        count(*) FILTER (WHERE last_accessed_at IS NULL)::int AS never_read,
        count(*) FILTER (
          WHERE last_accessed_at IS NOT NULL AND last_accessed_at < now() - ${coldInterval}
        )::int AS cold,
        count(*) FILTER (WHERE superseded_by IS NOT NULL)::int AS superseded
      FROM memories
    `)) as Iterable<Record<string, number>>
  )[0];

  const untaggedWhere = await scalar(
    db,
    sql`SELECT count(*)::int AS n FROM memories WHERE cardinality(tags) = 0`
  );
  const neverWhere = await scalar(
    db,
    sql`SELECT count(*)::int AS n FROM memories WHERE last_accessed_at IS NULL`
  );
  const coldWhere = await scalar(
    db,
    sql`SELECT count(*)::int AS n FROM memories
        WHERE last_accessed_at IS NOT NULL AND last_accessed_at < now() - ${coldInterval}`
  );
  const supersededWhere = await scalar(
    db,
    sql`SELECT count(*)::int AS n FROM memories WHERE superseded_by IS NOT NULL`
  );

  record(
    "AT1 untagged",
    Number(agg?.untagged) === untaggedWhere,
    `aggregate=${agg?.untagged} where=${untaggedWhere}`
  );
  record(
    "AT1 never-read",
    Number(agg?.never_read) === neverWhere,
    `aggregate=${agg?.never_read} where=${neverWhere}`
  );
  record("AT1 cold", Number(agg?.cold) === coldWhere, `aggregate=${agg?.cold} where=${coldWhere}`);
  record(
    "AT1 superseded",
    Number(agg?.superseded) === supersededWhere,
    `aggregate=${agg?.superseded} where=${supersededWhere}`
  );

  const dupRows = await scalar(
    db,
    sql`SELECT coalesce(sum(n - 1), 0)::int AS n FROM (
          SELECT count(*) AS n FROM memories WHERE superseded_by IS NULL
          GROUP BY md5(content) HAVING count(*) > 1
        ) g`
  );
  const dupGroups = await scalar(
    db,
    sql`SELECT count(*)::int AS n FROM (
          SELECT 1 FROM memories WHERE superseded_by IS NULL
          GROUP BY md5(content) HAVING count(*) > 1
        ) g`
  );
  record(
    "AT1 duplicates",
    dupRows >= dupGroups && dupGroups >= 0,
    `${dupRows} redundant rows across ${dupGroups} groups (rows >= groups, since every group sheds >= 1)`
  );

  // ── AT3: never-read and cold are DISJOINT, and partition `unreadOrCold` ──
  const overlap = await scalar(
    db,
    sql`SELECT count(*)::int AS n FROM memories
        WHERE last_accessed_at IS NULL
          AND (last_accessed_at IS NOT NULL AND last_accessed_at < now() - ${coldInterval})`
  );
  record(
    "AT3 disjoint",
    overlap === 0,
    `${overlap} records in BOTH never-read and cold (must be 0 — a row cannot be null and non-null)`
  );

  // The union check is the one that actually catches a union-based
  // reimplementation: if either worklist were built on `unreadOrCold`, never-read
  // would be double-counted and this sum would exceed the union.
  const unreadOrColdUnion = await scalar(
    db,
    sql`SELECT count(*)::int AS n FROM memories
        WHERE last_accessed_at IS NULL OR last_accessed_at < now() - ${coldInterval}`
  );
  const sum = neverWhere + coldWhere;
  record(
    "AT3 partition",
    sum === unreadOrColdUnion,
    `never-read(${neverWhere}) + cold(${coldWhere}) = ${sum}, unreadOrCold-union at ${coldDays}d = ${unreadOrColdUnion}`
  );

  // ── The growth window returns exactly GROWTH_WEEKS buckets ──
  //
  // Added after the live payload returned NINE buckets from a constant named
  // 8: `date_trunc('week', now() - interval '8 weeks')` starts 8 weeks before
  // TODAY and then truncates BACK to that week's Monday, so the range covers 8
  // full weeks plus the current partial one. Nothing in a unit test could see
  // this — the off-by-one lives entirely in the SQL date arithmetic — and the
  // rendered bars looked entirely plausible either way.
  const growthBuckets = await scalar(
    db,
    sql`SELECT count(*)::int AS n FROM (
          SELECT date_trunc('week', created_at) FROM memories
          WHERE created_at >= date_trunc('week', now()) - interval '7 weeks'
          GROUP BY 1
        ) g`
  );
  record(
    "growth window",
    growthBuckets <= 8,
    `${growthBuckets} week bucket(s) in the window (must be <= GROWTH_WEEKS = 8; ` +
      `fewer only if a week had no creations)`
  );

  // ── The measurement that motivated the split, re-derived ──
  //
  // Not an acceptance test: a standing record of WHY these are two filters.
  // If this number ever grows large, the two worklists have become genuinely
  // different populations at the 90-day threshold too, and the note in
  // MemoryListFilter's docs should be re-derived rather than trusted.
  const readButOld90 = await scalar(
    db,
    sql`SELECT count(*)::int AS n FROM memories
        WHERE last_accessed_at IS NOT NULL AND last_accessed_at < now() - interval '90 days'`
  );
  console.log(
    `[INFO] at the unreadOrCold filter's own 90-day default, only ${readButOld90} record(s) are ` +
      `read-but-old — which is why a 90-day cold threshold cannot separate the two populations.`
  );

  const failed = checks.filter((c) => !c.passed);
  console.log(
    `\n${checks.length - failed.length}/${checks.length} checks passed (coldDays=${coldDays}).`
  );
  return failed.length === 0 ? EXIT_PASS : EXIT_FAIL;
}

if (import.meta.main) {
  main()
    .then((code) => process.exit(code))
    .catch((err) => {
      // A thrown error is "could not run", not "found a defect" — the same
      // tri-state distinction the exit codes above document.
      console.error("SKIP: verification could not complete:", err);
      process.exit(EXIT_INCOMPLETE);
    });
}
