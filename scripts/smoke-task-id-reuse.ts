#!/usr/bin/env bun
/**
 * Smoke test for the task-ID-reuse / orphaned-spec fix (mt#2205).
 *
 * Verifies the genuinely-live behavior that unit tests (with a fake DB) cannot:
 *   1. Migration 0043 applied — the `deleted_task_ids` tombstone table exists
 *      and is readable/writable.
 *   2. deleteTask hard-purges the dependent rows that lost their ON DELETE
 *      CASCADE FK in migration 0011 — `task_specs` AND `tasks_embeddings` rows
 *      for the deleted id are gone afterward.
 *   3. deleteTask records a tombstone row in `deleted_task_ids`.
 *
 * The monotonic-allocation logic itself (a freed id is never re-handed-out) is
 * covered by the pure-helper unit tests in minskyTaskBackend.test.ts — a live
 * end-to-end monotonicity check is intentionally NOT done here because its
 * correctness signal is a *permanent* tombstone write, which would pollute the
 * task-ID sequence of any shared database. This smoke uses a NON-NUMERIC
 * reserved id so its tombstone is inert (computeNextTaskId ignores non-mt#<n>
 * ids) and cleans up fully regardless.
 *
 * Required env vars:
 *   DATABASE_URL or MINSKY_POSTGRES_URL
 *
 * Exit codes:
 *   0 — all checks passed
 *   1 — one or more checks failed
 *   2 — skip (required env vars not set)
 */

import "reflect-metadata";
import { eq } from "drizzle-orm";

const dbUrl = process.env["DATABASE_URL"] || process.env["MINSKY_POSTGRES_URL"];

if (!dbUrl) {
  console.log("SKIP: DATABASE_URL or MINSKY_POSTGRES_URL not set.");
  process.exit(2);
}

const connectionString: string = dbUrl;

interface SmokeResult {
  check: string;
  passed: boolean;
  detail?: string;
}

const results: SmokeResult[] = [];

function pass(check: string, detail?: string): void {
  results.push({ check, passed: true, detail });
  console.log(`  PASS  ${check}${detail ? `: ${detail}` : ""}`);
}

function fail(check: string, detail: string): void {
  results.push({ check, passed: false, detail });
  console.error(`  FAIL  ${check}: ${detail}`);
}

function printSummary(): never {
  const passed = results.filter((r) => r.passed).length;
  const failed = results.filter((r) => !r.passed).length;
  console.log(`\nSummary: ${passed} pass, ${failed} fail`);
  if (failed > 0) {
    console.error("SMOKE FAIL");
    process.exit(1);
  }
  console.log("SMOKE PASS");
  process.exit(0);
}

console.log("smoke-task-id-reuse: starting");
console.log(`  Database: ${connectionString.replace(/:[^:@]+@/, ":<REDACTED>@")}`);
console.log("");

// Bootstrap persistence
const { PersistenceService } = await import("@minsky/domain/persistence/service");
const service = new PersistenceService();

try {
  await service.initialize({ backend: "postgres", postgres: { connectionString } });
} catch (err) {
  console.error(`FATAL: Cannot connect to database: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
}

const provider = service.getProvider();
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = (provider as any).db as any;

if (!db) {
  console.error("FATAL: No Drizzle db instance available.");
  process.exit(1);
}

const { tasksTable, taskSpecsTable, tasksEmbeddingsTable, deletedTaskIdsTable } = await import(
  "@minsky/domain/storage/schemas/task-embeddings"
);
const { createMinskyTaskBackend } = await import("@minsky/domain/tasks/minskyTaskBackend");

// Non-numeric reserved id — its tombstone is inert for the id allocator.
const testId = `mt#smoke-id-reuse-${Date.now()}`;
const backend = createMinskyTaskBackend({ db, workspacePath: "/tmp/smoke-id-reuse" } as never);

// ---------------------------------------------------------------------------
// Check 1: deleted_task_ids table exists (migration 0043 applied)
// ---------------------------------------------------------------------------
try {
  await db.select({ id: deletedTaskIdsTable.id }).from(deletedTaskIdsTable).limit(1);
  pass("deleted_task_ids table readable (migration 0043 applied)");
} catch (err) {
  fail("deleted_task_ids table readable", err instanceof Error ? err.message : String(err));
  printSummary();
}

try {
  // Seed: a task row, a spec row, and an embedding row for testId.
  await db
    .insert(tasksTable)
    .values({
      id: testId,
      sourceTaskId: testId.split("#")[1],
      backend: "minsky" as const,
      status: "TODO",
      title: "Smoke: id-reuse test task",
      tags: "[]",
      kind: "implementation",
      createdAt: new Date(),
      updatedAt: new Date(),
    })
    .onConflictDoNothing();

  await db
    .insert(taskSpecsTable)
    .values({
      taskId: testId,
      content: "smoke spec",
      version: 1,
      createdAt: new Date(),
      updatedAt: new Date(),
    })
    .onConflictDoNothing();

  await db
    .insert(tasksEmbeddingsTable)
    .values({
      id: testId,
      status: "TODO",
      backend: "minsky" as const,
      createdAt: new Date(),
      updatedAt: new Date(),
    })
    .onConflictDoNothing();

  // ---------------------------------------------------------------------------
  // Check 2: deleteTask returns true for an existing task
  // ---------------------------------------------------------------------------
  const deleted = await backend.deleteTask(testId);
  if (deleted) {
    pass("deleteTask returns true for an existing task");
  } else {
    fail("deleteTask returns true for an existing task", "got false");
  }

  // ---------------------------------------------------------------------------
  // Check 3: task_specs row is purged (orphan fix)
  // ---------------------------------------------------------------------------
  const specRows = await db
    .select()
    .from(taskSpecsTable)
    .where(eq(taskSpecsTable.taskId, testId))
    .limit(1);
  if (specRows.length === 0) {
    pass("task_specs row purged after delete");
  } else {
    fail("task_specs row purged after delete", `${specRows.length} row(s) remain`);
  }

  // ---------------------------------------------------------------------------
  // Check 4: tasks_embeddings row is purged (orphan fix)
  // ---------------------------------------------------------------------------
  const embRows = await db
    .select()
    .from(tasksEmbeddingsTable)
    .where(eq(tasksEmbeddingsTable.id, testId))
    .limit(1);
  if (embRows.length === 0) {
    pass("tasks_embeddings row purged after delete");
  } else {
    fail("tasks_embeddings row purged after delete", `${embRows.length} row(s) remain`);
  }

  // ---------------------------------------------------------------------------
  // Check 5: tombstone recorded in deleted_task_ids
  // ---------------------------------------------------------------------------
  const tombRows = await db
    .select()
    .from(deletedTaskIdsTable)
    .where(eq(deletedTaskIdsTable.id, testId))
    .limit(1);
  if (tombRows.length === 1) {
    pass("tombstone recorded in deleted_task_ids");
  } else {
    fail("tombstone recorded in deleted_task_ids", `expected 1 row, got ${tombRows.length}`);
  }
} catch (err) {
  fail("deleteTask purge + tombstone sequence", err instanceof Error ? err.message : String(err));
} finally {
  // Full cleanup — leave the database exactly as we found it (including the
  // tombstone, so no residue and no sequence impact even though the id is inert).
  try {
    await db.delete(deletedTaskIdsTable).where(eq(deletedTaskIdsTable.id, testId));
    await db.delete(taskSpecsTable).where(eq(taskSpecsTable.taskId, testId));
    await db.delete(tasksEmbeddingsTable).where(eq(tasksEmbeddingsTable.id, testId));
    await db.delete(tasksTable).where(eq(tasksTable.id, testId));
  } catch {
    // Non-fatal cleanup failure
  }
}

printSummary();
