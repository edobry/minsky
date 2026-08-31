#!/usr/bin/env bun
/**
 * Verify the memory similarity score's ORIENTATION against the live corpus
 * (mt#4787).
 *
 * The unit tests in `similarity-score.test.ts` cover the pure conversion. They
 * cannot cover the thing that actually broke: the conversion being applied at
 * the right place in the REAL wired path. `MemoryService.similar()` reaches a
 * live pgvector store through `PostgresVectorStorage`, and that binding is what
 * this exercises — the §7 "binding direction" check, not a seam-injected one.
 *
 * Checks, mapped to mt#4787's acceptance tests:
 *
 * - **AT1** — the first row carries the highest figure and the sequence is
 *   non-increasing down the list.
 * - **AT4** — discrimination control: the spread between nearest and furthest
 *   is real, not a flat band. A fix that inverted the number AND the order
 *   would satisfy AT1 alone; this is what separates them.
 * - **AT6** — the value `MemoryService` returns equals pgvector's own
 *   `1 - (a <=> b)` for the same pair, to within float32 rounding. This is what
 *   makes the conversion a measurement rather than an assertion.
 * - **Threshold direction** — a minimum-similarity threshold admits the near
 *   neighbours and excludes the far ones. Before mt#4787 it was forwarded
 *   untouched to a filter that reads it as a maximum DISTANCE, i.e. backwards.
 *
 * Read-only: every statement is a SELECT and no memory record is mutated.
 *
 * Usage:
 *   bun scripts/verify-memory-similarity-orientation.ts [--id mem#1344]
 *
 * Exit codes: 0 all checks passed · 1 a check FAILED · 2 could not run.
 */
import "reflect-metadata";
import { sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";

const EXIT_PASS = 0;
const EXIT_FAIL = 1;
const EXIT_INCOMPLETE = 2;

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : (process.argv[i + 1] ?? fallback);
}

const PROBE_ID = arg("id", "mem#1344");

interface Check {
  name: string;
  passed: boolean;
  detail: string;
}
const checks: Check[] = [];
function record(name: string, passed: boolean, detail: string): void {
  checks.push({ name, passed, detail });
  console.log(`[${passed ? "PASS" : "FAIL"}] ${name} — ${detail}`);
}

async function main(): Promise<number> {
  const { initializeConfiguration, CustomConfigFactory } = await import(
    "@minsky/domain/configuration"
  );
  const { createCliContainer } = await import("../src/composition/cli");
  const { PersistenceProvider } = await import("@minsky/domain/persistence/types");
  const { createEmbeddingServiceFromConfig } = await import(
    "@minsky/domain/ai/embedding-service-factory"
  );
  const { createVectorStorageForDomain } = await import(
    "@minsky/domain/storage/vector/vector-storage-factory"
  );
  const { MemoryService } = await import("@minsky/domain/memory");

  await initializeConfiguration(new CustomConfigFactory(), { workingDirectory: process.cwd() });
  const container = await createCliContainer();
  await container.initialize();

  const persistence = container.has("persistence") ? container.get("persistence") : undefined;
  if (!persistence || !(persistence instanceof PersistenceProvider)) {
    console.error("SKIP: no SQL-capable persistence provider configured.");
    return EXIT_INCOMPLETE;
  }
  if (!persistence.capabilities.sql || typeof persistence.getDatabaseConnection !== "function") {
    console.error("SKIP: persistence provider is not SQL-capable.");
    return EXIT_INCOMPLETE;
  }
  const db = (await persistence.getDatabaseConnection()) as PostgresJsDatabase | null;
  if (!db) {
    console.error("SKIP: no database connection.");
    return EXIT_INCOMPLETE;
  }

  const embeddingService = await createEmbeddingServiceFromConfig();
  const vectorStorage = await createVectorStorageForDomain("memory", 1536, persistence);
  const service = new MemoryService({ db, embeddingService, vectorStorage });

  // Resolve the probe's uuid so the SQL cross-check can address the same row.
  const idRows = Array.from(
    (await db.execute(
      sql`SELECT id::text AS id FROM memories WHERE short_id = ${PROBE_ID} LIMIT 1`
    )) as Iterable<{ id: string }>
  );
  const probeUuid = idRows[0]?.id;
  if (!probeUuid) {
    console.error(`SKIP: probe record ${PROBE_ID} not found in this corpus.`);
    return EXIT_INCOMPLETE;
  }

  // ── The REAL wired path ──────────────────────────────────────────────────
  const similar = await service.similar(probeUuid, { limit: 6 });
  if (similar.length < 3) {
    console.error(`SKIP: ${PROBE_ID} has only ${similar.length} neighbours; need >= 3.`);
    return EXIT_INCOMPLETE;
  }

  console.log(`\nMemoryService.similar("${PROBE_ID}") — as the surfaces receive it:`);
  for (const r of similar) {
    console.log(`  ${(r.score * 100).toFixed(0).padStart(3)}%  ${r.record.name.slice(0, 58)}`);
  }
  console.log("");

  // AT1 — non-increasing, top row highest.
  const scores = similar.map((r) => r.score);
  const nonIncreasing = scores.slice(1).every((next, i) => next <= (scores[i] as number) + 1e-9);
  const first = scores[0] as number;
  const last = scores[scores.length - 1] as number;
  record(
    "AT1 orientation",
    nonIncreasing && first >= last,
    `first=${first.toFixed(4)} last=${last.toFixed(4)}, sequence ${nonIncreasing ? "non-increasing" : "NOT monotonic"}`
  );

  // AT4 — discrimination control. A flat band would satisfy AT1 vacuously.
  const spread = first - last;
  record(
    "AT4 discrimination",
    spread > 0.001,
    `spread across ${similar.length} neighbours = ${spread.toFixed(4)} (must be > 0.001; a flat band would pass AT1 without discriminating)`
  );

  // AT6 — agree with pgvector's own cosine for the same pairs.
  let maxDeviation = 0;
  for (const r of similar) {
    const rows = Array.from(
      (await db.execute(sql`
        SELECT (1 - (a.vector <=> b.vector))::float8 AS cosine
        FROM memories_embeddings a, memories_embeddings b
        WHERE a.memory_id = ${probeUuid} AND b.memory_id = ${r.record.id}
      `)) as Iterable<{ cosine: number }>
    );
    const pgCosine = rows[0]?.cosine;
    if (pgCosine === undefined) continue;
    maxDeviation = Math.max(maxDeviation, Math.abs(pgCosine - r.score));
  }
  record(
    "AT6 matches pgvector cosine",
    maxDeviation < 0.001,
    `max |service - pgvector(1 - a<=>b)| = ${maxDeviation.toFixed(6)} across ${similar.length} neighbours (float32 rounding only)`
  );

  // Threshold direction — a minimum-similarity floor between two neighbours
  // must admit the better one and exclude the worse one.
  const mid = (first + last) / 2;
  const thresholded = await service.similar(probeUuid, { limit: 6, threshold: mid });
  const allAboveFloor = thresholded.every((r) => r.score >= mid - 1e-6);
  const droppedSome = thresholded.length < similar.length;
  record(
    "threshold direction",
    allAboveFloor && droppedSome,
    `floor=${mid.toFixed(4)} kept ${thresholded.length}/${similar.length}, ` +
      `all kept >= floor: ${allAboveFloor} (pre-mt#4787 this floor was applied as a MAXIMUM DISTANCE, keeping the opposite set)`
  );

  const failed = checks.filter((c) => !c.passed);
  console.log(`\n${checks.length - failed.length}/${checks.length} checks passed.`);
  return failed.length === 0 ? EXIT_PASS : EXIT_FAIL;
}

if (import.meta.main) {
  main()
    .then((code) => process.exit(code))
    .catch((err) => {
      console.error("SKIP: verification could not complete:", err);
      process.exit(EXIT_INCOMPLETE);
    });
}
