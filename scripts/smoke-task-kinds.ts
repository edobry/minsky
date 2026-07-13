#!/usr/bin/env bun
/**
 * Smoke test for the task kind system (mt#1812).
 *
 * Verifies that:
 *   1. The `kind` column exists in the tasks table and is readable.
 *   2. Creating a new task with kind="umbrella" persists correctly.
 *   3. Transitioning an umbrella task to COMPLETED succeeds.
 *   4. The workflow gate correctly rejects invalid umbrella transitions.
 *   5. Implementation-kind tasks (default) still follow the old state machine.
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

function printSummary(): void {
  const passed = results.filter((r) => r.passed).length;
  const failed = results.filter((r) => !r.passed).length;
  console.log(`\nSummary: ${passed} pass, ${failed} fail`);
  if (failed > 0) {
    console.error("SMOKE FAIL");
    process.exit(1);
  } else {
    console.log("SMOKE PASS");
    process.exit(0);
  }
}

console.log("smoke-task-kinds: starting");
console.log(`  Database: ${connectionString.replace(/:[^:@]+@/, ":<REDACTED>@")}`);
console.log("");

// Bootstrap persistence
const { PersistenceService } = await import("@minsky/domain/persistence/service");
const service = new PersistenceService();

try {
  await service.initialize({ backend: "postgres", postgres: { connectionString } });
} catch (err) {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(`FATAL: Cannot connect to database: ${msg}`);
  process.exit(1);
}

const provider = service.getProvider();
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = (provider as any).db as any;

if (!db) {
  console.error("FATAL: No Drizzle db instance available.");
  process.exit(1);
}

const { tasksTable, taskSpecsTable } = await import(
  "@minsky/domain/storage/schemas/task-embeddings"
);
const { validateStatusTransition } = await import("@minsky/domain/tasks/status-transitions");
const { WORKFLOWS, getWorkflow } = await import("@minsky/domain/tasks/workflows");

// ---------------------------------------------------------------------------
// Check 1: kind column exists and is readable
// ---------------------------------------------------------------------------

try {
  const rows = await db
    .select({ id: tasksTable.id, kind: tasksTable.kind })
    .from(tasksTable)
    .limit(1);
  pass("kind column readable from tasks table", `sample: ${JSON.stringify(rows[0] ?? "no rows")}`);
} catch (err) {
  fail("kind column readable from tasks table", err instanceof Error ? err.message : String(err));
  printSummary();
}

// ---------------------------------------------------------------------------
// Check 2: workflow registry exports implementation and umbrella
// ---------------------------------------------------------------------------

if ("implementation" in WORKFLOWS && "umbrella" in WORKFLOWS) {
  pass("workflow registry exports implementation and umbrella");
} else {
  fail("workflow registry exports implementation and umbrella", "Missing one or both kinds");
  printSummary();
}

// ---------------------------------------------------------------------------
// Check 3: getWorkflow() returns implementation as default
// ---------------------------------------------------------------------------

const implWorkflow = getWorkflow(null);
if (implWorkflow === WORKFLOWS["implementation"]) {
  pass("getWorkflow(null) returns implementation workflow");
} else {
  fail("getWorkflow(null) returns implementation workflow", "Got wrong workflow");
}

// ---------------------------------------------------------------------------
// Check 4: umbrella kind allows COMPLETED terminal state
// ---------------------------------------------------------------------------

try {
  validateStatusTransition("IN-PROGRESS", "COMPLETED", "umbrella");
  pass("umbrella IN-PROGRESS → COMPLETED is allowed");
} catch (err) {
  fail(
    "umbrella IN-PROGRESS → COMPLETED is allowed",
    err instanceof Error ? err.message : String(err)
  );
}

// ---------------------------------------------------------------------------
// Check 5: umbrella kind rejects DONE (implementation-only state)
// ---------------------------------------------------------------------------

try {
  validateStatusTransition("IN-PROGRESS", "DONE", "umbrella");
  fail("umbrella IN-PROGRESS → DONE is rejected", "Expected rejection but transition was allowed");
} catch (err) {
  pass("umbrella IN-PROGRESS → DONE is correctly rejected");
}

// ---------------------------------------------------------------------------
// Check 6: implementation kind still rejects COMPLETED (umbrella-only state)
// ---------------------------------------------------------------------------

try {
  validateStatusTransition("IN-PROGRESS", "COMPLETED", "implementation");
  fail(
    "implementation IN-PROGRESS → COMPLETED is rejected",
    "Expected rejection but transition was allowed"
  );
} catch (err) {
  pass("implementation IN-PROGRESS → COMPLETED is correctly rejected");
}

// ---------------------------------------------------------------------------
// Check 7: Create a test umbrella task in the DB and read back kind field
// ---------------------------------------------------------------------------

const testTaskId = `mt#smoke-kind-test-${Date.now()}`;

try {
  await db
    .insert(tasksTable)
    .values({
      id: testTaskId,
      sourceTaskId: `smoke-kind-test-${Date.now()}`,
      backend: "minsky" as const,
      status: "TODO",
      title: "Smoke test umbrella task (mt#1812)",
      tags: "[]",
      kind: "umbrella",
      createdAt: new Date(),
      updatedAt: new Date(),
    })
    .onConflictDoNothing();

  await db
    .insert(taskSpecsTable)
    .values({
      taskId: testTaskId,
      content: "Smoke test spec — will be deleted.",
      version: 1,
      createdAt: new Date(),
      updatedAt: new Date(),
    })
    .onConflictDoNothing();

  // Read back
  const rows = await db
    .select({ id: tasksTable.id, kind: tasksTable.kind, status: tasksTable.status })
    .from(tasksTable)
    .where(eq(tasksTable.id, testTaskId))
    .limit(1);

  if (rows.length === 0) {
    fail("umbrella task created and readable", "Row not found after insert");
  } else {
    const row = rows[0];
    if (row.kind === "umbrella") {
      pass("umbrella task created and readable", `kind=${row.kind}, status=${row.status}`);
    } else {
      fail("umbrella task created and readable", `Expected kind=umbrella but got kind=${row.kind}`);
    }
  }
} catch (err) {
  fail("umbrella task created and readable", err instanceof Error ? err.message : String(err));
} finally {
  // Cleanup: remove smoke test row
  try {
    await db.delete(taskSpecsTable).where(eq(taskSpecsTable.taskId, testTaskId));
    await db.delete(tasksTable).where(eq(tasksTable.id, testTaskId));
  } catch {
    // Non-fatal cleanup failure
  }
}

// ---------------------------------------------------------------------------
// Check 8: COMPLETED is in umbrella terminal states
// ---------------------------------------------------------------------------

const umbrellaWorkflow = WORKFLOWS["umbrella"];
if (umbrellaWorkflow.terminal.includes("COMPLETED")) {
  pass("umbrella workflow has COMPLETED in terminal states");
} else {
  fail(
    "umbrella workflow has COMPLETED in terminal states",
    `terminal: ${umbrellaWorkflow.terminal.join(", ")}`
  );
}

// ---------------------------------------------------------------------------
// Check 9: DONE is in implementation terminal states
// ---------------------------------------------------------------------------

const implWf = WORKFLOWS["implementation"];
if (implWf.terminal.includes("DONE")) {
  pass("implementation workflow has DONE in terminal states");
} else {
  fail(
    "implementation workflow has DONE in terminal states",
    `terminal: ${implWf.terminal.join(", ")}`
  );
}

// ---------------------------------------------------------------------------
// Print summary
// ---------------------------------------------------------------------------

printSummary();
