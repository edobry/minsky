#!/usr/bin/env bun
/**
 * Normalize `memories.associations` onto the ADR-012 vocabulary (mt#4448).
 *
 * Usage:
 *   bun scripts/normalize-memory-associations.ts              # dry-run (default)
 *   bun scripts/normalize-memory-associations.ts --execute    # apply changes
 *
 * ## What this does, and the one thing it must not do
 *
 * The 2026-08-24 census found 28 of 1226 memories carrying a non-empty `associations` map, of
 * which 26 used keys no ADR defines (`tasks`, `memories`, `prs`, `changesets`, `docs`, `task`).
 * Those keys record WHAT is linked and never WHY, so they cannot be mechanically upgraded into
 * ADR-012's relationship-keyed vocabulary without asserting a relationship nobody declared.
 *
 * So the rule is: **strip the divergent keys, but never let a value disappear that exists
 * nowhere else in the record.** Measured over the live corpus, 138 of 149 divergent values are
 * already recoverable from the record's own body/name/description/tags; 11 are not. Deleting
 * blind would have destroyed those 11 — the defect caught only because the principal asked how
 * "nothing is lost" was known.
 *
 * Per value the script decides:
 *
 *   - **recoverable** (its id appears elsewhere in the record) -> drop with the key.
 *   - **unique + task-shaped** -> preserve as `relatedTask`, ADR-012's "related to (but not
 *     bridged on)". Deliberately NOT `tracksTask`: the entity-keyed form never said this memory
 *     retires when that task ships, and inventing that claim is the launder this task prevents.
 *   - **unique + not task-shaped** (a memory uuid, a PR number, a doc path) -> preserve as a
 *     plain cross-reference appended to the body, because ADR-012 has no key for those
 *     relationships and the nearest ones would misstate them.
 *
 * Recoverability is RE-DERIVED at run time, never hard-coded, so a corpus that has moved since
 * the census still gets the right answer.
 *
 * @see docs/architecture/adr-012-memory-entity-associations.md
 * @see mt#4448
 */

// tsyringe reflect polyfill. MUST be static and first: every domain import below is dynamic,
// and a type-only import is erased at runtime, so nothing else in this file loads the
// polyfill. Without it the first tsyringe decorator throws and the script dies before its
// first query (mt#3178 — the exact failure that left the mt#2071 backfill unrun for months).
import "reflect-metadata";

import { writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";

import type { MemoryServiceSurface, MemoryServiceDb } from "@minsky/domain/memory/memory-service";
import { isKnownAssociationType } from "@minsky/domain/memory/associations";

const TASK_ID_RE = /^(?:mt|md|gh)#\d+$/;

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

  await initializeConfiguration(new CustomConfigFactory(), { workingDirectory: process.cwd() });

  const container = await createCliContainer();
  await container.initialize();

  const persistence = container.has("persistence") ? container.get("persistence") : undefined;
  if (!persistence || !(persistence instanceof PersistenceProvider)) {
    throw new Error("Normalization requires a SQL-capable persistence provider (Postgres).");
  }
  if (!persistence.capabilities.sql || typeof persistence.getDatabaseConnection !== "function") {
    throw new Error("Normalization requires a SQL-capable persistence provider (Postgres).");
  }

  const connection = await persistence.getDatabaseConnection();
  if (!connection) {
    throw new Error("Normalization requires an initialized Postgres database connection.");
  }

  return new MemoryService({
    db: connection as MemoryServiceDb,
    vectorStorage: await createVectorStorageForDomain("memory", 1536, persistence),
    embeddingService: await createEmbeddingServiceFromConfig(),
  });
}

/**
 * Strip an id down to the token that would actually appear in prose.
 *
 * A full uuid is routinely cited by its 8-char prefix, so comparing the whole uuid against the
 * body would report a link as unique when the body cites it perfectly well. Getting this
 * backwards inflates the PRESERVE set rather than the delete set — the safe direction, but it
 * also writes cross-references nobody needed, so it is worth being right.
 */
function comparisonToken(value: string): string {
  const bare = value.replace(/^(?:mt#|md#|gh#|PR#|mem#|ask#|ws#)/i, "").toLowerCase();
  return /^[0-9a-f]{8}-[0-9a-f]{4}-/.test(bare) ? bare.slice(0, 8) : bare;
}

interface ValuePlan {
  key: string;
  value: string;
  disposition: "drop-recoverable" | "preserve-relatedTask" | "preserve-body-text";
}

interface RecordPlan {
  id: string;
  name: string;
  divergentKeys: string[];
  values: ValuePlan[];
  relatedTaskAdditions: string[];
  bodyAdditions: string[];
}

interface ScannedRecord {
  id: string;
  name: string;
  content: string;
  description: string | null;
  tags: string[];
  associations: Record<string, string[]> | null;
}

export function planRecord(record: ScannedRecord): RecordPlan | null {
  const associations = record.associations ?? {};
  const divergentKeys = Object.keys(associations).filter((k) => !isKnownAssociationType(k));
  if (divergentKeys.length === 0) return null;

  const haystack = [
    record.content,
    record.name,
    record.description ?? "",
    (record.tags ?? []).join(" "),
  ]
    .join("\n")
    .toLowerCase();

  const values: ValuePlan[] = [];
  const relatedTaskAdditions: string[] = [];
  const bodyAdditions: string[] = [];

  for (const key of divergentKeys) {
    for (const value of associations[key] ?? []) {
      if (haystack.includes(comparisonToken(value))) {
        values.push({ key, value, disposition: "drop-recoverable" });
      } else if (TASK_ID_RE.test(value)) {
        values.push({ key, value, disposition: "preserve-relatedTask" });
        relatedTaskAdditions.push(value);
      } else {
        values.push({ key, value, disposition: "preserve-body-text" });
        bodyAdditions.push(`${key}: ${value}`);
      }
    }
  }

  return {
    id: record.id,
    name: record.name,
    divergentKeys,
    values,
    relatedTaskAdditions,
    bodyAdditions,
  };
}

/** The body block appended for values with no ADR-012 home. Idempotent by marker. */
export const CROSSREF_MARKER = "<!-- mt#4448: preserved from a non-vocabulary association key -->";

export function buildBodyAddition(additions: string[]): string {
  const lines = additions.map((a) => `- ${a}`).join("\n");
  return `\n\n${CROSSREF_MARKER}\n**Cross-references** (preserved from a non-ADR-012 association key):\n\n${lines}\n`;
}

/**
 * A snapshot path that cannot collide: timestamp + pid + random suffix.
 *
 * A timestamp alone is not enough — two operators, or one retry, inside the same second
 * produce the same name. Paired with the exclusive write below.
 */
export function buildSnapshotPath(): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return `associations-pre-normalize-${stamp}-pid${process.pid}-${randomUUID().slice(0, 8)}.json`;
}

/**
 * Write the pre-state snapshot, REFUSING to overwrite an existing file.
 *
 * `Bun.write` (and a default `writeFileSync`) truncate silently, so a colliding run would
 * destroy the previous run's snapshot with no error. Since the snapshot is the only thing
 * that makes key removal reversible, losing it silently is the worst available failure —
 * hence `wx`, which throws EEXIST. Caught in PR #3295 review.
 */
export function writeSnapshotExclusive(path: string, snapshot: unknown): string {
  try {
    writeFileSync(path, JSON.stringify(snapshot, null, 2), { flag: "wx" });
  } catch (err) {
    throw new Error(
      `Refusing to proceed: could not exclusively create the pre-state snapshot at ${path} (${err}). ` +
        "The snapshot is the only thing that makes key removal reversible, so the run stops rather than mutating without one."
    );
  }
  return path;
}

async function main() {
  const execute = process.argv.includes("--execute");

  const memoryService = await buildMemoryService();
  const all = await memoryService.list({});
  console.log(`Scanned ${all.length} memories.\n`);

  const plans: RecordPlan[] = [];
  for (const mem of all) {
    // No cast: `MemoryRecord` is structurally a `ScannedRecord` plus extra fields, so it is
    // directly assignable. The original `as unknown as` double cast was hiding that fact —
    // and would have hidden a genuine shape drift too.
    const plan = planRecord(mem);
    if (plan) plans.push(plan);
  }

  const totalValues = plans.reduce((n, p) => n + p.values.length, 0);
  const dropped = plans.reduce(
    (n, p) => n + p.values.filter((v) => v.disposition === "drop-recoverable").length,
    0
  );
  const toRelated = plans.reduce((n, p) => n + p.relatedTaskAdditions.length, 0);
  const toBody = plans.reduce((n, p) => n + p.bodyAdditions.length, 0);

  console.log("=== Normalization plan ===");
  console.log(`Records with divergent keys:      ${plans.length}`);
  console.log(`Divergent values total:           ${totalValues}`);
  console.log(`  drop (recoverable elsewhere):   ${dropped}`);
  console.log(`  preserve as relatedTask:        ${toRelated}`);
  console.log(`  preserve as body cross-ref:     ${toBody}`);
  console.log(`Preserved total:                  ${toRelated + toBody}\n`);

  for (const p of plans) {
    const preserved = p.values.filter((v) => v.disposition !== "drop-recoverable");
    if (preserved.length === 0) continue;
    console.log(`${p.id.slice(0, 8)} ${p.name.slice(0, 62)}`);
    for (const v of preserved) {
      console.log(`  PRESERVE [${v.key}] ${v.value} -> ${v.disposition}`);
    }
  }
  console.log();

  if (!execute) {
    console.log("DRY RUN — no changes written. Pass --execute to apply.");
    process.exit(0);
  }

  // Snapshot the pre-state BEFORE any write. Stripping a divergent key is not reversible
  // from the post-state -- the key and its values are simply gone -- so the only thing that
  // makes this operation undoable is a record of what was there. Written before the first
  // mutation, not alongside it, so a crash mid-run still leaves a complete snapshot.
  //
  // The filename carries pid + a random suffix, and the write is EXCLUSIVE (`wx`), so a
  // collision throws EEXIST instead of silently replacing an existing snapshot. A
  // timestamp alone is not enough: two operators — or one retry — inside the same second
  // would collide, and `Bun.write` truncates without complaint, so the failure mode was
  // losing the previous run's only record of the pre-state. Caught in PR #3295 review.
  const snapshot = plans.map((p) => ({
    id: p.id,
    name: p.name,
    associations: all.find((m) => m.id === p.id)?.associations ?? null,
  }));
  const snapshotPath = writeSnapshotExclusive(buildSnapshotPath(), snapshot);
  console.log(`Pre-state snapshot written: ${snapshotPath} (${snapshot.length} records)\n`);

  console.log("Applying...");
  let updated = 0;
  let errors = 0;

  for (const p of plans) {
    try {
      // Step 1: PRESERVE first. If this throws we have not yet removed anything, so a
      // partial run leaves the record intact rather than stripped-and-unpreserved.
      if (p.relatedTaskAdditions.length > 0 || p.bodyAdditions.length > 0) {
        // getWithoutAccessTracking, not get: this is a read-in-order-to-write (mt#3602), and
        // `get` bumps access_count — a migration must not look like 7 memories being read.
        const record = await memoryService.getWithoutAccessTracking(p.id);
        if (!record) throw new Error(`record vanished mid-run: ${p.id}`);

        const existingRelated = record.associations?.relatedTask ?? [];
        const mergedRelated = [...new Set([...existingRelated, ...p.relatedTaskAdditions])].sort();

        await memoryService.update(p.id, {
          ...(p.relatedTaskAdditions.length > 0
            ? { associations: { relatedTask: mergedRelated } }
            : {}),
          ...(p.bodyAdditions.length > 0 && !record.content.includes(CROSSREF_MARKER)
            ? { content: record.content + buildBodyAddition(p.bodyAdditions) }
            : {}),
        });
      }

      // Step 2: only now remove the divergent keys. An empty array is the documented removal
      // form; `validateAssociations(..., "update")` exempts it for exactly this.
      const removal = Object.fromEntries(p.divergentKeys.map((k) => [k, [] as string[]]));
      await memoryService.update(p.id, { associations: removal });

      updated++;
    } catch (err) {
      console.error(`  ERROR on ${p.id}: ${err}`);
      errors++;
    }
  }

  console.log(`\nDone. Records updated: ${updated}, errors: ${errors}`);
  process.exit(errors > 0 ? 1 : 0);
}

if (import.meta.main) {
  main().catch((err) => {
    console.error("Fatal error:", err);
    process.exit(1);
  });
}
