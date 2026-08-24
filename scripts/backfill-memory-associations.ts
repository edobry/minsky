#!/usr/bin/env bun
/**
 * Backfill memory associations from body-text cross-references.
 *
 * Scans all memories for known patterns in their `content` field and
 * populates the `associations` JSONB field (ADR-012 / mt#2070).
 *
 * Usage:
 *   bun scripts/backfill-memory-associations.ts              # dry-run (default)
 *   bun scripts/backfill-memory-associations.ts --execute     # apply changes
 *
 * Patterns extracted:
 *   - "Tracking task: mt#XXXX"  → { tracksTask: ["mt#XXXX"] }
 *   - "tracking task: mt#XXXX"  → { tracksTask: ["mt#XXXX"] }
 *   - "Budget: ... tracking task: mt#XXXX" → { tracksTask: ["mt#XXXX"] }
 *   - Bridge tag + "mt#XXXX" in content → { tracksTask: ["mt#XXXX"] }
 *
 * NOT extracted (removed mt#4448): "see mt#XXXX" and bare "mt#XXXX" mentions. They minted
 * `relatedTask` for every incidental reference -- 9438 ids across 1146 records on the live
 * corpus -- which is out of scope and duplicates the body text. See extractAssociations().
 *
 * Idempotent: uses merge semantics (existing associations preserved).
 *
 * @see docs/architecture/adr-012-memory-entity-associations.md
 * @see mt#2071
 */

// tsyringe reflect polyfill. MUST be static and first: every domain import
// below is dynamic, and a type-only import is erased at runtime, so nothing
// else in this file loads the polyfill. Without it the first tsyringe
// decorator throws "tsyringe requires a reflect polyfill" and the script dies
// before its first query (mt#3178; same class as mt#3019 / mt#3176).
import "reflect-metadata";

import type { MemoryServiceSurface, MemoryServiceDb } from "@minsky/domain/memory/memory-service";
import { extractTrackingTaskRefs } from "@minsky/domain/memory/staleness";

async function buildMemoryService(): Promise<MemoryServiceSurface> {
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

  await initializeConfiguration(new CustomConfigFactory(), {
    workingDirectory: process.cwd(),
  });

  const container = await createCliContainer();
  await container.initialize();

  const persistence = container.has("persistence") ? container.get("persistence") : undefined;
  if (!persistence || !(persistence instanceof PersistenceProvider)) {
    throw new Error("Backfill requires a SQL-capable persistence provider (Postgres).");
  }
  if (!persistence.capabilities.sql || typeof persistence.getDatabaseConnection !== "function") {
    throw new Error("Backfill requires a SQL-capable persistence provider (Postgres).");
  }

  const connection = await persistence.getDatabaseConnection();
  if (!connection) {
    throw new Error("Backfill requires an initialized Postgres database connection.");
  }

  const db = connection as MemoryServiceDb;
  const embeddingService = await createEmbeddingServiceFromConfig();
  const vectorStorage = await createVectorStorageForDomain("memory", 1536, persistence);

  return new MemoryService({ db, vectorStorage, embeddingService });
}

async function main() {
  const execute = process.argv.includes("--execute");

  const memoryService = await buildMemoryService();
  const allMemories = await memoryService.list({});

  console.log(`Found ${allMemories.length} memories to scan.\n`);

  type Extraction = {
    id: string;
    name: string;
    extracted: Record<string, string[]>;
    existing: Record<string, string[]>;
    merged: Record<string, string[]>;
    changed: boolean;
  };

  const extractions: Extraction[] = [];
  let totalBodyRefs = 0;
  let capturedRefs = 0;

  for (const mem of allMemories) {
    const extracted = extractAssociations(mem.content, mem.description, mem.tags);
    const existing = mem.associations ?? {};

    const merged = mergeAssociations(existing, extracted);
    const changed = JSON.stringify(merged) !== JSON.stringify(existing);

    const bodyRefCount = countTaskRefs(mem.content);
    totalBodyRefs += bodyRefCount;

    const extractedTaskIds = new Set(extracted.tracksTask ?? []);
    capturedRefs += extractedTaskIds.size;

    extractions.push({
      id: mem.id,
      name: mem.name,
      extracted,
      existing,
      merged,
      changed,
    });
  }

  const toUpdate = extractions.filter((e) => e.changed);

  console.log("=== Backfill Summary ===");
  console.log(`Total memories scanned: ${allMemories.length}`);
  console.log(
    `Memories with extracted associations: ${extractions.filter((e) => Object.keys(e.extracted).length > 0).length}`
  );
  console.log(`Memories needing update: ${toUpdate.length}`);
  console.log(`Already up-to-date: ${allMemories.length - toUpdate.length}`);
  // mt#2071's "coverage" metric is NOT reported here, and the omission is deliberate.
  // It divided the ids the extractor captured by the ids a `\bmt#(\d+)\b` scan found -- but
  // the extractor's own catch-all used that identical regex over that identical text, so the
  // two sets were equal BY CONSTRUCTION and the figure was 100.0% on every possible input.
  // Measured 2026-08-24: 9438 / 9438. A number that cannot fall is not evidence, and mt#2071's
  // ">=80% coverage" acceptance bar was satisfied by arithmetic rather than by extraction.
  //
  // The meaningful measure is tracksTask RECALL against hand-audited retirement clauses, which
  // needs a labelled sample this script does not have. Reporting the raw counts instead.
  console.log(`\nUnique task IDs referenced anywhere in body text: ${totalBodyRefs}`);
  console.log(`Task IDs captured as tracksTask associations:      ${capturedRefs}`);
  console.log("(No coverage ratio: see the comment above -- the mt#2071 ratio was vacuous.)");
  console.log();

  if (toUpdate.length > 0) {
    console.log("=== Changes ===");
    for (const e of toUpdate) {
      console.log(`\n${e.name} (${e.id.slice(0, 8)}...)`);
      console.log(`  Existing: ${JSON.stringify(e.existing)}`);
      console.log(`  Extracted: ${JSON.stringify(e.extracted)}`);
      console.log(`  Merged: ${JSON.stringify(e.merged)}`);
    }
    console.log();
  }

  if (!execute) {
    console.log("DRY RUN — no changes written. Pass --execute to apply.");
    process.exit(0);
  }

  console.log("Applying changes...");
  let applied = 0;
  let errors = 0;

  for (const e of toUpdate) {
    try {
      await memoryService.update(e.id, { associations: e.merged });
      applied++;
    } catch (err) {
      console.error(`  ERROR updating ${e.id}: ${err}`);
      errors++;
    }
  }

  console.log(`\nDone. Applied: ${applied}, Errors: ${errors}`);

  if (errors > 0) {
    process.exit(1);
  }
}

function extractAssociations(
  content: string,
  description: string | null,
  _tags: string[]
): Record<string, string[]> {
  // Delegates to `extractTrackingTaskRefs` — the SAME extractor the read path uses
  // (`packages/domain/src/memory/staleness.ts`, mt#1709). One extractor, so what this script
  // WRITES and what the detector READS agree by construction.
  //
  // Three patterns were removed here (mt#4448):
  //   - a catch-all `\bmt#(\d+)\b` and a `see mt#X`, which minted `relatedTask` for every
  //     incidental mention — 9438 ids across 1146 records.
  //   - a BRIDGE-TAG catch-all: for any memory tagged `bridge`, it swept every `mt#(\d+)` in
  //     the body into `tracksTask`. That was the same defect at smaller scale, and worse in
  //     effect: `computeStaleness` marks a memory stale when ANY ref is complete, and
  //     `extractTrackingTaskRefs` PREFERS the stored association over the text scan. So a
  //     bridge memory citing 14 tasks would have had a 14-way association written over a
  //     precise clause scan, and flagged POSSIBLY OBSOLETE the moment any one of the 14
  //     landed. Measured pre-fix: 43 of 66 records would have received >3 ids.
  //
  // `_tags` is retained in the signature for call-site compatibility and is deliberately
  // unused: a tag is not a retirement clause.
  // BOTH content and description, because the READ path does (`extractTrackingTaskRefs`
  // scans `${description}\n${content}`). Passing only `content` here was a real divergence:
  // mem#1205 carries "Tracking: mt#1709" in its DESCRIPTION and nothing matching in its body,
  // so it was skipped entirely — the record AT2 names by id. Delegating to the shared
  // extractor is only half the fix; it has to be fed the same fields too.
  const { refs } = extractTrackingTaskRefs({
    content,
    ...(description === null ? {} : { description }),
  });
  return refs.length > 0 ? { tracksTask: [...refs].sort() } : {};
}

function mergeAssociations(
  existing: Record<string, string[]>,
  extracted: Record<string, string[]>
): Record<string, string[]> {
  const merged = { ...existing };
  for (const [key, values] of Object.entries(extracted)) {
    const current = new Set(merged[key] ?? []);
    for (const v of values) current.add(v);
    merged[key] = [...current].sort();
  }
  return merged;
}

function countTaskRefs(content: string): number {
  const refs = new Set<string>();
  const pattern = /\bmt#(\d+)\b/g;
  for (const match of content.matchAll(pattern)) {
    if (match[1]) refs.add(match[1]);
  }
  return refs.size;
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
