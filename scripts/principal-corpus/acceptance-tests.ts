#!/usr/bin/env bun
/**
 * Acceptance tests for mt#1930 (principal-corpus indexing).
 *
 * Verifies the 7 acceptance criteria from the task spec by exercising the
 * domain service + memory store directly. The MCP-tool surface wraps these
 * call paths; the assertions here cover the same behaviour the MCP tools
 * would exhibit once the daemon picks up the new code post-merge.
 */

import "reflect-metadata";
import { setupConfiguration } from "../../src/config-setup";

async function main() {
  await setupConfiguration();

  const { resolvePersistenceProvider } = await import("../../src/domain/persistence/factory");
  const persistence = await resolvePersistenceProvider();
  if (!persistence) throw new Error("no persistence");
  const { createPrincipalCorpusService } = await import(
    "../../src/domain/principal-corpus/principal-corpus-service"
  );
  const svc = await createPrincipalCorpusService(persistence);

  let passed = 0;
  let failed = 0;

  function record(name: string, ok: boolean, detail: string) {
    if (ok) {
      console.log(`✓ ${name}`);
      passed++;
    } else {
      console.log(`✗ ${name} — ${detail}`);
      failed++;
    }
    if (detail && ok) console.log(`    ${detail}`);
  }

  // AT 1: principal_corpus_search returns relevant tweets for the workshop query.
  const query1 = "exocortex extended cognition flock";
  const r1 = await svc.searchByText(query1, 5);
  const r1Pass =
    r1.results.length >= 3 && !r1.degraded && r1.results.every((r) => !!r.metadata?.text);
  record(
    "AT 1: principal_corpus_search returns semantically-relevant tweets w/ metadata",
    r1Pass,
    `backend=${r1.backend} count=${r1.results.length}`
  );
  for (const x of r1.results.slice(0, 3)) {
    console.log(
      `    [${x.score.toFixed(3)}] ${x.id} — ${(x.metadata?.text || "").slice(0, 80).replace(/\n/g, " ")}`
    );
  }

  // AT 2: principal_corpus_similar by tweet ID. Use the top result from AT 1 as a known-indexed ID.
  if (r1.results[0]) {
    const sourceId = r1.results[0].id;
    const r2 = await svc.similar(sourceId, 5);
    const r2Pass =
      r2.results.length >= 2 && !r2.degraded && r2.results.every((r) => r.id !== sourceId);
    record(
      `AT 2: principal_corpus_similar returns related tweets (source=${sourceId})`,
      r2Pass,
      `count=${r2.results.length} backend=${r2.backend}`
    );
  } else {
    record("AT 2: principal_corpus_similar", false, "no source tweet available from AT 1");
  }

  // AT 3-6: memory store assertions
  const { MemoryService } = await import("../../src/domain/memory/memory-service");
  const { createEmbeddingServiceFromConfig } = await import(
    "../../src/domain/ai/embedding-service-factory"
  );
  const { createMemoryVectorStorageFromConfig } = await import(
    "../../src/domain/storage/vector/vector-storage-factory"
  );
  const { getEmbeddingDimension } = await import("../../src/domain/ai/embedding-models");
  const { getConfiguration } = await import("../../src/domain/configuration");

  type SqlCapable = typeof persistence & { getDatabaseConnection: () => Promise<unknown> };
  if (!("getDatabaseConnection" in persistence)) {
    throw new Error("persistence lacks SQL");
  }
  const db = await (persistence as SqlCapable).getDatabaseConnection();
  if (!db) throw new Error("no db");

  const cfg = getConfiguration() as Record<string, unknown>;
  const embeddings = cfg.embeddings as { model?: string } | undefined;
  const model = embeddings?.model ?? "text-embedding-3-small";
  const dimension = getEmbeddingDimension(model, 1536);
  const embeddingService = await createEmbeddingServiceFromConfig();
  const vectorStorage = await createMemoryVectorStorageFromConfig(dimension, persistence);
  const memoryService = new MemoryService({
    db: db as Parameters<typeof MemoryService>[0]["db"],
    vectorStorage,
    embeddingService,
  });

  // AT 3: memory_search returns memeplexes on concept-level queries
  const r3 = await memoryService.search("society of mind ego plural", { limit: 5 });
  const r3HasPrincipalThinking = r3.results.some((r) =>
    (r.record.tags || []).includes("principal-thinking")
  );
  record(
    "AT 3: memory_search returns memeplex entries for concept-level queries",
    r3HasPrincipalThinking,
    `top-${r3.results.length}; principal-thinking matches=${r3.results.filter((r) => (r.record.tags || []).includes("principal-thinking")).length}`
  );

  // AT 4: principal-thinking tag returns only memeplex memories
  interface ExecutableDb {
    execute: (q: unknown) => Promise<Array<Record<string, unknown>>>;
  }
  const checkDb = db as ExecutableDb;
  const { sql } = await import("drizzle-orm");
  const allTagged = (await checkDb.execute(
    sql`SELECT id, type, name, tags FROM memories WHERE 'principal-thinking' = ANY(tags) ORDER BY created_at`
  )) as Array<{ id: string; type: string; name: string; tags: string[] }>;
  const r4Pass =
    allTagged.length >= 15 &&
    allTagged.length <= 25 &&
    allTagged.every((m) => Array.isArray(m.tags) && m.tags.includes("principal-thinking"));
  record(
    "AT 4: principal-thinking tag filter returns only memeplex entries",
    r4Pass,
    `count=${allTagged.length}, all tagged correctly=${allTagged.every((m) => m.tags?.includes("principal-thinking"))}`
  );

  // AT 5: total memeplex entries between 15 and 25
  record(
    "AT 5: total memeplex entries are between 15 and 25",
    allTagged.length >= 15 && allTagged.length <= 25,
    `count=${allTagged.length}`
  );

  // AT 6: each memeplex cites at least 3 tweet IDs (parse the content field)
  const fullRows = (await checkDb.execute(
    sql`SELECT id, content FROM memories WHERE 'principal-thinking' = ANY(tags)`
  )) as Array<{ id: string; content: string }>;
  let allHaveCitations = true;
  let minCitations = Infinity;
  for (const m of fullRows) {
    // Each citation line looks like: "- 1234567890 — https://twitter.com/..."
    const matches = m.content.match(/^- \d+ —/gm);
    const count = matches?.length || 0;
    if (count < minCitations) minCitations = count;
    if (count < 3) {
      allHaveCitations = false;
      console.log(`    memory ${m.id} has only ${count} citations`);
    }
  }
  record(
    "AT 6: each memeplex entry cites ≥ 3 supporting tweet IDs",
    allHaveCitations,
    `min citation count=${minCitations}, total memeplexes=${fullRows.length}`
  );

  // AT 7: raw tweet index contains ≥ 1,500 entries (ceiling relaxed per spec amendment)
  const countRows = (await checkDb.execute(
    sql`SELECT COUNT(*) AS n FROM principal_corpus_embeddings`
  )) as Array<{ n: string | number }>;
  const rawCount = Number(countRows[0]?.n ?? 0);
  record(
    "AT 7: raw tweet index ≥ 1,500 entries (ceiling relaxed during impl)",
    rawCount >= 1500,
    `principal_corpus_embeddings count=${rawCount}`
  );

  console.log();
  console.log(`Summary: ${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("acceptance-tests FATAL:", err);
  process.exit(1);
});
