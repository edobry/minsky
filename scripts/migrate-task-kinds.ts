#!/usr/bin/env bun
/**
 * One-shot backfill: classify tasks as kind="umbrella" or kind="implementation".
 *
 * mt#1812: Multi-kind task workflows.
 * mt#2761: Made promote-only (see "Promote-only semantics" below).
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
 * ## Promote-only semantics (mt#2761)
 *
 * This script NEVER changes a task whose current kind is not "implementation".
 * Only "implementation" (the default kind) is eligible for promotion to
 * "umbrella". Tasks already classified as "state-ops" (mt#2661), a
 * hand-set "umbrella" on a leaf task (mt#1451 reclassification), or any
 * other kind are always left untouched, even when the hasChildren/hasPr
 * heuristic above would otherwise suggest a different kind for them. See
 * `scripts/migrate-task-kinds-classify.ts` for the classification logic and
 * `docs/task-kinds.md §Backfill heuristic` for the full writeup.
 *
 * Dry-run output distinguishes three dispositions per task:
 *   [PROMOTE] — currently "implementation", heuristic says "umbrella" — would apply
 *   [SKIPPED] — currently a non-default kind, heuristic disagrees — preserved, not applied
 *   [  OK  ]  — no change needed either way
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
 * Exit code 0 — scan completed cleanly (even if zero tasks were promoted).
 * Exit code 1 — fatal error: either cannot connect to DB, OR (in --execute
 *   mode) one or more promotions failed to apply — see `applyFailedCount`
 *   in the results JSON and the "Failures:" console output for detail.
 * Exit code 2 — skip (DATABASE_URL not set).
 *
 * Results JSON is written to scripts/results/migrate-task-kinds-results.json.
 *
 * ## Per CLAUDE.md §Operational Safety: Dry-Run First
 * Default is --dry-run (preview). --execute applies changes.
 */

// tsyringe (used transitively by PersistenceService below) requires the
// reflect-metadata polyfill. This import MUST stay first — before any other
// import in this file — because tsyringe's decorator metadata only works if
// the polyfill is installed before any decorated class is loaded. Do not
// reorder this below the other imports (mt#2761 fixed exactly this: the
// script previously had no reflect-metadata import at all and failed to
// boot with "tsyringe requires a reflect polyfill" unless invoked as
// `bun -r reflect-metadata scripts/migrate-task-kinds.ts`).
import "reflect-metadata";
import { join } from "path";
import { mkdir, writeFile } from "fs/promises";
import { eq, like } from "drizzle-orm";
import { classifyTaskKind, type ClassificationResult } from "./migrate-task-kinds-classify";

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

const { tasksTable } = await import("@minsky/domain/storage/schemas/task-embeddings");
const { taskRelationshipsTable, PARENT_RELATIONSHIP_TYPE } = await import(
  "@minsky/domain/storage/schemas/task-relationships"
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

const { postgresSessions } = await import("@minsky/domain/storage/schemas/session-schema");

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

console.log("\nClassifying tasks (promote-only, mt#2761)...\n");

const results: ClassificationResult[] = [];

for (const task of allTasks) {
  const hasChildren = tasksWithChildren.has(task.id);
  const hasPr = tasksWithPr.has(task.id);

  const result = classifyTaskKind({
    taskId: task.id,
    currentKind: task.kind,
    hasChildren,
    hasPr,
  });

  results.push(result);

  if (verbose || result.action !== "no-change") {
    const marker =
      result.action === "promote"
        ? "[PROMOTE]"
        : result.action === "skip-non-default-kind"
          ? "[SKIPPED]"
          : "[  OK  ]";
    console.log(
      `  ${marker} ${task.id}: ${result.currentKind} → ${result.proposedKind} (${result.reason})`
    );
  }
}

const promotions = results.filter((r) => r.action === "promote");
const skipped = results.filter((r) => r.action === "skip-non-default-kind");

console.log(
  `\nSummary: ${promotions.length} task(s) would be promoted; ` +
    `${skipped.length} task(s) skipped (non-default kind, preserving manual classification).`
);
console.log(`  Would promote to kind="umbrella": ${promotions.length}`);
if (skipped.length > 0) {
  console.log(`  Skipped — non-default kind, preserving manual classification:`);
  for (const r of skipped) {
    console.log(
      `    ${r.taskId}: kind="${r.currentKind}" (heuristic alone would suggest "${r.heuristicKind}", not applied)`
    );
  }
}

// ---------------------------------------------------------------------------
// Apply changes (--execute mode only)
// ---------------------------------------------------------------------------

// Tracked outside the branch below so the final exit code (see bottom of file)
// reflects partial-apply failures even though they're only possible in
// --execute mode.
let applyFailedCount = 0;

if (!dryRun && promotions.length > 0) {
  console.log("\nApplying promotions (promote-only, mt#2761)...");

  let applied = 0;
  const failures: { taskId: string; error: string }[] = [];

  for (const result of promotions) {
    try {
      await db
        .update(tasksTable)
        .set({ kind: result.proposedKind, updatedAt: new Date() })
        .where(eq(tasksTable.id, result.taskId));
      applied++;
      console.log(`  Applied: ${result.taskId} → ${result.proposedKind}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      applyFailedCount++;
      failures.push({ taskId: result.taskId, error: msg });
      console.error(`  FAILED: ${result.taskId}: ${msg}`);
    }
  }

  console.log(`\nApplied: ${applied} / Failed: ${applyFailedCount}`);
  if (failures.length > 0) {
    console.error("Failures:", failures);
  }
} else if (!dryRun && promotions.length === 0) {
  console.log("\nNo promotions to apply — all eligible tasks already have the correct kind.");
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
  promotedCount: promotions.length,
  skippedNonDefaultKindCount: skipped.length,
  applyFailedCount,
  results,
};

await writeFile(outputPath, JSON.stringify(output, null, 2));
console.log(`\nResults written to: ${outputPath}`);

if (dryRun && promotions.length > 0) {
  console.log("\nTo apply the promotions, run:");
  console.log("  bun scripts/migrate-task-kinds.ts --execute");
}

// Exit non-zero when --execute left one or more promotions unapplied, so a
// caller (script, CI step, or human) can tell a partial-apply failure apart
// from a clean run just by checking the exit code — the console output alone
// is easy to miss when this is invoked non-interactively.
if (applyFailedCount > 0) {
  console.error(`\nFATAL: ${applyFailedCount} promotion(s) failed to apply. See Failures above.`);
  process.exit(1);
}

process.exit(0);
