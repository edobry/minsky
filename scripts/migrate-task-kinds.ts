#!/usr/bin/env bun
/**
 * One-shot backfill: classify tasks as kind="umbrella" or kind="implementation".
 *
 * mt#1812: Multi-kind task workflows.
 *
 * ## Heuristic
 *
 * A task is classified as kind="umbrella" when ALL of:
 *   1. It has at least one child task in the task graph (relationships table).
 *   2. It has no associated pull request (session.prBranch or session.prState is null/empty).
 *
 * Everything else is classified as kind="implementation" (the default).
 *
 * The heuristic is conservative: it would rather leave a borderline task as
 * "implementation" than mis-classify a non-umbrella task.
 *
 * ## Usage
 *
 *   # Preview (default — safe, no changes made):
 *   bun scripts/migrate-task-kinds.ts
 *
 *   # Apply (requires --execute flag):
 *   bun scripts/migrate-task-kinds.ts --execute
 *
 *   # Preview with verbose output (show all tasks, not just changes):
 *   bun scripts/migrate-task-kinds.ts --verbose
 *
 * ## Required env vars
 *
 *   DATABASE_URL — Minsky Postgres connection string (or MINSKY_POSTGRES_URL)
 *
 * ## Outputs
 *
 * Exit code 0 — scan completed (even if zero tasks changed).
 * Exit code 1 — fatal error (cannot connect to DB).
 * Exit code 2 — skip (DATABASE_URL not set).
 *
 * Results JSON is written to scripts/results/migrate-task-kinds-results.json.
 *
 * ## Per CLAUDE.md §Operational Safety: Dry-Run First
 * Default is --dry-run (preview). --execute applies changes.
 */

import { join } from "path";
import { mkdir, writeFile } from "fs/promises";
import { eq, like } from "drizzle-orm";

// ---------------------------------------------------------------------------
// Parse CLI args
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
const dryRun = !args.includes("--execute");
const verbose = args.includes("--verbose");

if (dryRun) {
  console.log("DRY RUN — no changes will be made. Pass --execute to apply.");
} else {
  console.log("EXECUTE MODE — kind backfill will be applied to the database.");
}
console.log("");

// ---------------------------------------------------------------------------
// Check required env vars
// ---------------------------------------------------------------------------

const dbUrl = process.env["DATABASE_URL"] || process.env["MINSKY_POSTGRES_URL"];

if (!dbUrl) {
  console.log("SKIP: DATABASE_URL or MINSKY_POSTGRES_URL not set. Cannot run migration.");
  process.exit(2);
}

const connectionString: string = dbUrl;

// ---------------------------------------------------------------------------
// Bootstrap DB connection
// ---------------------------------------------------------------------------

console.log("Connecting to database...");

const { PersistenceService } = await import("../src/domain/persistence/service.ts");
const service = new PersistenceService();

try {
  await service.initialize({ backend: "postgres", postgres: { connectionString } });
} catch (err) {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(`FATAL: Cannot connect to database: ${msg}`);
  process.exit(1);
}

const provider = service.getProvider();

// Get raw Drizzle db from the provider
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = (provider as any).db as any;

if (!db) {
  console.error("FATAL: Provider does not expose a Drizzle db instance.");
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Load schemas
// ---------------------------------------------------------------------------

const { tasksTable } = await import("../src/domain/storage/schemas/task-embeddings.ts");
const { taskRelationshipsTable, PARENT_RELATIONSHIP_TYPE } = await import(
  "../src/domain/storage/schemas/task-relationships.ts"
);

// ---------------------------------------------------------------------------
// Fetch all minsky-backend tasks
// ---------------------------------------------------------------------------

console.log("Fetching all minsky-backend tasks...");

type TaskRow = {
  id: string;
  status: string | null;
  kind: string | null;
};

const allTasks: TaskRow[] = await db
  .select({ id: tasksTable.id, status: tasksTable.status, kind: tasksTable.kind })
  .from(tasksTable)
  .where(like(tasksTable.id, "mt#%"));

console.log(`Found ${allTasks.length} tasks with prefix 'mt#'.`);

// ---------------------------------------------------------------------------
// Fetch task relationships to find tasks with children
// ---------------------------------------------------------------------------

console.log("Fetching task relationships...");

type RelationshipRow = {
  fromTaskId: string;
  toTaskId: string;
  type: string;
};

let allRelationships: RelationshipRow[] = [];
try {
  allRelationships = await db
    .select({
      fromTaskId: taskRelationshipsTable.fromTaskId,
      toTaskId: taskRelationshipsTable.toTaskId,
      type: taskRelationshipsTable.type,
    })
    .from(taskRelationshipsTable);
} catch (err) {
  const msg = err instanceof Error ? err.message : String(err);
  console.warn(`Warning: Could not fetch task relationships (${msg}). Will skip parent detection.`);
}

// Build a set of task IDs that have at least one child.
// In the relationships table, "parent" type means fromTaskId is a CHILD of toTaskId.
// So tasks with children appear as toTaskId in parent-type relationships.
const tasksWithChildren = new Set<string>();
for (const rel of allRelationships) {
  if (rel.type === PARENT_RELATIONSHIP_TYPE && rel.toTaskId) {
    tasksWithChildren.add(rel.toTaskId);
  }
}
console.log(`Found ${tasksWithChildren.size} tasks with at least one child.`);

// ---------------------------------------------------------------------------
// Fetch sessions with PR info to find tasks with associated PRs
// ---------------------------------------------------------------------------

console.log("Fetching sessions for PR association check...");

const { postgresSessions } = await import("../src/domain/storage/schemas/session-schema.ts");

type SessionRow = {
  taskId: string | null;
  prBranch: string | null;
  prState: string | null;
};

let allSessions: SessionRow[] = [];
try {
  allSessions = await db
    .select({
      taskId: postgresSessions.taskId,
      prBranch: postgresSessions.prBranch,
      prState: postgresSessions.prState,
    })
    .from(postgresSessions);
} catch (err) {
  const msg = err instanceof Error ? err.message : String(err);
  console.warn(`Warning: Could not fetch sessions (${msg}). Will skip PR association check.`);
}

// Build a set of task IDs that have an associated PR
const tasksWithPr = new Set<string>();
for (const session of allSessions) {
  if (session.taskId && (session.prBranch || (session.prState && session.prState !== ""))) {
    tasksWithPr.add(session.taskId);
  }
}
console.log(`Found ${tasksWithPr.size} tasks with an associated PR.`);

// ---------------------------------------------------------------------------
// Classify each task
// ---------------------------------------------------------------------------

console.log("\nClassifying tasks...\n");

interface ClassificationResult {
  taskId: string;
  currentKind: string;
  proposedKind: string;
  reason: string;
  changed: boolean;
}

const results: ClassificationResult[] = [];
let changeCount = 0;

for (const task of allTasks) {
  const currentKind = task.kind || "implementation";
  let proposedKind = "implementation";
  let reason = "default: no special signals";

  const hasChildren = tasksWithChildren.has(task.id);
  const hasPr = tasksWithPr.has(task.id);

  if (hasChildren && !hasPr) {
    proposedKind = "umbrella";
    reason = "has child tasks and no associated PR";
  } else if (hasChildren && hasPr) {
    reason = "has child tasks but also has an associated PR — keeping as implementation";
  }

  const changed = proposedKind !== currentKind;
  if (changed) {
    changeCount++;
  }

  results.push({
    taskId: task.id,
    currentKind,
    proposedKind,
    reason,
    changed,
  });

  if (verbose || changed) {
    const marker = changed ? "[CHANGE]" : "[  OK  ]";
    console.log(`  ${marker} ${task.id}: ${currentKind} → ${proposedKind} (${reason})`);
  }
}

const changedResults = results.filter((r) => r.changed);
console.log(`\nSummary: ${changeCount} tasks would be reclassified.`);
console.log(
  `  Proposed kind="umbrella": ${changedResults.filter((r) => r.proposedKind === "umbrella").length}`
);
console.log(
  `  Proposed kind="implementation": ${changedResults.filter((r) => r.proposedKind === "implementation").length}`
);

// ---------------------------------------------------------------------------
// Apply changes (--execute mode only)
// ---------------------------------------------------------------------------

if (!dryRun && changeCount > 0) {
  console.log("\nApplying changes...");

  let applied = 0;
  let failed = 0;
  const failures: { taskId: string; error: string }[] = [];

  for (const result of changedResults) {
    try {
      await db
        .update(tasksTable)
        .set({ kind: result.proposedKind, updatedAt: new Date() })
        .where(eq(tasksTable.id, result.taskId));
      applied++;
      console.log(`  Applied: ${result.taskId} → ${result.proposedKind}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      failed++;
      failures.push({ taskId: result.taskId, error: msg });
      console.error(`  FAILED: ${result.taskId}: ${msg}`);
    }
  }

  console.log(`\nApplied: ${applied} / Failed: ${failed}`);
  if (failures.length > 0) {
    console.error("Failures:", failures);
  }
} else if (!dryRun && changeCount === 0) {
  console.log("\nNo changes to apply — all tasks already have the correct kind.");
}

// ---------------------------------------------------------------------------
// Write results JSON
// ---------------------------------------------------------------------------

const resultsDir = join(import.meta.dir, "results");
await mkdir(resultsDir, { recursive: true });

const outputPath = join(resultsDir, "migrate-task-kinds-results.json");
const output = {
  timestamp: new Date().toISOString(),
  mode: dryRun ? "dry-run" : "execute",
  totalTasks: allTasks.length,
  tasksWithChildren: tasksWithChildren.size,
  tasksWithPr: tasksWithPr.size,
  proposedChanges: changeCount,
  results,
};

await writeFile(outputPath, JSON.stringify(output, null, 2));
console.log(`\nResults written to: ${outputPath}`);

if (dryRun && changeCount > 0) {
  console.log("\nTo apply the changes, run:");
  console.log("  bun scripts/migrate-task-kinds.ts --execute");
}

process.exit(0);
