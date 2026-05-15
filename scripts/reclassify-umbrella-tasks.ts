#!/usr/bin/env bun
/**
 * Phase 6 helper: reclassify specific tasks as kind="umbrella" (mt#1812).
 *
 * Uses postgres directly to avoid DI/reflect-metadata bootstrap.
 *
 * Usage:
 *   bun scripts/reclassify-umbrella-tasks.ts            # dry run (default)
 *   bun scripts/reclassify-umbrella-tasks.ts --execute  # apply
 */
import postgres from "postgres";

const UMBRELLA_TASK_IDS = ["mt#1768", "mt#1451", "mt#1533", "mt#1534", "mt#1535", "mt#1143"];

const dbUrl = process.env["DATABASE_URL"] || process.env["MINSKY_POSTGRES_URL"];

if (!dbUrl) {
  console.error("SKIP: DATABASE_URL or MINSKY_POSTGRES_URL not set.");
  process.exit(2);
}

const dryRun = !process.argv.includes("--execute");
if (dryRun) {
  console.log("DRY RUN — pass --execute to apply.");
} else {
  console.log("EXECUTE MODE — kind update will be applied.");
}
console.log("");

const sql = postgres(dbUrl, { max: 1 });

try {
  // Fetch each task individually to avoid array parameterization issues
  const found = new Map<string, { id: string; kind: string | null; status: string | null }>();
  for (const taskId of UMBRELLA_TASK_IDS) {
    const rows = await sql<{ id: string; kind: string | null; status: string | null }[]>`
      SELECT id, kind, status FROM tasks WHERE id = ${taskId} LIMIT 1
    `;
    if (rows.length > 0) found.set(taskId, rows[0]);
  }

  for (const taskId of UMBRELLA_TASK_IDS) {
    const row = found.get(taskId);
    if (!row) {
      console.log(`  SKIP: ${taskId} not found in DB`);
      continue;
    }
    const currentKind = row.kind ?? "implementation";
    if (currentKind === "umbrella") {
      console.log(`  OK: ${taskId} already kind=umbrella (status=${row.status})`);
      continue;
    }
    console.log(
      `  ${dryRun ? "[DRY RUN] would set" : "SETTING"}: ${taskId} kind=${currentKind} → umbrella (status=${row.status})`
    );
  }

  if (!dryRun) {
    for (const taskId of UMBRELLA_TASK_IDS) {
      await sql`
        UPDATE tasks SET kind = 'umbrella', updated_at = NOW() WHERE id = ${taskId}
      `;
    }

    // Verify
    console.log("\nVerification after update:");
    for (const taskId of UMBRELLA_TASK_IDS) {
      const rows = await sql<{ id: string; kind: string | null; status: string | null }[]>`
        SELECT id, kind, status FROM tasks WHERE id = ${taskId} LIMIT 1
      `;
      if (rows.length > 0) {
        console.log(`  ${rows[0].id}: kind=${rows[0].kind} status=${rows[0].status}`);
      } else {
        console.log(`  ${taskId}: NOT FOUND`);
      }
    }
  }
} finally {
  await sql.end();
}

console.log("\nDone.");
process.exit(0);
