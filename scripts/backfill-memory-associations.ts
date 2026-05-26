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
 *   - "see mt#XXXX" / "See mt#XXXX" in cross-references → { relatedTask: ["mt#XXXX"] }
 *   - General "mt#XXXX" references → { relatedTask: ["mt#XXXX"] }
 *
 * Idempotent: uses merge semantics (existing associations preserved).
 *
 * @see docs/architecture/adr-012-memory-entity-associations.md
 * @see mt#2071
 */

import type { MemoryServiceSurface, MemoryServiceDb } from "@minsky/domain/memory/memory-service";

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
    const extracted = extractAssociations(mem.content, mem.tags);
    const existing = mem.associations ?? {};

    const merged = mergeAssociations(existing, extracted);
    const changed = JSON.stringify(merged) !== JSON.stringify(existing);

    const bodyRefCount = countTaskRefs(mem.content);
    totalBodyRefs += bodyRefCount;

    const extractedTaskIds = new Set([
      ...(extracted.tracksTask ?? []),
      ...(extracted.relatedTask ?? []),
    ]);
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
  console.log(`\nUnique task IDs referenced in body text: ${totalBodyRefs}`);
  console.log(`Unique task IDs captured as associations: ${capturedRefs}`);
  const coverage = totalBodyRefs > 0 ? ((capturedRefs / totalBodyRefs) * 100).toFixed(1) : "N/A";
  console.log(`Coverage (unique IDs captured / unique IDs found): ${coverage}%`);
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

function extractAssociations(content: string, tags: string[]): Record<string, string[]> {
  const tracksTask = new Set<string>();
  const relatedTask = new Set<string>();

  const trackingPattern = /[Tt]racking\s+task:\s*mt#(\d+)/g;
  for (const match of content.matchAll(trackingPattern)) {
    tracksTask.add(`mt#${match[1]}`);
  }

  const budgetPattern = /Budget:.*?tracking\s+task:\s*mt#(\d+)/gi;
  for (const match of content.matchAll(budgetPattern)) {
    tracksTask.add(`mt#${match[1]}`);
  }

  const isBridge = tags.some(
    (t) => t === "bridge" || t.includes("bridge-memory") || t.includes("bridge_memory")
  );
  if (isBridge) {
    const taskRefPattern = /mt#(\d+)/g;
    for (const match of content.matchAll(taskRefPattern)) {
      tracksTask.add(`mt#${match[1]}`);
    }
  }

  const seePattern = /[Ss]ee\s+mt#(\d+)/g;
  for (const match of content.matchAll(seePattern)) {
    const taskId = `mt#${match[1]}`;
    if (!tracksTask.has(taskId)) {
      relatedTask.add(taskId);
    }
  }

  const generalPattern = /\bmt#(\d+)\b/g;
  for (const match of content.matchAll(generalPattern)) {
    const taskId = `mt#${match[1]}`;
    if (!tracksTask.has(taskId) && !relatedTask.has(taskId)) {
      relatedTask.add(taskId);
    }
  }

  const result: Record<string, string[]> = {};
  if (tracksTask.size > 0) result.tracksTask = [...tracksTask].sort();
  if (relatedTask.size > 0) result.relatedTask = [...relatedTask].sort();
  return result;
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
