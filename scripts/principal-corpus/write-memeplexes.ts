#!/usr/bin/env bun
/**
 * Write the synthesized memeplex entries from tmp/principal-corpus-memeplexes.json
 * into the product memory store via the MemoryService domain API (same path
 * mcp__minsky__memory_create uses). Each entry becomes one memory with:
 *
 *   - type: "feedback" (closest existing type for synthesized observations)
 *   - tags: ["principal-thinking", "principal-corpus", `theme:<theme>`]
 *   - content: the memeplex proposition + "Citations:" footer with tweet URLs
 *
 * Idempotent at the tag level — if memories with tag `principal-thinking`
 * already exist, the script reports them and exits unless `--force` is set.
 */

import "reflect-metadata";
import { readFileSync, existsSync } from "fs";
import { setupConfiguration } from "../../src/config-setup";
import type { MemeplexEntry } from "../../src/domain/principal-corpus/memeplex-synthesizer";

const MEMEPLEX_IN = "tmp/principal-corpus-memeplexes.json";

async function main() {
  const args = new Set(process.argv.slice(2));
  const force = args.has("--force");
  await setupConfiguration();

  if (!existsSync(MEMEPLEX_IN)) {
    throw new Error(`Memeplex JSON not found at ${MEMEPLEX_IN} — run synthesis first`);
  }

  const memeplexes = JSON.parse(
    String(readFileSync(MEMEPLEX_IN, { encoding: "utf8" }))
  ) as MemeplexEntry[];
  console.log(`[memwrite] loaded ${memeplexes.length} memeplexes from ${MEMEPLEX_IN}`);

  // Look up principal-corpus screen name from env to build citation URLs.
  const screenName = process.env.PRINCIPAL_CORPUS_SCREEN_NAME ?? "";
  if (!screenName) {
    console.error(
      "[memwrite] PRINCIPAL_CORPUS_SCREEN_NAME env var required for building citation URLs"
    );
    process.exit(2);
  }

  const { resolvePersistenceProvider } = await import("../../src/domain/persistence/factory");
  const persistence = await resolvePersistenceProvider();
  if (!persistence) {
    throw new Error("Could not resolve persistence provider — check config and DB availability");
  }
  type SqlCapable = typeof persistence & {
    getDatabaseConnection: () => Promise<unknown>;
  };
  const isSqlCapable = (p: typeof persistence): p is SqlCapable =>
    p.capabilities.sql === true &&
    "getDatabaseConnection" in p &&
    typeof (p as { getDatabaseConnection?: unknown }).getDatabaseConnection === "function";
  if (!isSqlCapable(persistence)) {
    throw new Error("Persistence provider lacks SQL capability");
  }
  const db = await persistence.getDatabaseConnection();
  if (!db) {
    throw new Error("Could not obtain DB connection from persistence provider");
  }

  const { MemoryService } = await import("../../src/domain/memory/memory-service");
  const { createEmbeddingServiceFromConfig } = await import(
    "../../src/domain/ai/embedding-service-factory"
  );
  const { createMemoryVectorStorageFromConfig } = await import(
    "../../src/domain/storage/vector/vector-storage-factory"
  );
  const { getEmbeddingDimension } = await import("../../src/domain/ai/embedding-models");
  const { getConfiguration } = await import("../../src/domain/configuration");

  const cfg = getConfiguration();
  const cfgRecord = cfg as Record<string, unknown>;
  const embeddingsCfg = cfgRecord.embeddings as { model?: string } | undefined;
  const model = embeddingsCfg?.model ?? "text-embedding-3-small";
  const dimension = getEmbeddingDimension(model, 1536);
  const embeddingService = await createEmbeddingServiceFromConfig();
  const vectorStorage = await createMemoryVectorStorageFromConfig(dimension, persistence);

  const memoryService = new MemoryService({
    db: db as Parameters<typeof MemoryService>[0]["db"],
    vectorStorage,
    embeddingService,
  });

  if (!force) {
    // Duplicate-check via direct SQL — MemoryListFilter doesn't support tag
    // filtering. We query the memories table for rows tagged "principal-thinking".
    interface ExecutableDb {
      execute?: (q: unknown) => Promise<Array<{ n: string | number }>>;
    }
    const checkDb = db as ExecutableDb;
    const { sql } = await import("drizzle-orm");
    try {
      const rows = await checkDb.execute?.(
        sql`SELECT COUNT(*) AS n FROM memories WHERE tags ? 'principal-thinking'`
      );
      const n = rows && rows[0] ? Number(rows[0].n) : 0;
      if (n > 0) {
        console.error(
          `[memwrite] ${n} memories already exist with tag 'principal-thinking'. Pass --force to write anyway (creates duplicates).`
        );
        process.exit(3);
      }
    } catch (err) {
      console.warn(
        `[memwrite] could not check for existing principal-thinking memories: ${err instanceof Error ? err.message : String(err)}; proceeding.`
      );
    }
  }

  let written = 0;
  for (const m of memeplexes) {
    const citationLines = m.citations.map(
      (id) => `- ${id} — https://twitter.com/${screenName}/status/${id}`
    );
    const fullContent = `${m.content}\n\n**Citations** (${m.citations.length} tweet${m.citations.length === 1 ? "" : "s"}):\n${citationLines.join("\n")}`;
    try {
      const record = await memoryService.create({
        type: "feedback",
        name: m.name,
        description: m.description,
        content: fullContent,
        tags: ["principal-thinking", "principal-corpus", `theme:${m.theme}`],
      });
      written++;
      console.log(`[memwrite] wrote ${record.id} (${m.theme}): ${m.name}`);
    } catch (err) {
      console.error(
        `[memwrite] FAILED to write "${m.name}": ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }
  console.log(`[memwrite] done. ${written}/${memeplexes.length} memeplex memories written.`);
}

main().catch((err) => {
  console.error("[memwrite] FATAL:", err);
  process.exit(1);
});
