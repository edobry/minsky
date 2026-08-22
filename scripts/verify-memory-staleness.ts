#!/usr/bin/env bun
/**
 * Live verification + fire-rate measurement for memory-staleness annotation (mt#1709).
 *
 * Two jobs, deliberately one script:
 *
 * 1. **Verification artifact (§7a).** The detection path reads a live Postgres corpus and a
 *    live tasks table; no unit test covers whether the real wiring resolves, whether real
 *    memory prose matches the patterns, or whether the batched lookup returns what the core
 *    expects. This exercises the real `createTaskStatusLookup` against the real DB.
 *
 * 2. **Fire-rate measurement.** The precision requirement is not "does it work" but "does it
 *    stay quiet". An annotation that fires on most results is noise, and the only way to know
 *    is to run the detector over the actual corpus and count. Reports the fire rate so the
 *    number in the PR body is measured rather than asserted.
 *
 * Usage:
 *   bun scripts/verify-memory-staleness.ts            # summary
 *   bun scripts/verify-memory-staleness.ts --verbose  # also list each firing memory
 *   bun scripts/verify-memory-staleness.ts --json     # structured output for a results file
 *
 * Exits 0 on success (including a clean SKIP when no DB is configured), 1 on failure.
 *
 * @see packages/domain/src/memory/staleness.ts — the core under test
 * @see mt#1709
 */

// tsyringe reflect polyfill. MUST be static and first: the domain imports below are
// dynamic, so nothing else in this file loads the polyfill, and the first tsyringe
// decorator would throw before the first query (mt#3178 — the same defect that left
// `scripts/backfill-memory-associations.ts` dead for two months).
import "reflect-metadata";

interface Summary {
  totalMemories: number;
  withClause: number;
  stale: number;
  current: number;
  unresolved: number;
  fireRatePercent: number;
  staleRecords: { shortId?: string; name: string; completed: string[] }[];
  unresolvedRecords: { shortId?: string; name: string; refs: string[] }[];
}

async function main(): Promise<number> {
  const verbose = process.argv.includes("--verbose");
  const asJson = process.argv.includes("--json");

  const { initializeConfiguration, CustomConfigFactory } = await import(
    "@minsky/domain/configuration"
  );
  await initializeConfiguration(new CustomConfigFactory(), {
    workingDirectory: process.cwd(),
  });

  const { createCliContainer } = await import("../src/composition/cli");
  const { PersistenceProvider } = await import("@minsky/domain/persistence/types");

  const container = await createCliContainer();
  // `initialize()` is what actually stands up the persistence binding — without it the
  // container resolves nothing and every probe below reports a clean SKIP, which is the
  // can't-fail-probe shape this script exists to avoid producing.
  await container.initialize();

  const persistence = container.has("persistence") ? container.get("persistence") : undefined;

  if (!(persistence instanceof PersistenceProvider) || !persistence.capabilities.sql) {
    // Skip gracefully rather than fail — §7a's env-gating contract.
    console.log("SKIP: no SQL-capable persistence provider configured; nothing to verify.");
    return 0;
  }

  const db = await persistence.getDatabaseConnection();
  if (!db) {
    console.log("SKIP: persistence provider returned no database connection.");
    return 0;
  }

  const { createTaskStatusLookup, extractTrackingTaskRefs, computeStaleness } = await import(
    "@minsky/domain/memory"
  );
  const { memoriesTable } = await import("@minsky/domain/storage/schemas/memory-embeddings");

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rows = (await (db as any).select().from(memoriesTable)) as Record<string, unknown>[];

  const lookup = createTaskStatusLookup(db as never);

  // One union'd lookup for the whole corpus, exactly as the service does per page.
  const perRecord = rows.map((row) => ({
    row,
    extracted: extractTrackingTaskRefs({
      content: String(row["content"] ?? ""),
      description: String(row["description"] ?? ""),
      associations: (row["associations"] as Record<string, string[]> | null) ?? null,
    }),
  }));

  const allRefs = [...new Set(perRecord.flatMap((p) => p.extracted.refs))];
  const statuses = allRefs.length > 0 ? await lookup(allRefs) : new Map<string, string>();

  const summary: Summary = {
    totalMemories: rows.length,
    withClause: 0,
    stale: 0,
    current: 0,
    unresolved: 0,
    fireRatePercent: 0,
    staleRecords: [],
    unresolvedRecords: [],
  };

  for (const { row, extracted } of perRecord) {
    const verdict = computeStaleness(extracted.refs, extracted.source, statuses);
    if (!verdict) continue;

    summary.withClause++;
    const shortId = row["shortId"] ? String(row["shortId"]) : undefined;
    const name = String(row["name"] ?? "(unnamed)");

    if (verdict.outcome === "stale") {
      summary.stale++;
      summary.staleRecords.push({
        shortId,
        name,
        completed: verdict.completedTasks.map((t) => `${t.taskId}=${t.status}`),
      });
    } else if (verdict.outcome === "unresolved") {
      summary.unresolved++;
      summary.unresolvedRecords.push({ shortId, name, refs: verdict.unresolvedTasks });
    } else {
      summary.current++;
    }
  }

  summary.fireRatePercent =
    rows.length === 0 ? 0 : Math.round((summary.stale / rows.length) * 10000) / 100;

  if (asJson) {
    console.log(JSON.stringify(summary, null, 2));
    return 0;
  }

  console.log("=== memory-staleness fire-rate measurement (mt#1709) ===");
  console.log(`Total memories scanned:        ${summary.totalMemories}`);
  console.log(`Declared a retirement clause:  ${summary.withClause}`);
  console.log(`  -> stale (annotation FIRES): ${summary.stale}`);
  console.log(`  -> current (silent):         ${summary.current}`);
  console.log(`  -> unresolved (silent):      ${summary.unresolved}`);
  console.log(`Fire rate over whole corpus:   ${summary.fireRatePercent}%`);

  if (verbose) {
    console.log("\n--- firing records ---");
    for (const r of summary.staleRecords) {
      console.log(`  ${r.shortId ?? "?"} ${r.name} :: ${r.completed.join(", ")}`);
    }
    console.log("\n--- unresolved records (silent, but not 'current') ---");
    for (const r of summary.unresolvedRecords) {
      console.log(`  ${r.shortId ?? "?"} ${r.name} :: ${r.refs.join(", ")}`);
    }
  }

  // The check this script exists to make: the annotation must stay quiet on the corpus.
  // A detector that fires on most results is noise regardless of per-case correctness.
  if (summary.fireRatePercent > 25) {
    console.error(
      `\nFAIL: fire rate ${summary.fireRatePercent}% exceeds the 25% ceiling — the pattern ` +
        `set is too loose to ship as an always-on annotation.`
    );
    return 1;
  }

  console.log("\nPASS: fire rate is within the ceiling.");
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error("FAIL:", err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
